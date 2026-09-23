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

/** 在 50¢ 买入 100 USDT（200 份，扣 103.5），供卖出用例复用 */
function buyThen(h: ReturnType<typeof makeHarness>) {
  return h.service.buy(1, 'UP', 100);
}

describe('整单卖出', () => {
  it('按买一价成交扣费，注单转 SOLD，回款计入余额', () => {
    const h = makeHarness({ book: { upAsk: 0.5, upBid: 0.6 } });
    try {
      const bet = buyThen(h);
      const sold = h.service.sell(1, bet.id);
      // 200 份 × 0.6 = 120 成交额，费 = 200 × 0.07×0.6×0.4 = 3.36，到手 116.64
      assert.equal(sold.status, 'SOLD');
      assert.equal(sold.payout, 116.64);
      assert.equal(h.accounts.gameBalanceOf(1), DEFAULT_GAME_BALANCE - 103.5 + 116.64);
    } finally {
      h.close();
    }
  });

  it('显式传全部份数等价于整单卖出', () => {
    const h = makeHarness({ book: { upAsk: 0.5, upBid: 0.55 } });
    try {
      const bet = buyThen(h);
      const sold = h.service.sell(1, bet.id, bet.contracts);
      assert.equal(sold.status, 'SOLD');
      assert.equal(sold.contracts, 200);
      // 200 × 0.55 = 110，费 = 200×0.07×0.55×0.45 = 3.465，到手 106.535
      assert.equal(sold.payout, 106.535);
    } finally {
      h.close();
    }
  });

  it('亏损卖出照常成交（市场价说话）', () => {
    const h = makeHarness({ book: { upAsk: 0.5, upBid: 0.2 } });
    try {
      const bet = buyThen(h);
      const sold = h.service.sell(1, bet.id);
      // 200 × 0.2 = 40，费 = 200×0.07×0.2×0.8 = 2.24，到手 37.76
      assert.equal(sold.payout, 37.76);
      assert.ok(h.accounts.gameBalanceOf(1) < DEFAULT_GAME_BALANCE);
    } finally {
      h.close();
    }
  });
});

describe('部分卖出', () => {
  it('拆出一笔 SOLD 记录，原单继续持有剩余份数', () => {
    const h = makeHarness({ book: { upAsk: 0.5, upBid: 0.6 } });
    try {
      const bet = buyThen(h);
      const sold = h.service.sell(1, bet.id, 50);

      assert.equal(sold.status, 'SOLD');
      assert.equal(sold.contracts, 50);
      assert.equal(sold.cost, 25, '成本按比例拆：100 × 50/200');
      assert.equal(sold.avgPrice, 0.5);
      // 50 × 0.6 = 30，费 = 50×0.07×0.6×0.4 = 0.84，到手 29.16
      assert.equal(sold.payout, 29.16);

      const rest = h.bets.findById(bet.id);
      assert.equal(rest?.status, 'ACTIVE');
      assert.equal(rest?.contracts, 150);
      assert.equal(rest?.cost, 75);
    } finally {
      h.close();
    }
  });

  it('多次部分卖出后份数与成本守恒', () => {
    const h = makeHarness({ book: { upAsk: 0.5, upBid: 0.6 } });
    try {
      const bet = buyThen(h);
      h.service.sell(1, bet.id, 50);
      h.service.sell(1, bet.id, 50);
      const rest = h.bets.findById(bet.id);
      assert.equal(rest?.contracts, 100);
      assert.equal(rest?.cost, 50);
      // 最后把剩下的卖光 → 整单转 SOLD
      const last = h.service.sell(1, bet.id);
      assert.equal(last.status, 'SOLD');
      assert.equal(last.contracts, 100);
      assert.equal(h.bets.findById(bet.id)?.status, 'SOLD');
    } finally {
      h.close();
    }
  });

  it('三次拆分卖出的回款合计等于一次性全卖', () => {
    const one = makeHarness({ book: { upAsk: 0.5, upBid: 0.6 } });
    const three = makeHarness({ book: { upAsk: 0.5, upBid: 0.6 } });
    try {
      const a = buyThen(one);
      const all = one.service.sell(1, a.id).payout!;

      const b = buyThen(three);
      const parts =
        three.service.sell(1, b.id, 50).payout! +
        three.service.sell(1, b.id, 50).payout! +
        three.service.sell(1, b.id, 100).payout!;

      // 分段成交费按份数线性，因此总和应一致（差异只可能来自 4 位小数舍入）
      assert.ok(Math.abs(all - parts) <= 0.0004, `整卖 ${all} vs 分卖 ${parts}`);
    } finally {
      one.close();
      three.close();
    }
  });
});

