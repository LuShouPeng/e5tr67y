import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BET_TRANSITIONS,
  ROUND_TRANSITIONS,
  assertBetTransition,
  assertRoundTransition,
  canTransitionRound,
  isRoundSellable,
  isRoundTradable,
} from '../src/domain/lifecycle.ts';
import { DomainError } from '../src/domain/errors.ts';
import type { PredictionRound } from '../src/domain/types.ts';
import { windowStartFor } from '../src/domain/window.ts';

const AT_07_05 = Date.UTC(2026, 8, 23, 7, 5, 0, 0);

function roundAt(nowMs: number, over: Partial<PredictionRound> = {}): PredictionRound {
  return {
    id: 1,
    windowStart: windowStartFor(nowMs),
    startPrice: null,
    endPrice: null,
    outcome: null,
    status: 'OPEN',
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

describe('回合状态机只允许单向迁移', () => {
  it('OPEN → LOCKED → SETTLED 合法', () => {
    assert.equal(canTransitionRound('OPEN', 'LOCKED'), true);
    assert.equal(canTransitionRound('LOCKED', 'SETTLED'), true);
  });

  it('跳级与回退非法：不允许越过封盘直接结算', () => {
    assert.equal(canTransitionRound('OPEN', 'SETTLED'), false);
    assert.equal(canTransitionRound('LOCKED', 'OPEN'), false);
    assert.equal(canTransitionRound('SETTLED', 'LOCKED'), false);
    assert.equal(canTransitionRound('SETTLED', 'SETTLED'), false);
  });

  it('非法迁移抛 DomainError(SETTLE_ILLEGAL)', () => {
    assert.throws(
      () => assertRoundTransition('OPEN', 'SETTLED'),
      (e: unknown) => e instanceof DomainError && e.code === 'SETTLE_ILLEGAL',
    );
    assert.doesNotThrow(() => assertRoundTransition('OPEN', 'LOCKED'));
  });

  it('SETTLED 是终态，出度为 0', () => {
    assert.deepEqual([...ROUND_TRANSITIONS.SETTLED], []);
  });
});

describe('注单状态机', () => {
  it('ACTIVE 可流转到四种终态', () => {
    assert.deepEqual([...BET_TRANSITIONS.ACTIVE].sort(), ['DRAW', 'LOST', 'SOLD', 'WON']);
  });

  it('终态不可再流转（防止已结算注单被二次派彩）', () => {
    for (const from of ['WON', 'LOST', 'SOLD', 'DRAW'] as const) {
      assert.deepEqual([...BET_TRANSITIONS[from]], []);
      assert.throws(() => assertBetTransition(from, 'ACTIVE'), DomainError);
    }
  });
});

describe('isRoundTradable：必须同时是 OPEN 且处于当前窗口', () => {
  it('本窗口的 OPEN 回合可交易', () => {
    assert.equal(isRoundTradable(roundAt(AT_07_05), AT_07_05), true);
  });

  it('上一窗口遗留的 OPEN 回合不可交易（结果已定死，防套现）', () => {
    const stale = roundAt(AT_07_05 - 300_000);
    assert.equal(stale.status, 'OPEN');
    assert.equal(isRoundTradable(stale, AT_07_05), false);
  });

  it('已封盘或已结算不可交易', () => {
    assert.equal(isRoundTradable(roundAt(AT_07_05, { status: 'LOCKED' }), AT_07_05), false);
    assert.equal(isRoundTradable(roundAt(AT_07_05, { status: 'SETTLED' }), AT_07_05), false);
  });

  it('窗口结束后（同一回合）立即不可交易', () => {
    const round = roundAt(AT_07_05);
    assert.equal(isRoundTradable(round, AT_07_05 + 299_000), true);
    assert.equal(isRoundTradable(round, AT_07_05 + 300_000), false);
  });

  it('可卖条件与可买条件一致', () => {
    const open = roundAt(AT_07_05);
    assert.equal(isRoundSellable(open, AT_07_05), isRoundTradable(open, AT_07_05));
    const stale = roundAt(AT_07_05 - 300_000);
    assert.equal(isRoundSellable(stale, AT_07_05), false);
  });
});
