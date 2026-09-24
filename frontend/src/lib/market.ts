import type { MarketEvent, QuoteBook, QuoteLevel } from '../api/types.ts';

/** 5 分钟回合，与后端 window_start 口径一致 */
export const WINDOW_SECONDS = 300;

/** 盘口超过这个时长没更新就算旧价：5 分钟盘里 15 秒前的价可能是另一个世界 */
export const QUOTE_STALE_MS = 15_000;

/**
 * 服务端与本机的时钟差（服务端时间 − 本机时间）。
 * 只用服务端下发的时间戳，不信本机时钟：5 分钟一局，差几秒就足以把封盘前后的判断搞反。
 */
export function computeClockOffset(serverTimeMs: number, clientNowMs: number): number {
  if (!Number.isFinite(serverTimeMs) || !Number.isFinite(clientNowMs)) return 0;
  return serverTimeMs - clientNowMs;
}

/** 按校准后的时钟算本回合剩余秒数，区间 [0, 300] */
export function remainingSeconds(
  windowStart: number,
  clientNowMs: number,
  offsetMs = 0,
  windowSeconds = WINDOW_SECONDS,
): number {
  const endMs = (windowStart + windowSeconds) * 1000;
  const remaining = Math.ceil((endMs - (clientNowMs + offsetMs)) / 1000);
  return Math.min(windowSeconds, Math.max(0, remaining));
}

/** 当前所在的回合起点（按校准后的时钟） */
export function currentWindowStart(
  clientNowMs: number,
  offsetMs = 0,
  windowSeconds = WINDOW_SECONDS,
): number {
  const sec = Math.floor((clientNowMs + offsetMs) / 1000);
  return sec - (sec % windowSeconds);
}

export function midPrice(level: QuoteLevel | null | undefined): number | null {
  if (level == null) return null;
  const { bid, ask } = level;
  if (bid != null && ask != null) return (bid + ask) / 2;
  return bid ?? ask ?? null;
}

/**
 * 市场隐含的看涨概率（取买一卖一中间价）。
 * 缺一边时另一边就是唯一可用的信息——不编造，也不返回 0.5 假装有报价。
 */
export function impliedUpProbability(quote: QuoteBook | null): number | null {
  return midPrice(quote?.up) ?? null;
}

/**
 * 盘口是否过期。
 *
 * 只判「太久没更新」这一个方向：服务端时钟通常走在前面，
 * 用本机时间减服务端时间戳会得到负数，若把负数也当过期的，等于每条报价都过期。
 * 未来时间戳只说明刚才才更新过，是新鲜的。
 */
export function isQuoteStale(
  quote: { ts: number } | null | undefined,
  clientNowMs: number,
  maxAgeMs = QUOTE_STALE_MS,
): boolean {
  if (quote == null) return true;
  return clientNowMs - quote.ts > maxAgeMs;
}

/** 行情推送本身就是一份完整盘口快照，直接换成嵌套结构给组件用 */
export function marketEventToQuote(event: MarketEvent): QuoteBook {
  return {
    up: { bid: event.upBid, ask: event.upAsk },
    down: { bid: event.downBid, ask: event.downAsk },
    ts: event.ts,
  };
}

export function isRoundOpen(status: string | null | undefined): boolean {
  return status === 'OPEN';
}

/** 回合内已过去的比例 0~1，用于倒计时进度条 */
export function elapsedRatio(
  windowStart: number,
  clientNowMs: number,
  offsetMs = 0,
  windowSeconds = WINDOW_SECONDS,
): number {
  const remaining = remainingSeconds(windowStart, clientNowMs, offsetMs, windowSeconds);
  return Math.min(1, Math.max(0, 1 - remaining / windowSeconds));
}

/** 保留最近这段时间的价格点（图表只画窗口内的一段） */
export function trimHistory<T extends { time: number }>(
  points: readonly T[],
  nowMs: number,
  keepMs = 300_000,
): T[] {
  const cutoff = nowMs - keepMs;
  return points.filter((p) => p.time >= cutoff);
}

export interface ActivityKey {
  ts: number;
  username: string;
  side: string;
  amount: number;
}

function activityKey(item: ActivityKey): string {
  return `${item.ts}|${item.username}|${item.side}|${item.amount}`;
}

/**
 * 合并「REST 历史」与「SSE 实时」两路成交流。
 *
 * 首次进页面时 SSE 只推之后发生的事，历史得靠 REST 补——但补上之后
 * 任何一条都可能重复出现（REST 回包慢于推送时尤其明显），所以按内容去重。
 * SSE 的那份排在前面：它更新。
 */
export function mergeActivities<T extends ActivityKey>(
  live: readonly T[],
  seed: readonly T[],
  max = 30,
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const item of [...live, ...seed]) {
    const key = activityKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
    if (merged.length >= max) break;
  }
  return merged;
}