describe('卖出失败路径', () => {
  it('已卖出的注单不能重复卖', () => {
    const h = makeHarness({ book: { upAsk: 0.5, upBid: 0.6 } });
    try {
      const bet = buyThen(h);
      h.service.sell(1, bet.id);
      assert.equal(codeOf(() => h.service.sell(1, bet.id)), 'BET_NOT_ACTIVE');
    } finally {
      h.close();
    }
  });

  it('别人的注单卖不掉（且不泄露存在性）', () => {
    const h = makeHarness({ book: { upAsk: 0.5, upBid: 0.6 } });
    try {
      const bet = buyThen(h);
      assert.equal(codeOf(() => h.service.sell(999, bet.id)), 'BET_NOT_FOUND');
    } finally {
      h.close();
    }
  });

  it('回合封盘后不可卖（防拿已知结果套现）', () => {
    const h = makeHarness({ book: { upAsk: 0.5, upBid: 0.6 } });
    try {
      const bet = buyThen(h);
      h.service.lockRound(windowStartFor(BASE_NOW));
      assert.equal(codeOf(() => h.service.sell(1, bet.id)), 'ROUND_LOCKED');
    } finally {
      h.close();
    }
  });

  it('窗口走完后不可卖', () => {
    const h = makeHarness({ book: { upAsk: 0.5, upBid: 0.6 } });
    try {
      const bet = buyThen(h);
      h.clock.advance(300_000);
      assert.equal(codeOf(() => h.service.sell(1, bet.id)), 'ROUND_LOCKED');
    } finally {
      h.close();
    }
  });

  it('盘口缺失或超龄时拒绝卖出', () => {
    const h = makeHarness({ book: { upAsk: 0.5, upBid: 0.6 } });
    try {
      const bet = buyThen(h);
      h.quotes.clear();
      assert.equal(codeOf(() => h.service.sell(1, bet.id)), 'PRICE_UNAVAILABLE');
    } finally {
      h.close();
    }

    const stale = makeHarness({ book: { upAsk: 0.5, upBid: 0.6 } });
    try {
      const bet = buyThen(stale);
      stale.quotes.set({ upBid: 0.6, upAsk: 0.5, ts: BASE_NOW - 30_000 });
      assert.equal(codeOf(() => stale.service.sell(1, bet.id)), 'PRICE_UNAVAILABLE');
    } finally {
      stale.close();
    }
  });

  it('买一为空档（0）时拒绝卖出', () => {
    const h = makeHarness({ book: { upAsk: 0.5, upBid: 0 } });
    try {
      const bet = buyThen(h);
      assert.equal(codeOf(() => h.service.sell(1, bet.id)), 'PRICE_UNAVAILABLE');
    } finally {
      h.close();
    }
  });

  it('份数越界（0 / 负数 / 超过持仓）一律拒绝', () => {
    const h = makeHarness({ book: { upAsk: 0.5, upBid: 0.6 } });
    try {
      const bet = buyThen(h);
      assert.equal(codeOf(() => h.service.sell(1, bet.id, 0)), 'CONTRACTS_INVALID');
      assert.equal(codeOf(() => h.service.sell(1, bet.id, -5)), 'CONTRACTS_INVALID');
      assert.equal(codeOf(() => h.service.sell(1, bet.id, 200.0001)), 'CONTRACTS_INVALID');
      assert.equal(h.bets.findById(bet.id)?.status, 'ACTIVE');
    } finally {
      h.close();
    }
  });
});
