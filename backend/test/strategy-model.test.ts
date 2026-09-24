import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { modelZ, normCdf, recentSigma1mPct, sigma1mPct, twap, type Kline } from '../src/strategy/model.ts';
import { edge, entry, exit, impliedUp, sellOver, stake, type Book } from '../src/strategy/rules.ts';
import { buildState, StateUnavailableError, clockPhrase, leadPhrase, standingPhrase, type MarketContext } from '../src/strategy/state.ts';

const WS = Date.UTC(2026, 8, 23, 7, 5, 0) / 1000;

function bars(n = 61, start = 60_000, step = 10): Kline[] {
  // 来回摆动，保证中位数绝对收益 > 0
  return Array.from({ length: n }, (_, i) => ({ openTimeMs: i * 60_000, close: start + (i % 2 === 0 ? step : -step) }));
}

const BOOK: Book = { upAsk: 0.6, upBid: 0.58, downAsk: 0.42, downBid: 0.4 };

function ctx(overrides: Partial<MarketContext> = {}): MarketContext {
  const t0 = WS * 1000;
  const now = t0 + 120_000;
  const ticks = Array.from({ length: 121 }, (_, i) => ({ timeMs: t0 + i * 1000, price: 60_000 + i * 0.5 }));
  return {
    windowStart: WS,
    nowMs: now,
    openPrice: 60_000,
    ticks,
    klines: bars(),
    flow: { tradeCount: 50, tradeDelta: 0.4, largeTradeBias: 0.5, totalUsdt: 1e6, move10: 5, move30: 12, lastTradeMs: now },
    liquidations: [{ timeMs: t0 + 1000, side: 'BUY', usdt: 10_000 }],
    book: BOOK,
    upMids: [
      { timeMs: t0 + 60_000, price: 0.5 },
      { timeMs: now, price: 0.59 },
    ],
    position: null,
    ...overrides,
  };
}

describe('公平概率模型', () => {
  it('normCdf 关键点', () => {
    assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
    assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-4);
    assert.ok(Math.abs(normCdf(-1.96) - 0.025) < 1e-4);
  });

  it('z 对称：领先为正、落后为负，剩余时间越短越确定', () => {
    assert.equal(modelZ(0, null, 0.05, 200), 0);
    const far = modelZ(0.02, null, 0.05, 200);
    const near = modelZ(0.02, null, 0.05, 70);
    assert.ok(far > 0 && near > far);
    assert.equal(modelZ(-0.02, null, 0.05, 200), -far);
  });

  it('末分钟：已锁定部分决定大半', () => {
    // 锁定部分已领先、现价回到开盘：仍偏 UP
    assert.ok(modelZ(0, 0.05, 0.05, 20) > 0);
  });

  it('σ 用中位数，不被单根大 K 线拉高', () => {
    const b = bars();
    const base = sigma1mPct(b);
    b[30] = { openTimeMs: 30 * 60_000, close: 65_000 };
    assert.ok(sigma1mPct(b) < base * 1.5);
  });

  it('近 3 分钟实际波动：点不够回 0', () => {
    assert.equal(recentSigma1mPct([{ timeMs: 0, price: 1 }], 20_000), 0);
  });

  it('TWAP 按时间加权', () => {
    const pts = [
      { timeMs: 0, price: 100 },
      { timeMs: 3000, price: 200 },
    ];
    // [0,4000]：100 生效 3 秒、200 生效 1 秒
    assert.equal(twap(pts, 0, 4000), 125);
    assert.equal(twap([], 0, 1), null);
  });
});

