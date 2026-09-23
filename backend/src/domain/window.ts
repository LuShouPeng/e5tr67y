import { WINDOW_SECONDS } from './types.ts';

/**
 * 所在 5 分钟窗口的起点（秒）。向下对齐到 300 秒整数边界，
 * 与 Polymarket 官方回合（slug 里的时间戳）一致，因此 `window_start` 可直接当幂等键用。
 */
export function windowStartFor(nowMs: number, windowSeconds: number = WINDOW_SECONDS): number {
  const nowSec = Math.floor(nowMs / 1000);
  return nowSec - (nowSec % windowSeconds);
}

export function windowEndFor(windowStart: number, windowSeconds: number = WINDOW_SECONDS): number {
  return windowStart + windowSeconds;
}

/** 上一回合起点 */
export function previousWindowStart(
  nowMs: number,
  windowSeconds: number = WINDOW_SECONDS,
): number {
  return windowStartFor(nowMs, windowSeconds) - windowSeconds;
}

/**
 * 当前窗口剩余秒数，取值区间 `(0, 300]`：
 * 恰好落在边界时返回整个窗口长度（刚开盘），窗口最后一秒返回 1。
 */
export function remainingSeconds(nowMs: number, windowSeconds: number = WINDOW_SECONDS): number {
  const nowSec = Math.floor(nowMs / 1000);
  return windowSeconds - (nowSec % windowSeconds);
}

/** 窗口已过去的秒数，取值区间 `[0, 300)` */
export function elapsedSeconds(nowMs: number, windowSeconds: number = WINDOW_SECONDS): number {
  return windowSeconds - remainingSeconds(nowMs, windowSeconds);
}
