import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { betValue, computePnl } from '../src/services/pnl.ts';
import type { PredictionBet } from '../src/domain/types.ts';
import { windowStartFor } from '../src/domain/window.ts';

const WS = 1_756_000_000 - (1_756_000_000 % 300);

function bet(over: Partial<PredictionBet> = {}): PredictionBet {
  return {
    id: 1,
    userId: 1,
    roundId: 1,
    windowStart: WS,
    side: 'UP',
    contracts: 100,
    cost: 50,
    avgPrice: 0.5,
    payout: null,
    status: 'ACTIVE',
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

const noBid = () => null;

describe('betValue：只有当前窗口才按买一价重估', () => {
  it('当前窗口按买一价估值', () => {
    assert.equal(betValue(bet(), 0.6, WS), 60);
  });

  it('非当前窗口按成本挂账（陈年价不可信）', () => {
    assert.equal(betValue(bet({ windowStart: WS - 300 }), 0.6, WS), 50);
  });

  it('同窗口但无买一价记 0：意思是「此刻卖不掉」，不是「值原价」', () => {
    assert.equal(betValue(bet(), null, WS), 0);
  });

  it('估值同样落在 4 位小数网格上', () => {
    assert.equal(betValue(bet({ contracts: 33.3333 }), 0.42, WS), 14);
  });
});

describe('computePnl：已实现 + 未实现', () => {
  it('赢单计入已实现盈亏 = 派彩 − 成本', () => {
    const stats = computePnl([bet({ status: 'WON', payout: 100 })], noBid, WS);
    assert.equal(stats.wonBets, 1);
    assert.equal(stats.settledBets, 1);
    assert.equal(stats.realizedPnl, 50);
    assert.equal(stats.winRate, 100);
  });

  it('输单把成本全记为亏损', () => {
    const stats = computePnl([bet({ status: 'LOST', payout: 0 })], noBid, WS);
    assert.equal(stats.lostBets, 1);
    assert.equal(stats.realizedPnl, -50);
    assert.equal(stats.winRate, 0);
  });

  it('卖出按到手金额结算盈亏', () => {
    const stats = computePnl([bet({ status: 'SOLD', payout: 58.32, cost: 50 })], noBid, WS);
    assert.equal(stats.soldBets, 1);
    assert.equal(stats.realizedPnl, 8.32);
    // 卖出计入已了结分母，但不计入赢
    assert.equal(stats.winRate, 0);
  });

  it('作废退款盈亏记 0，但仍算已了结', () => {
    const stats = computePnl([bet({ status: 'DRAW', payout: 50 })], noBid, WS);
    assert.equal(stats.voidBets, 1);
    assert.equal(stats.settledBets, 1);
    assert.equal(stats.realizedPnl, 0);
    assert.equal(stats.totalPnl, 0);
  });

  it('持仓未实现盈亏 = 现值 − 持仓成本', () => {
    const stats = computePnl([bet({ contracts: 200, cost: 100 })], () => 0.6, WS);
    assert.equal(stats.activeBets, 1);
    assert.equal(stats.activeCost, 100);
    assert.equal(stats.activeValue, 120);
    assert.equal(stats.unrealizedPnl, 20);
    assert.equal(stats.totalPnl, 20);
    assert.equal(stats.realizedPnl, 0);
  });

  it('混合组合：赢 + 输 + 卖 + 作废 + 持仓', () => {
    const stats = computePnl(
      [
        bet({ id: 1, status: 'WON', cost: 100, payout: 200 }),
        bet({ id: 2, status: 'LOST', cost: 50, payout: 0 }),
        bet({ id: 3, status: 'SOLD', cost: 50, payout: 58.32 }),
        bet({ id: 4, status: 'DRAW', cost: 30, payout: 30 }),
        bet({ id: 5, status: 'ACTIVE', contracts: 200, cost: 100 }),
      ],
      () => 0.6,
      WS,
    );

    assert.equal(stats.totalBets, 5);
    assert.equal(stats.settledBets, 4);
    assert.equal(stats.wonBets, 1);
    assert.equal(stats.lostBets, 1);
    assert.equal(stats.soldBets, 1);
    assert.equal(stats.voidBets, 1);
    assert.equal(stats.activeBets, 1);

    // 已实现：+100 − 50 + 8.32 + 0
    assert.equal(stats.realizedPnl, 58.32);
    assert.equal(stats.totalCost, 330);
    assert.equal(stats.activeCost, 100);
    assert.equal(stats.activeValue, 120);
    assert.equal(stats.unrealizedPnl, 20);
    assert.equal(stats.totalPnl, 78.32);
    assert.equal(stats.winRate, 25, '1 赢 / 4 了结');
  });

  it('空账本：全 0，胜率不出现除零', () => {
    const stats = computePnl([], noBid, WS);
    assert.equal(stats.totalBets, 0);
    assert.equal(stats.settledBets, 0);
    assert.equal(stats.winRate, 0);
    assert.equal(stats.totalPnl, 0);
  });

  it('跨窗口持仓按成本挂账，不产生虚假未实现盈亏', () => {
    const stats = computePnl(
      [bet({ windowStart: WS - 300, contracts: 200, cost: 100 })],
      () => 0.9,
      WS,
    );
    assert.equal(stats.activeValue, 100);
    assert.equal(stats.unrealizedPnl, 0);
  });

  it('同窗口无买一价：持仓现值记 0，未实现为全额浮亏', () => {
    const stats = computePnl([bet({ contracts: 200, cost: 100 })], noBid, WS);
    assert.equal(stats.activeValue, 0);
    assert.equal(stats.unrealizedPnl, -100);
  });

  it('胜率保留 2 位小数', () => {
    const many = [];
    for (let i = 0; i < 3; i++) many.push(bet({ id: i + 1, status: 'WON', payout: 100 }));
    many.push(bet({ id: 99, status: 'LOST', payout: 0 }));
    const stats = computePnl(many, noBid, WS);
    assert.equal(stats.winRate, 75);
  });
});

describe('computePnl 与窗口工具的一致性', () => {
  it('用 windowStartFor 判定的窗口与直接比较一致', () => {
    const nowMs = WS * 1000 + 1000;
    assert.equal(windowStartFor(nowMs), WS);
    const stats = computePnl([bet({ contracts: 200, cost: 100 })], () => 0.6, windowStartFor(nowMs));
    assert.equal(stats.activeValue, 120);
  });
});
