import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OrderRejectedError } from '../src/execution/broker.ts';
import { createGeoGuard, parseGeoblock } from '../src/live/geoblock.ts';
import { createLiveBroker, parseOrderResponse, type ClobLike } from '../src/live/liveBroker.ts';
import { openLiveStore } from '../src/live/liveStore.ts';

const WS = 1_790_000_100;
const NOW = WS * 1000 + 60_000;

interface Call {
  order: { tokenID: string; amount: number; side: string; price?: number };
  type?: string;
}

function fakeClob(responses: unknown[], calls: Call[] = [], signed: Call[] = []): ClobLike {
  return {
    async createAndPostMarketOrder(order, _opts, type) {
      calls.push({ order, type });
      return responses.shift();
    },
    async createMarketOrder(order) {
      signed.push({ order });
      return { signed: true };
    },
    async getBalanceAllowance() {
      return { balance: '123450000' };
    },
  };
}

const allowed = { ensure: async () => ({ allowed: true, checkedAtMs: 0, country: 'XX', region: null, reason: null }), status: () => ({ allowed: true, checkedAtMs: 0, country: 'XX', region: null, reason: null }) };
const risk = { maxStakeUsd: 5, maxOpenCostUsd: 20, maxDailyLossUsd: 10 };
const COND = `0x${'c'.repeat(64)}`;
const tokens = () => ({ upTokenId: 'tok-up', downTokenId: 'tok-down', conditionId: COND, negRisk: false });

function broker(clob: ClobLike, overrides: Partial<Parameters<typeof createLiveBroker>[0]> = {}) {
  const store = openLiveStore(':memory:');
  const b = createLiveBroker({ clob, store, geo: allowed, tokens, risk, dryRun: false, now: () => NOW, ...overrides });
  return { b, store };
}

describe('实盘通道', () => {
  it('FAK 市价买：限价、金额被单笔上限截断，按回包记账', async () => {
    const calls: Call[] = [];
    const { b, store } = broker(
      fakeClob([{ success: true, errorMsg: '', orderID: 'o1', status: 'matched', makingAmount: '5', takingAmount: '9.0909' }], calls),
    );
    const fill = await b.buy({ windowStart: WS, side: 'UP', stake: 50, maxPrice: 0.55 });
    assert.deepEqual(calls[0], { order: { tokenID: 'tok-up', amount: 5, side: 'BUY', price: 0.55 }, type: 'FAK' });
    assert.equal(fill.contracts, 9.0909);
    assert.equal(fill.amount, 5);
    const pos = await b.position(WS);
    assert.equal(pos!.side, 'UP');
    assert.equal(store.recentOrders(5)[0]!.orderId, 'o1');
    // 领奖要用的 conditionId 在建仓时就记下
    assert.equal(store.position(Number(pos!.id))!.conditionId, COND);
    assert.equal(await b.balance(), 123.45);
  });

  it('未成交：记一笔失败单并抛 MISSED，不建仓', async () => {
    const { b, store } = broker(fakeClob([{ success: false, errorMsg: 'no match', status: 'unmatched' }]));
    await assert.rejects(b.buy({ windowStart: WS, side: 'DOWN', stake: 5, maxPrice: 0.4 }), (e: unknown) => e instanceof OrderRejectedError && e.code === 'MISSED');
    assert.equal(await b.position(WS), null);
    assert.equal(store.recentOrders(5)[0]!.error, 'no match');
  });

  it('地域受限：一律拒单（fail closed），不调用 CLOB', async () => {
    const calls: Call[] = [];
    const geo = createGeoGuard({ fetchJson: async () => ({ blocked: true, country: 'US' }), now: () => NOW });
    const { b } = broker(fakeClob([], calls), { geo });
    await assert.rejects(b.buy({ windowStart: WS, side: 'UP', stake: 5, maxPrice: 0.5 }), (e: unknown) => e instanceof OrderRejectedError && e.code === 'GEO_BLOCKED');
    assert.equal(calls.length, 0);
    const down = createGeoGuard({ fetchJson: async () => { throw new Error('timeout'); }, now: () => NOW });
    assert.equal((await down.ensure()).allowed, false);
  });

  it('风控：未了结成本上限、日内亏损上限', async () => {
    const ok = { success: true, orderID: 'x', status: 'matched', makingAmount: '5', takingAmount: '10' };
    const { b, store } = broker(fakeClob([ok, ok, ok, ok, ok]));
    for (let i = 0; i < 4; i++) await b.buy({ windowStart: WS + i * 300, side: 'UP', stake: 5, maxPrice: 0.5 });
    await assert.rejects(b.buy({ windowStart: WS + 1500, side: 'UP', stake: 5, maxPrice: 0.5 }), /未了结仓位成本/);
    // 两个窗口输掉 → 当日 −10，达到上限
    b.resolveWindow(WS, 'DOWN');
    b.resolveWindow(WS + 300, 'DOWN');
    assert.equal(store.realizedSince(0, false), -10);
    await assert.rejects(b.buy({ windowStart: WS + 1800, side: 'UP', stake: 5, maxPrice: 0.5 }), /日内已亏/);
  });

  it('卖出：部分成交留仓，全部成交平仓；结算记输赢与盈亏', async () => {
    const { b } = broker(
      fakeClob([
        { success: true, orderID: 'b', status: 'matched', makingAmount: '5', takingAmount: '10' },
        { success: true, orderID: 's1', status: 'matched', makingAmount: '4', takingAmount: '2.4' },
      ]),
    );
    const fill = await b.buy({ windowStart: WS, side: 'UP', stake: 5, maxPrice: 0.5 });
    const pos = (await b.position(WS))!;
    const sold = await b.sell({ position: pos, minPrice: 0.6 });
    assert.equal(sold.contracts, 4);
    const left = (await b.position(WS))!;
    assert.equal(left.contracts, 6);
    b.resolveWindow(WS, 'UP');
    // 所得 2.4 + 派彩 6 − 成本 5
    assert.ok(Math.abs((await b.realizedPnl(fill.id))! - 3.4) < 1e-9);
  });

  it('dry-run：只签名不提交，账本标记 dry_run', async () => {
    const calls: Call[] = [];
    const signed: Call[] = [];
    const { b, store } = broker(fakeClob([], calls, signed), { dryRun: true, dryRunBalance: 100 });
    const fill = await b.buy({ windowStart: WS, side: 'DOWN', stake: 5, maxPrice: 0.5 });
    assert.equal(fill.dryRun, true);
    assert.equal(calls.length, 0);
    assert.equal(signed.length, 1);
    assert.equal(store.recentOrders(1)[0]!.status, 'DRY_RUN');
    assert.equal(await b.balance(), 95);
  });

  it('回包与 geoblock 解析', () => {
    assert.deepEqual(parseOrderResponse({ success: true, orderID: 'a', makingAmount: '1.5', takingAmount: '3' }), {
      ok: true, orderId: 'a', status: 'matched', making: 1.5, taking: 3, error: null,
    });
    assert.equal(parseOrderResponse({ error: 'bad' }).ok, false);
    assert.equal(parseGeoblock({ blocked: false, country: 'DE' }, 1).allowed, true);
    assert.equal(parseGeoblock({ country: 'DE' }, 1).allowed, false);
  });
});
