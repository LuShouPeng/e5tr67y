import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_GAME_BALANCE } from '../src/infra/repos/accountRepo.ts';
import { VOID_AFTER_SECONDS } from '../src/domain/types.ts';
import { windowStartFor } from '../src/domain/window.ts';
import { BASE_NOW, makeHarness, type Harness } from './helpers.ts';

const WS = windowStartFor(BASE_NOW);

/** 造一个「已封盘、有待结算注单」的回合：user1 买 UP 100，user2 买 DOWN 50 */
function staged(book = { upAsk: 0.5, upBid: 0.5, downAsk: 0.5, downBid: 0.5 }) {
  const h = makeHarness({ book, startPrice: 60_000 });
  const upBet = h.service.buy(1, 'UP', 100);
  const downBet = h.service.buy(2, 'DOWN', 50);
  h.service.lockRound(WS);
  return { h, upBet, downBet };
}

function lockAndSettle(
  h: Harness,
  prices: { startPrice?: number | null; endPrice?: number | null },
) {
  return h.service.settleRound(WS, prices);
}

describe('定盘派彩', () => {
  it('判 UP：看涨方每份兑付 $1，看跌方归零', () => {
    const { h } = staged();
    try {
      const result = lockAndSettle(h, { startPrice: 60_000, endPrice: 60_010 });
      assert.equal(result.status, 'SETTLED');
      if (result.status !== 'SETTLED') return;
      assert.equal(result.outcome, 'UP');
      assert.equal(result.winners, 1);
      assert.equal(result.paidOut, 200, '200 份 → 200 USDT');
      assert.equal(result.round.status, 'SETTLED');
      assert.equal(result.round.endPrice, 60_010);
      assert.equal(result.round.outcome, 'UP');

      // user1：买入扣 103.5，派彩 +200
      assert.equal(h.accounts.gameBalanceOf(1), DEFAULT_GAME_BALANCE - 103.5 + 200);
      // user2：买入扣 51.75，归零无回款
      assert.equal(h.accounts.gameBalanceOf(2), DEFAULT_GAME_BALANCE - 51.75);
    } finally {
      h.close();
    }
  });

  it('判 DOWN：看跌方拿钱', () => {
    const { h } = staged();
    try {
      const result = lockAndSettle(h, { startPrice: 60_000, endPrice: 59_990 });
      assert.equal(result.status, 'SETTLED');
      if (result.status !== 'SETTLED') return;
      assert.equal(result.outcome, 'DOWN');
      assert.equal(result.paidOut, 100, 'user2 持 100 份');
      assert.equal(h.accounts.gameBalanceOf(2), DEFAULT_GAME_BALANCE - 51.75 + 100);
      assert.equal(h.accounts.gameBalanceOf(1), DEFAULT_GAME_BALANCE - 103.5);
    } finally {
      h.close();
    }
  });

  it('相等判 UP：看涨方拿钱，与官方一致', () => {
    const { h } = staged();
    try {
      const result = lockAndSettle(h, { startPrice: 60_000, endPrice: 60_000 });
      assert.equal(result.status, 'SETTLED');
      if (result.status !== 'SETTLED') return;
      assert.equal(result.outcome, 'UP');
      assert.equal(result.paidOut, 200);
    } finally {
      h.close();
    }
  });

  it('注单状态落成 WON / LOST，payout 分别为份数与 0', () => {
    const { h, upBet, downBet } = staged();
    try {
      lockAndSettle(h, { startPrice: 60_000, endPrice: 60_010 });
      const won = h.bets.findById(upBet.id);
      const lost = h.bets.findById(downBet.id);
      assert.equal(won?.status, 'WON');
      assert.equal(won?.payout, 200);
      assert.equal(lost?.status, 'LOST');
      assert.equal(lost?.payout, 0);
    } finally {
      h.close();
    }
  });

  it('缺省目标价时取回合上存的那一份', () => {
    const { h } = staged();
    try {
      const result = h.service.settleRound(WS, { endPrice: 60_010 });
      assert.equal(result.status, 'SETTLED');
      if (result.status !== 'SETTLED') return;
      assert.equal(result.outcome, 'UP');
    } finally {
      h.close();
    }
  });

  it('回合上没有目标价时，用传入的目标价回填', () => {
    const h = makeHarness({ book: { upAsk: 0.5 }, startPrice: null });
    try {
      h.service.buy(1, 'UP', 10);
      h.service.lockRound(WS);
      const result = h.service.settleRound(WS, { startPrice: 61_000, endPrice: 61_100 });
      assert.equal(result.status, 'SETTLED');
      if (result.status !== 'SETTLED') return;
      assert.equal(result.round.startPrice, 61_000, '目标价被回填到回合上');
    } finally {
      h.close();
    }
  });
});

