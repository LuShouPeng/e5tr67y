import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DomainError } from '../src/domain/errors.ts';
import { DEFAULT_GAME_BALANCE } from '../src/infra/repos/accountRepo.ts';
import { windowStartFor } from '../src/domain/window.ts';
import { BASE_NOW, makeHarness } from './helpers.ts';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    return `非领域错误：${String(e)}`;
  }
  return '未抛错';
}

describe('买入下单：扣款 = 成本 + 吃单费', () => {
  it('新用户自动开户并带初始虚拟资金', () => {
    const h = makeHarness({ book: { upAsk: 0.5 } });
    try {
      const bet = h.service.buy(7, 'UP', 100);
      assert.equal(bet.id > 0, true);
      assert.equal(bet.status, 'ACTIVE');
      assert.equal(h.accounts.gameBalanceOf(7), DEFAULT_GAME_BALANCE - 103.5);
    } finally {
      h.close();
    }
  });

  it('100 USDT @50¢ → 200 份，成本 100，费 3.5，余额扣 103.5', () => {
    const h = makeHarness({ book: { upAsk: 0.5 } });
    try {
      const bet = h.service.buy(1, 'UP', 100);
      assert.equal(bet.side, 'UP');
      assert.equal(bet.contracts, 200);
      assert.equal(bet.cost, 100);
      assert.equal(bet.avgPrice, 0.5);
      assert.equal(bet.payout, null, '未结算前不写 payout');
      assert.equal(h.accounts.gameBalanceOf(1), DEFAULT_GAME_BALANCE - 103.5);
    } finally {
      h.close();
    }
  });

  it('DOWN 方向按 DOWN 的卖一价成交', () => {
    const h = makeHarness({ book: { downAsk: 0.25 } });
    try {
      const bet = h.service.buy(1, 'DOWN', 10);
      assert.equal(bet.side, 'DOWN');
      assert.equal(bet.contracts, 40);
      assert.equal(bet.cost, 10);
      assert.equal(h.accounts.gameBalanceOf(1), DEFAULT_GAME_BALANCE - 10.525);
    } finally {
      h.close();
    }
  });

  it('连续买入累计扣款，且各自独立成单', () => {
    const h = makeHarness({ book: { upAsk: 0.5 } });
    try {
      h.service.buy(1, 'UP', 100);
      h.service.buy(1, 'UP', 50);
      const all = h.bets.listByUser(1, 10, 0);
      assert.equal(all.total, 2);
      // 第二笔：100 份，成本 50，费 = 100 份 × 0.0175 = 1.75，共扣 51.75
      assert.equal(h.accounts.gameBalanceOf(1), DEFAULT_GAME_BALANCE - 103.5 - 51.75);
    } finally {
      h.close();
    }
  });

  it('注单落到当前窗口的回合上', () => {
    const h = makeHarness({ book: { upAsk: 0.5 } });
    try {
      const bet = h.service.buy(1, 'UP', 10);
      const round = h.rounds.findByWindowStart(windowStartFor(BASE_NOW));
      assert.equal(bet.roundId, round?.id);
      assert.equal(bet.windowStart, windowStartFor(BASE_NOW));
    } finally {
      h.close();
    }
  });
});

