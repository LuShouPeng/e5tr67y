import type { Side } from './types.ts';
import { VOID_AFTER_SECONDS, VOID_IDLE_WINDOWS, WINDOW_SECONDS } from './types.ts';

/**
 * 结算判定：收盘 TWAP **不低于**开盘 TWAP 判 UP（相等算 UP，与 Polymarket 官方一致），否则 DOWN。
 * 因此这个玩法没有平局，「打平」的收益归看涨方。
 */
export function resolveOutcome(startPrice: number, endPrice: number): Side {
  if (!Number.isFinite(startPrice) || !Number.isFinite(endPrice)) {
    throw new RangeError(`结算价必须是有限数值：start=${startPrice}, end=${endPrice}`);
  }
  return endPrice >= startPrice ? 'UP' : 'DOWN';
}

/**
 * 缺价时的等待时长（秒）。有注单押着钱就先等满一小时——Polymarket 晚出数据是常事，
 * 急着作废等于把该赢的判成退本金；没注单的回合不涉及钱，等两个窗口确认缺价即可。
 */
export function voidWaitSeconds(activeBetCount: number): number {
  return activeBetCount > 0 ? VOID_AFTER_SECONDS : VOID_IDLE_WINDOWS * WINDOW_SECONDS;
}

export function isVoidDue(ageSeconds: number, activeBetCount: number): boolean {
  return ageSeconds >= voidWaitSeconds(activeBetCount);
}