describe('结算幂等与前置条件', () => {
  it('重复结算不二次派彩', () => {
    const { h } = staged();
    try {
      lockAndSettle(h, { startPrice: 60_000, endPrice: 60_010 });
      const balance = h.accounts.gameBalanceOf(1);
      const again = lockAndSettle(h, { startPrice: 60_000, endPrice: 60_010 });
      assert.deepEqual(again, { status: 'SKIPPED', reason: 'ALREADY_SETTLED' });
      assert.equal(h.accounts.gameBalanceOf(1), balance);
    } finally {
      h.close();
    }
  });

  it('未封盘不可定盘', () => {
    const h = makeHarness({ book: { upAsk: 0.5 } });
    try {
      h.service.buy(1, 'UP', 10);
      assert.deepEqual(h.service.settleRound(WS, { startPrice: 60_000, endPrice: 60_001 }), {
        status: 'SKIPPED',
        reason: 'NOT_LOCKED',
      });
      assert.equal(h.bets.listByUser(1, 10, 0).rows[0]?.status, 'ACTIVE');
    } finally {
      h.close();
    }
  });

  it('未知回合返回 NOT_FOUND', () => {
    const h = makeHarness();
    try {
      assert.deepEqual(h.service.settleRound(12345, { startPrice: 1, endPrice: 2 }), {
        status: 'SKIPPED',
        reason: 'NOT_FOUND',
      });
    } finally {
      h.close();
    }
  });
});

describe('缺价作废退本金', () => {
  it('未到等待时长：只跳过，不动钱', () => {
    const { h } = staged();
    try {
      const result = h.service.settleRound(WS, { startPrice: 60_000, endPrice: null });
      assert.deepEqual(result, { status: 'SKIPPED', reason: 'WAITING_FOR_PRICE' });
      assert.equal(h.accounts.gameBalanceOf(1), DEFAULT_GAME_BALANCE - 103.5);
      assert.equal(h.rounds.findByWindowStart(WS)?.status, 'LOCKED');
    } finally {
      h.close();
    }
  });

  it('等满一小时仍无价：回合作废，注单退本金', () => {
    const { h } = staged();
    try {
      h.clock.advance((VOID_AFTER_SECONDS + 1) * 1000);
      const result = h.service.settleRound(WS, { startPrice: null, endPrice: null });
      assert.equal(result.status, 'VOIDED');
      if (result.status !== 'VOIDED') return;
      assert.equal(result.bets, 2);
      assert.equal(result.refunded, 150, 'user1 成本 100 + user2 成本 50');
      assert.equal(result.round.status, 'SETTLED');
      assert.equal(result.round.outcome, 'VOID');

      // 只退本金，手续费不退（买入时已经收掉）
      assert.equal(h.accounts.gameBalanceOf(1), DEFAULT_GAME_BALANCE - 3.5);
      assert.equal(h.accounts.gameBalanceOf(2), DEFAULT_GAME_BALANCE - 1.75);

      const drawn = h.bets.listByRoundAndStatus(h.rounds.findByWindowStart(WS)!.id, 'DRAW');
      assert.equal(drawn.length, 2);
      assert.deepEqual(drawn.map((b) => b.payout).sort((a, b) => a! - b!), [50, 100]);
    } finally {
      h.close();
    }
  });

  it('无注单的回合只需等两个窗口即可作废', () => {
    const h = makeHarness({ startPrice: null });
    try {
      h.service.lockRound(WS);
      assert.deepEqual(h.service.settleRound(WS, {}), {
        status: 'SKIPPED',
        reason: 'WAITING_FOR_PRICE',
      });
      h.clock.advance(600_000);
      const result = h.service.settleRound(WS, {});
      assert.equal(result.status, 'VOIDED');
      if (result.status !== 'VOIDED') return;
      assert.equal(result.bets, 0);
      assert.equal(result.refunded, 0);
    } finally {
      h.close();
    }
  });

  it('作废幂等：重复调用不再退款', () => {
    const { h } = staged();
    try {
      h.clock.advance((VOID_AFTER_SECONDS + 1) * 1000);
      h.service.settleRound(WS, {});
      const balance = h.accounts.gameBalanceOf(1);
      assert.deepEqual(h.service.settleRound(WS, {}), {
        status: 'SKIPPED',
        reason: 'ALREADY_SETTLED',
      });
      assert.equal(h.accounts.gameBalanceOf(1), balance);
    } finally {
      h.close();
    }
  });
});

