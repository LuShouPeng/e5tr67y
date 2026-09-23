import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_GAME_BALANCE } from '../src/infra/repos/accountRepo.ts';
import { windowStartFor } from '../src/domain/window.ts';
import { BASE_NOW, makeHarness } from './helpers.ts';

const WS = windowStartFor(BASE_NOW);

describe('service.pnl：三种状态下的账户口径', () => {
  it('新账户全 0，权益等于初始额度', () => {
    const h = makeHarness({ book: { upAsk: 0.5 } });
    try {
      h.service.ensureAccount(1);
      const pnl = h.service.pnl(1);
      assert.equal(pnl.totalBets, 0);
      assert.equal(pnl.gameBalance, DEFAULT_GAME_BALANCE);
      assert.equal(pnl.equity, DEFAULT_GAME_BALANCE);
    } finally {
      h.close();
    }
  });

  it('买入后：持仓按买一价估值，未实现盈亏随盘口变化', () => {
    const h = makeHarness({ book: { upAsk: 0.5, upBid: 0.6 } });
    try {
      h.service.buy(1, 'UP', 100);
      const pnl = h.service.pnl(1);
      assert.equal(pnl.activeBets, 1);
      assert.equal(pnl.activeCost, 100);
      assert.equal(pnl.activeValue, 120, '200 份 × 0.6');
      assert.equal(pnl.unrealizedPnl, 20);
      assert.equal(pnl.realizedPnl, 0, '手续费不进盈亏，只体现在余额');
      assert.equal(pnl.gameBalance, DEFAULT_GAME_BALANCE - 103.5);
      assert.equal(pnl.equity, DEFAULT_GAME_BALANCE - 103.5 + 120);
    } finally {
      h.close();
    }
  });

  it('卖出后：转为已实现盈亏，持仓清空', () => {
    const h = makeHarness({ book: { upAsk: 0.5, upBid: 0.6 } });
    try {
      const bet = h.service.buy(1, 'UP', 100);
      h.service.sell(1, bet.id);
      const pnl = h.service.pnl(1);
      assert.equal(pnl.activeBets, 0);
      assert.equal(pnl.soldBets, 1);
      assert.equal(pnl.activeValue, 0);
      assert.equal(pnl.unrealizedPnl, 0);
      // 成本 100，到手 116.64
      assert.equal(pnl.realizedPnl, 16.64);
      assert.equal(pnl.totalPnl, 16.64);
      assert.equal(pnl.gameBalance, DEFAULT_GAME_BALANCE - 103.5 + 116.64);
      assert.equal(pnl.equity, pnl.gameBalance);
    } finally {
      h.close();
    }
  });

  it('结算后：赢单计入已实现，胜率 100%', () => {
    const h = makeHarness({ book: { upAsk: 0.5 } });
    try {
      h.service.buy(1, 'UP', 100);
      h.service.lockRound(WS);
      h.service.settleRound(WS, { startPrice: 60_000, endPrice: 60_010 });
      const pnl = h.service.pnl(1);
      assert.equal(pnl.wonBets, 1);
      assert.equal(pnl.activeBets, 0);
      assert.equal(pnl.realizedPnl, 100, '派彩 200 − 成本 100');
      assert.equal(pnl.winRate, 100);
      assert.equal(pnl.totalCost, 100);
      assert.equal(pnl.gameBalance, DEFAULT_GAME_BALANCE - 103.5 + 200);
    } finally {
      h.close();
    }
  });

  it('作废后：盈亏归零，只损失手续费', () => {
    const h = makeHarness({ book: { upAsk: 0.5 } });
    try {
      h.service.buy(1, 'UP', 100);
      h.service.lockRound(WS);
      h.clock.advance(3_700_000);
      h.service.settleRound(WS, {});
      const pnl = h.service.pnl(1);
      assert.equal(pnl.voidBets, 1);
      assert.equal(pnl.realizedPnl, 0);
      assert.equal(pnl.totalPnl, 0);
      assert.equal(pnl.gameBalance, DEFAULT_GAME_BALANCE - 3.5, '只亏手续费 3.5');
    } finally {
      h.close();
    }
  });

  it('多用户互不串账', () => {
    const h = makeHarness({ book: { upAsk: 0.5, downAsk: 0.5 } });
    try {
      h.service.buy(1, 'UP', 100);
      h.service.buy(2, 'DOWN', 500);
      assert.equal(h.service.pnl(1).activeCost, 100);
      assert.equal(h.service.pnl(2).activeCost, 500);
      assert.equal(h.service.pnl(1).activeBets, 1);
    } finally {
      h.close();
    }
  });
});