describe('买入失败路径：拒绝且不留痕', () => {
  it('余额不足 → INSUFFICIENT_BALANCE，不扣款、不落单', () => {
    const h = makeHarness({ book: { upAsk: 0.5 } });
    try {
      h.accounts.ensure(1, 'poor', 50);
      assert.equal(codeOf(() => h.service.buy(1, 'UP', 100)), 'INSUFFICIENT_BALANCE');
      assert.equal(h.accounts.gameBalanceOf(1), 50);
      assert.equal(h.bets.listByUser(1, 10, 0).total, 0);
    } finally {
      h.close();
    }
  });

  it('余额差一点点也不放过（手续费在金额之外）', () => {
    const h = makeHarness({ book: { upAsk: 0.5 } });
    try {
      // 需要 103.5，只给 103.49
      h.accounts.ensure(1, 'almost', 103.49);
      assert.equal(codeOf(() => h.service.buy(1, 'UP', 100)), 'INSUFFICIENT_BALANCE');
      assert.equal(h.accounts.gameBalanceOf(1), 103.49);
    } finally {
      h.close();
    }
  });

  it('回合未开盘 → ROUND_NOT_FOUND', () => {
    const h = makeHarness({ book: { upAsk: 0.5 }, withRound: false });
    try {
      assert.equal(codeOf(() => h.service.buy(1, 'UP', 10)), 'ROUND_NOT_FOUND');
    } finally {
      h.close();
    }
  });

  it('回合已封盘 → ROUND_LOCKED', () => {
    const h = makeHarness({ book: { upAsk: 0.5 } });
    try {
      h.service.lockRound(windowStartFor(BASE_NOW));
      assert.equal(codeOf(() => h.service.buy(1, 'UP', 10)), 'ROUND_LOCKED');
    } finally {
      h.close();
    }
  });

  it('旧窗口遗留的 OPEN 回合不构成可交易回合', () => {
    const h = makeHarness({ book: { upAsk: 0.5 }, withRound: false });
    try {
      // 上一窗口的回合还在，状态仍是 OPEN
      h.rounds.insertIfAbsent(windowStartFor(BASE_NOW) - 300, 60_000);
      assert.equal(h.rounds.findByWindowStart(windowStartFor(BASE_NOW) - 300)?.status, 'OPEN');
      // 当前窗口没有回合 → 拒单，而不是拿旧回合成交
      assert.equal(codeOf(() => h.service.buy(1, 'UP', 10)), 'ROUND_NOT_FOUND');
      // 当前回合开出后才可下单
      h.service.ensureRound(60_000);
      const bet = h.service.buy(1, 'UP', 10);
      assert.equal(bet.windowStart, windowStartFor(BASE_NOW));
    } finally {
      h.close();
    }
  });

  it('无盘口 / 盘口超龄 / 卖一空档 → PRICE_UNAVAILABLE', () => {
    const none = makeHarness({ book: null });
    try {
      assert.equal(codeOf(() => none.service.buy(1, 'UP', 10)), 'PRICE_UNAVAILABLE');
    } finally {
      none.close();
    }

    const stale = makeHarness({ book: { upAsk: 0.5 }, quoteTs: BASE_NOW - 60_000 });
    try {
      assert.equal(codeOf(() => stale.service.buy(1, 'UP', 10)), 'PRICE_UNAVAILABLE');
    } finally {
      stale.close();
    }

    const noAsk = makeHarness({ book: { upAsk: 1, downAsk: 0.5 } });
    try {
      assert.equal(codeOf(() => noAsk.service.buy(1, 'UP', 10)), 'PRICE_UNAVAILABLE');
      // 另一边仍可下单
      assert.doesNotThrow(() => noAsk.service.buy(1, 'DOWN', 10));
    } finally {
      noAsk.close();
    }
  });

  it('参数非法先于任何副作用被拒', () => {
    const h = makeHarness({ book: { upAsk: 0.5 } });
    try {
      assert.equal(codeOf(() => h.service.buy(1, 'up', 10)), 'SIDE_INVALID');
      assert.equal(codeOf(() => h.service.buy(1, 'UP', 0)), 'AMOUNT_INVALID');
      assert.equal(codeOf(() => h.service.buy(1, 'UP', 10_001)), 'AMOUNT_INVALID');
      assert.equal(h.bets.listByUser(1, 10, 0).total, 0);
    } finally {
      h.close();
    }
  });
});

describe('注单估值与试算', () => {
  it('本回合 ACTIVE 注单按买一价估值', () => {
    const h = makeHarness({ book: { upAsk: 0.5, upBid: 0.6 } });
    try {
      const bet = h.service.buy(1, 'UP', 100);
      // 200 份 × 0.6 = 120
      assert.equal(bet.currentValue, 120);
    } finally {
      h.close();
    }
  });

  it('无买一价时估值为 null（不是 0）', () => {
    const h = makeHarness({ book: { upAsk: 0.5, upBid: 0 } });
    try {
      const bet = h.service.buy(1, 'UP', 100);
      assert.equal(bet.currentValue, null);
    } finally {
      h.close();
    }
  });

  it('previewBuy 只试算，不落库不扣款', () => {
    const h = makeHarness({ book: { upAsk: 0.25 } });
    try {
      const plan = h.service.previewBuy('UP', 10);
      assert.equal(plan.contracts, 40);
      assert.equal(plan.total, 10.525);
      assert.equal(h.bets.listByUser(1, 10, 0).total, 0);
      assert.equal(h.accounts.find(1), null);
    } finally {
      h.close();
    }
  });
});