describe('执行规则', () => {
  const cfg = { baseStake: 5, actThreshold: 0.5 };

  it('买：把握够、有卖价、付得起', () => {
    const e = entry({ choice: 'BUY_UP', probabilities: { BUY_UP: 0.7, BUY_DOWN: 0.1, PASS: 0.2 } }, BOOK, 100, cfg);
    assert.equal(e.action, 'BUY_UP');
    assert.equal(e.stake, 5);
  });

  it('把握不够 / 没卖价 / 没钱', () => {
    assert.match(entry({ choice: 'BUY_UP', probabilities: { BUY_UP: 0.4 } }, BOOK, 100, cfg).reason, /^UNSURE/);
    assert.match(entry({ choice: 'BUY_UP', probabilities: { BUY_UP: 0.9 } }, { ...BOOK, upAsk: null }, 100, cfg).reason, /^NO_QUOTE/);
    assert.equal(entry({ choice: 'BUY_DOWN', probabilities: { BUY_DOWN: 0.9 } }, BOOK, 0.5, cfg).reason, 'NO_BALANCE');
    assert.equal(entry({ choice: 'PASS', probabilities: { PASS: 0.9 } }, BOOK, 100, cfg).action, 'STAY_OUT');
  });

  it('卖：卖的概率要高过拿着且到阈值', () => {
    assert.equal(exit({ choice: 'SELL', probabilities: { SELL: 0.6, HOLD: 0.4 } }, 'UP', BOOK, cfg).action, 'SELL');
    assert.equal(exit({ choice: 'SELL', probabilities: { SELL: 0.45, HOLD: 0.55 } }, 'UP', BOOK, cfg).action, 'HOLD');
    assert.equal(exit({ choice: 'HOLD', probabilities: { HOLD: 0.9 } }, 'UP', BOOK, cfg).action, 'HOLD');
  });

  it('edge / sellOver 扣吃单费', () => {
    assert.ok(Math.abs(edge(0.7, 0.6) - (0.1 - 0.07 * 0.6 * 0.4)) < 1e-12);
    assert.ok(Math.abs(sellOver(0.5, 0.6) - (0.1 - 0.07 * 0.6 * 0.4)) < 1e-12);
  });

  it('stake 留足手续费，截到分', () => {
    assert.equal(stake(5, 100, 0.5), 5);
    const s = stake(100, 10, 0.5)!;
    assert.ok(s * (1 + 0.07 * 0.5) <= 10);
    assert.equal(stake(5, 0.9, 0.5), null);
  });

  it('隐含上涨概率：双边 mid 归一', () => {
    assert.ok(Math.abs(impliedUp(BOOK)! - 0.59 / (0.59 + 0.41)) < 1e-12);
    assert.equal(impliedUp({ upAsk: null, upBid: null, downAsk: 0.5, downBid: 0.4 }), null);
  });
});

describe('state：判官看到的盘面', () => {
  it('各段齐全、数学估计偏 UP', () => {
    const snap = buildState(ctx());
    const s = snap.state as Record<string, Record<string, string> | string>;
    assert.ok(snap.raw.pModel > 0.5);
    assert.match(s.clock as string, /seconds until the settlement average is fixed/);
    const btc = s.btc as Record<string, string>;
    assert.match(btc.vs_open!, /above the opening average/);
    assert.match(btc.latest!, /on Binance BTC moved \+\$5/);
    const flow = s.binance_flow as Record<string, string>;
    assert.match(flow.takers!, /buyers ahead/);
    assert.equal(flow.liquidations, 'shorts liquidated since the open');
    const odds = s.odds as Record<string, string>;
    assert.match(odds.odds_move!, /UP's price rose sharply/);
    assert.ok('estimate' in s);
    assert.ok(!('position' in s));
  });

  it('持仓时带 position', () => {
    const snap = buildState(ctx({ position: { side: 'UP', contracts: 10, avgPrice: 0.55 } }));
    const pos = snap.state.position as Record<string, string>;
    assert.match(pos.held!, /holding 10.0 UP shares bought at an average of 55¢/);
    assert.match(pos.sell_now!, /the bid is 58¢/);
  });

  it('看不全就不问：缺开盘价 / 本回合无 tick', () => {
    assert.throws(() => buildState(ctx({ openPrice: null })), StateUnavailableError);
    assert.throws(() => buildState(ctx({ ticks: [{ timeMs: WS * 1000 - 5000, price: 1 }] })), StateUnavailableError);
  });

  it('没开强平流 / 逐笔不新鲜时对应字段不出现', () => {
    const snap = buildState(ctx({ flow: null, liquidations: null }));
    assert.deepEqual(snap.state.binance_flow, {});
  });

  it('措辞分桶', () => {
    assert.match(clockPhrase(200), /^early/);
    assert.match(clockPhrase(100), /^middle/);
    assert.match(clockPhrase(10), /most of the settlement average/);
    assert.match(leadPhrase(0.2), /neither side/);
    assert.match(leadPhrase(-2), /DOWN ahead by a couple/);
    assert.match(standingPhrase(0.95), /UP is a near-certain favourite/);
    assert.equal(standingPhrase(null), 'no quotes on one side right now');
  });
});
