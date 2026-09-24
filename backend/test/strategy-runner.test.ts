import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createPaperBroker, DEFAULT_BOT_USER_ID } from '../src/execution/paperBroker.ts';
import { createDecisionRepo } from '../src/strategy/decisionRepo.ts';
import type { Judge, Judgment } from '../src/strategy/judges/types.ts';
import type { Kline, Tick } from '../src/strategy/model.ts';
import type { Book } from '../src/strategy/rules.ts';
import { checkpointFor, createStrategyRunner, DEFAULT_RUNNER_CONFIG, type StrategyMarketData } from '../src/strategy/runner.ts';
import { BASE_NOW, makeHarness, type Harness } from './helpers.ts';

const WS = BASE_NOW / 1000;
const NOW = BASE_NOW + 120_000;

function klines(): Kline[] {
  return Array.from({ length: 61 }, (_, i) => ({ openTimeMs: i * 60_000, close: 60_000 + (i % 2 === 0 ? 10 : -10) }));
}

function ticks(lead: number): Tick[] {
  return Array.from({ length: 121 }, (_, i) => ({ timeMs: BASE_NOW + i * 1000, price: 60_000 + (lead * i) / 120 }));
}

interface FakeMarket extends StrategyMarketData {
  setBook(b: Partial<Book>, ts?: number): void;
  healthyFlag: boolean;
  outcomes: Map<number, 'UP' | 'DOWN' | 'VOID'>;
}

function fakeMarket(h: Harness, lead = 30): FakeMarket {
  const m: FakeMarket = {
    healthyFlag: true,
    outcomes: new Map(),
    openPrice: () => 60_000,
    ticksSince: (from) => ticks(lead).filter((t) => t.timeMs >= from),
    klines: async () => klines(),
    flow: async () => null,
    liquidationsSince: () => null,
    book() {
      const b = h.quotes.get();
      return b ? { book: { upAsk: b.up.ask, upBid: b.up.bid, downAsk: b.down.ask, downBid: b.down.bid }, ts: b.ts } : null;
    },
    healthy: () => m.healthyFlag,
    outcome: (ws) => m.outcomes.get(ws) ?? null,
    setBook(b, ts = h.clock.now()) {
      const cur = h.quotes.get()!;
      h.quotes.set({ upAsk: cur.up.ask, upBid: cur.up.bid, downAsk: cur.down.ask, downBid: cur.down.bid, ...b, ts });
    },
  };
  return m;
}

function scriptedJudge(choice: 'BUY_UP' | 'BUY_DOWN' | 'PASS' | 'HOLD' | 'SELL', p = 0.8): Judge & { calls: number } {
  const j = {
    name: 'jev' as const,
    calls: 0,
    async judge(): Promise<Judgment> {
      j.calls++;
      return { judge: 'jev', model: 'fake', decision: { choice, probabilities: { [choice]: p } }, pUp: 0.6, latencyMs: 1, inputTokens: 10 };
    },
  };
  return j;
}

function setup(options: { judge: Judge; lead?: number; book?: Partial<Book>; onSleep?: (m: FakeMarket) => void }) {
  const h = makeHarness({ nowMs: NOW, book: { upBid: 0.55, upAsk: 0.56, downBid: 0.43, downAsk: 0.44, ...options.book } });
  const market = fakeMarket(h, options.lead);
  const decisions = createDecisionRepo(h.db);
  const broker = createPaperBroker({ service: h.service, quotes: h.quotes });
  const runner = createStrategyRunner({
    judge: options.judge,
    broker,
    decisions,
    market,
    now: () => h.clock.now(),
    sleep: async () => options.onSleep?.(market),
    enabled: true,
  });
  return { h, market, decisions, broker, runner };
}