describe('整回合一个事务：派彩失败则状态与钱一起回滚', () => {
  it('赢家账户缺失时抛错，回合留在 LOCKED、注单仍 ACTIVE，可重跑', () => {
    const { h } = staged();
    try {
      // 构造脏数据：删掉赢家的账户，派彩必然失败
      h.db.exec('DELETE FROM account WHERE user_id = 1');

      assert.throws(() => lockAndSettle(h, { startPrice: 60_000, endPrice: 60_010 }), /派彩失败/);

      const round = h.rounds.findByWindowStart(WS);
      assert.equal(round?.status, 'LOCKED', '回合不得被置成 SETTLED');
      assert.equal(round?.outcome, null, '结果不得落地');
      const bets = h.bets.listByRoundAndStatus(round!.id, 'ACTIVE');
      assert.equal(bets.length, 2, '注单必须仍是 ACTIVE，等下一次巡检');

      // 补上账户后重跑即可正常结算（casSettle 就是幂等边界）
      h.accounts.ensure(1, 'again', DEFAULT_GAME_BALANCE - 103.5);
      const retry = lockAndSettle(h, { startPrice: 60_000, endPrice: 60_010 });
      assert.equal(retry.status, 'SETTLED');
      if (retry.status !== 'SETTLED') return;
      assert.equal(retry.paidOut, 200);
    } finally {
      h.close();
    }
  });
});

describe('补结算巡检', () => {
  it('补锁并结算卡住的旧回合', () => {
    const h = makeHarness({ book: { upAsk: 0.5 }, withRound: false });
    try {
      // 两个窗口之前的回合：有人下注、忘了封盘（上一窗口刻意排除在外，见下一个用例）
      const staleWs = WS - 600;
      h.rounds.insertIfAbsent(staleWs, 60_000);
      h.clock.set(staleWs * 1000 + 10_000);
      h.quotes.set({ upAsk: 0.5, upBid: 0.5, ts: h.clock.now() });
      h.service.buy(1, 'UP', 100);

      // 时间推进到下一窗口
      h.clock.set(BASE_NOW);
      h.quotes.set({ upAsk: 0.5, upBid: 0.5, ts: BASE_NOW });

      const results = h.service.sweepStuckRounds(() => ({ startPrice: 60_000, endPrice: 60_010 }));
      assert.equal(results.length, 1);
      assert.equal(results[0]?.status, 'SETTLED');
      assert.equal(h.rounds.findByWindowStart(staleWs)?.status, 'SETTLED');
      assert.equal(h.bets.listByUser(1, 10, 0).rows[0]?.status, 'WON');
    } finally {
      h.close();
    }
  });

  it('上一窗口合法停在 LOCKED 时不被打扰（它正被正常结算）', () => {
    const h = makeHarness({ book: { upAsk: 0.5 }, withRound: false });
    try {
      const prevWs = WS - 300;
      h.rounds.insertIfAbsent(prevWs, 60_000);
      h.clock.set(prevWs * 1000 + 10_000);
      h.quotes.set({ upAsk: 0.5, upBid: 0.5, ts: h.clock.now() });
      h.service.buy(1, 'UP', 100);
      h.service.lockRound(prevWs);

      h.clock.set(BASE_NOW);
      h.quotes.set({ upAsk: 0.5, upBid: 0.5, ts: BASE_NOW });

      assert.deepEqual(h.service.sweepStuckRounds(), []);
      assert.equal(h.rounds.findByWindowStart(prevWs)?.status, 'LOCKED');
      assert.equal(h.bets.listByUser(1, 10, 0).rows[0]?.status, 'ACTIVE');
    } finally {
      h.close();
    }
  });

  it('不碰当前正在进行的回合', () => {
    const h = makeHarness({ book: { upAsk: 0.5 } });
    try {
      h.service.buy(1, 'UP', 10);
      assert.deepEqual(h.service.sweepStuckRounds(), []);
      assert.equal(h.rounds.findByWindowStart(WS)?.status, 'OPEN');
    } finally {
      h.close();
    }
  });

  it('没有取价器时，超期的旧回合按作废退本金收尾', () => {
    const h = makeHarness({ book: { upAsk: 0.5 }, withRound: false });
    try {
      const staleWs = WS - 300;
      h.rounds.insertIfAbsent(staleWs, 60_000);
      h.clock.set(staleWs * 1000 + 10_000);
      h.quotes.set({ upAsk: 0.5, upBid: 0.5, ts: h.clock.now() });
      h.service.buy(1, 'UP', 100);

      // 等到超过作废等待时长
      h.clock.set((staleWs + VOID_AFTER_SECONDS + 10) * 1000);
      const results = h.service.sweepStuckRounds();
      assert.equal(results[0]?.status, 'VOIDED');
      assert.equal(h.accounts.gameBalanceOf(1), DEFAULT_GAME_BALANCE - 3.5, '只亏手续费');
    } finally {
      h.close();
    }
  });
});
