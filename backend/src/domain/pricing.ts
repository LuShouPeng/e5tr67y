import type { Side } from './types.ts';

/** 一边（UP 或 DOWN）的最优买卖价 */
export interface QuoteLevel {
  bid: number | null;
  ask: number | null;
}

export interface QuoteBook {
  up: QuoteLevel;
  down: QuoteLevel;
  /** 上游盘口的更新时间（毫秒） */
  ts: number;
}

/**
 * 买一价：0（或更小）表示这一档空了 —— 与 CLOB 快照里空档位同义，按「没有报价」处理。
 * 卖一价：1 表示没人愿意卖，同理。
 */
export function normalizeBid(bid: number | null | undefined): number | null {
  if (bid == null || !Number.isFinite(bid)) return null;
  return bid > 0 && bid <= 1 ? bid : null;
}

export function normalizeAsk(ask: number | null | undefined): number | null {
  if (ask == null || !Number.isFinite(ask)) return null;
  return ask >= 0 && ask < 1 ? ask : null;
}

export function normalizeQuoteBook(raw: {
  upBid?: number | null;
  upAsk?: number | null;
  downBid?: number | null;
  downAsk?: number | null;
  ts?: number;
}): QuoteBook {
  return {
    up: { bid: normalizeBid(raw.upBid), ask: normalizeAsk(raw.upAsk) },
    down: { bid: normalizeBid(raw.downBid), ask: normalizeAsk(raw.downAsk) },
    ts: raw.ts ?? Date.now(),
  };
}

export function quoteFor(book: QuoteBook | null, side: Side): QuoteLevel | null {
  if (book == null) return null;
  return side === 'UP' ? book.up : book.down;
}

export function opposite(side: Side): Side {
  return side === 'UP' ? 'DOWN' : 'UP';
}

/**
 * 盘口是否新鲜。上游断线时旧价会一直挂着，超龄报价宁可不下单：
 * 5 分钟盘里 15 秒的旧价完全可能是另一个价位的世界。
 */
export function isQuoteFresh(book: QuoteBook | null, nowMs: number, maxAgeMs = 15_000): boolean {
  if (book == null) return false;
  const age = nowMs - book.ts;
  return age >= 0 ? age <= maxAgeMs : false;
}