describe('检查点划分', () => {
  it('落在 [s_i, s_{i+1}) 归 T{s_i}，285 秒后不开', () => {
    assert.equal(checkpointFor(10, DEFAULT_RUNNER_CONFIG), null);
    assert.equal(checkpointFor(30, DEFAULT_RUNNER_CONFIG), 'T30');
    assert.equal(checkpointFor(44, DEFAULT_RUNNER_CONFIG), 'T30');
    assert.equal(checkpointFor(284, DEFAULT_RUNNER_CONFIG), 'T270');
    assert.equal(checkpointFor(285, DEFAULT_RUNNER_CONFIG), null);
  });
});

describe('策略回路 × 模拟盘', () => {
  it('判官买 UP → 机器人账户下注，决策落库；同一检查点不重跑', async () => {
    const { h, decisions, runner, broker } = setup({ judge: scriptedJudge('BUY_UP') });
    const d = await runner.runCheckpoint(WS, 'T120');
    assert.equal(d!.action, 'BUY_UP');
    assert.equal(d!.pJudge, 0.6);
    assert.ok(d!.pModel! > 0.5);
    const pos = await broker.position(WS);
    assert.equal(pos!.side, 'UP');
    assert.equal(pos!.cost, d!.stake);
    assert.ok(h.accounts.gameBalanceOf(DEFAULT_BOT_USER_ID) < 100_000);
    assert.equal(await runner.runCheckpoint(WS, 'T120'), null);
    assert.equal(decisions.recent('paper', 10).length, 1);
    h.close();
  });

  it('等成交期间卖价变差 → MISSED，不下单', async () => {
    const { h, runner, broker } = setup({ judge: scriptedJudge('BUY_UP'), onSleep: (m) => m.setBook({ upAsk: 0.6 }) });
    const d = await runner.runCheckpoint(WS, 'T120');
    assert.equal(d!.action, 'STAY_OUT');
    assert.match(d!.reason!, /^MISSED UP ask 0.56→0.6/);
    assert.equal(await broker.position(WS), null);
    h.close();
  });

  it('持仓时问离场，判官卖就卖掉', async () => {
    const { h, runner, broker } = setup({ judge: scriptedJudge('SELL', 0.9) });
    await broker.buy({ windowStart: WS, side: 'UP', stake: 10, maxPrice: 0.99 });
    const d = await runner.runCheckpoint(WS, 'T135');
    assert.equal(d!.action, 'SELL');
    assert.equal(await broker.position(WS), null);
    h.close();
  });

  it('行情降级 / 盘口太旧 / 判官出错：不交易，照样落一行', async () => {
    const judge = scriptedJudge('BUY_UP');
    const a = setup({ judge });
    a.market.healthyFlag = false;
    assert.equal((await a.runner.runCheckpoint(WS, 'T120'))!.reason, 'FEED_DEGRADED');
    a.h.close();

    const b = setup({ judge });
    b.market.setBook({}, NOW - 60_000);
    assert.match((await b.runner.runCheckpoint(WS, 'T120'))!.reason!, /^STALE_BOOK/);
    b.h.close();
    assert.equal(judge.calls, 0);

    const c = setup({
      judge: { name: 'claude', judge: async () => { throw new Error('boom'); } },
    });
    const d = await c.runner.runCheckpoint(WS, 'T120');
    assert.equal(d!.action, 'ERROR');
    assert.equal(d!.error, 'boom');
    assert.equal(c.runner.status().lastError, 'boom');
    c.h.close();
  });

  it('回填：回合定盘后补结果与盈亏', async () => {
    const { h, runner, decisions, market } = setup({ judge: scriptedJudge('BUY_UP') });
    await runner.runCheckpoint(WS, 'T120');
    // 走到下一窗口并定盘（UP 赢）
    h.clock.set(BASE_NOW + 300_000 + 90_000);
    h.service.lockRound(WS);
    h.service.settleRound(WS, { startPrice: 60_000, endPrice: 60_100 });
    market.outcomes.set(WS, 'UP');
    await runner.settleSweep();
    const row = decisions.recent('paper', 1)[0]!;
    assert.equal(row.outcome, 'UP');
    assert.ok(row.pnl! > 0);
    assert.equal(decisions.summary('paper').wins, 1);
    h.close();
  });
});
