import { DomainError } from './errors.ts';
import type { BetStatus, PredictionRound, RoundStatus } from './types.ts';
import { windowStartFor } from './window.ts';

/**
 * 回合状态机：`OPEN → LOCKED → SETTLED`，只允许单向迁移。
 * 结算必须发生在封盘之后——否则就是「照着已经跑出来的价格下注」。
 */
export const ROUND_TRANSITIONS: Readonly<Record<RoundStatus, readonly RoundStatus[]>> = {
  OPEN: ['LOCKED'],
  LOCKED: ['SETTLED'],
  SETTLED: [],
};

export const BET_TRANSITIONS: Readonly<Record<BetStatus, readonly BetStatus[]>> = {
  ACTIVE: ['WON', 'LOST', 'SOLD', 'DRAW'],
  WON: [],
  LOST: [],
  SOLD: [],
  DRAW: [],
};

export function canTransitionRound(from: RoundStatus, to: RoundStatus): boolean {
  return ROUND_TRANSITIONS[from].includes(to);
}

export function assertRoundTransition(from: RoundStatus, to: RoundStatus): void {
  if (!canTransitionRound(from, to)) {
    throw new DomainError('SETTLE_ILLEGAL', `回合状态不允许 ${from} → ${to}`);
  }
}

export function canTransitionBet(from: BetStatus, to: BetStatus): boolean {
  return BET_TRANSITIONS[from].includes(to);
}

export function assertBetTransition(from: BetStatus, to: BetStatus): void {
  if (!canTransitionBet(from, to)) {
    throw new DomainError('SETTLE_ILLEGAL', `注单状态不允许 ${from} → ${to}`);
  }
}

/**
 * 是否处于可交易（买卖）窗口。
 *
 * 两个条件缺一不可：回合本身 `OPEN`，且它就是我们此刻所在的窗口。
 * 只判 `status` 不够——巡检漏锁的旧回合会一直挂着 `OPEN`，
 * 那时结果其实早已定死，放行等于让人拿已知结果套现。
 */
export function isRoundTradable(round: PredictionRound, nowMs: number): boolean {
  return round.status === 'OPEN' && round.windowStart === windowStartFor(nowMs);
}

/** 只在当前窗口内、且尚未封盘的回合里，注单才卖得掉（理由同 isRoundTradable） */
export function isRoundSellable(round: PredictionRound, nowMs: number): boolean {
  return isRoundTradable(round, nowMs);
}
