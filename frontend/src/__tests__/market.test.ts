import { describe, expect, it } from 'vitest';

import type { QuoteBook } from '../api/types.ts';
import {
  computeClockOffset,
  currentWindowStart,
  elapsedRatio,
  impliedUpProbability,
  isQuoteStale,
  marketEventToQuote,
  midPrice,
  remainingSeconds,
  trimHistory,
} from '../lib/market.ts';

describe('computeClockOffset：只信服务端时间', () => {
  it('服务端快 3 秒 → 偏移 +3000ms', () => {
    expect(computeClockOffset(1_000_000 + 3000, 1_000_000)).toBe(3000);
  });

  it('服务端慢 2 秒 → 偏移 -2000ms', () => {
    expect(computeClockOffset(998_000, 1_000_000)).toBe(-2000);
  });

  it('非有限值一律 0（宁可不校准也不给 NaN 倒计时）', () => {
    expect(computeClockOffset(Number.NaN, 1000)).toBe(0);
    expect(computeClockOffset(1000, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('remainingSeconds：倒计时区间 [0, 300]', () => {
  const WS = 1_790_000_000;

  it('刚开盘是满额', () => {
    expect(remainingSeconds(WS, WS * 1000)).toBe(300);
  });

  it('中途递减，向上取整（显示 04:24 而不是 04:23）', () => {
    expect(remainingSeconds(WS, WS * 1000 + 36_000)).toBe(264);
    expect(remainingSeconds(WS, WS * 1000 + 36_100)).toBe(264);
  });

  it('走完夹到 0，不会出现负数', () => {
    expect(remainingSeconds(WS, (WS + 300) * 1000)).toBe(0);
    expect(remainingSeconds(WS, (WS + 999) * 1000)).toBe(0);
  });

  it('时钟差参与计算：本机慢 10 秒时，剩余要少 10 秒', () => {
    const clientNow = WS * 1000 + 100_000;
    expect(remainingSeconds(WS, clientNow, 0)).toBe(200);
    expect(remainingSeconds(WS, clientNow, 10_000)).toBe(190);
    expect(remainingSeconds(WS, clientNow, -10_000)).toBe(210);
  });

  it('窗口长度可配（便于测试与复用）', () => {
    expect(remainingSeconds(WS, WS * 1000 + 30_000, 0, 60)).toBe(30);
  });
});

describe('currentWindowStart：按校准时钟取整 5 分钟', () => {
  it('对齐到 300 秒边界', () => {
    const base = 1_790_000_000 - (1_790_000_000 % 300);
    expect(currentWindowStart((base + 1) * 1000)).toBe(base);
    expect(currentWindowStart((base + 299) * 1000)).toBe(base);
    expect(currentWindowStart((base + 300) * 1000)).toBe(base + 300);
  });

  it('时钟差参与取整', () => {
    const base = 1_790_000_000 - (1_790_000_000 % 300);
    const justBefore = (base + 300) * 1000 - 500;
    expect(currentWindowStart(justBefore, 0)).toBe(base);
    expect(currentWindowStart(justBefore, 900)).toBe(base + 300);
  });
});

describe('midPrice / impliedUpProbability', () => {
  it('买卖都有时取中间价', () => {
    expect(midPrice({ bid: 0.48, ask: 0.5 })).toBeCloseTo(0.49, 10);
  });

  it('只有一边时用那一边，不编造 0.5', () => {
    expect(midPrice({ bid: null, ask: 0.3 })).toBe(0.3);
    expect(midPrice({ bid: 0.7, ask: null })).toBe(0.7);
  });

  it('两边都空或没有盘口 → null', () => {
    expect(midPrice({ bid: null, ask: null })).toBeNull();
    expect(midPrice(null)).toBeNull();
    expect(midPrice(undefined)).toBeNull();
  });

  it('隐含看涨概率取自 UP 那一边', () => {
    const quote: QuoteBook = { up: { bid: 0.6, ask: 0.62 }, down: { bid: 0.38, ask: 0.4 }, ts: 1 };
    expect(impliedUpProbability(quote)).toBeCloseTo(0.61, 10);
    expect(impliedUpProbability(null)).toBeNull();
  });
});

describe('isQuoteStale：超龄即不可信', () => {
  const now = 1_000_000;

  it('15 秒内算新鲜，超过算旧', () => {
    expect(isQuoteStale({ ts: now - 1000 }, now)).toBe(false);
    expect(isQuoteStale({ ts: now - 15_000 }, now)).toBe(false);
    expect(isQuoteStale({ ts: now - 15_001 }, now)).toBe(true);
  });

  it('没有盘口就是旧（还没报价）', () => {
    expect(isQuoteStale(null, now)).toBe(true);
    expect(isQuoteStale(undefined, now)).toBe(true);
  });

  it('时间戳在未来（服务端时钟超前）算新鲜，不是过期', () => {
    expect(isQuoteStale({ ts: now + 5000 }, now)).toBe(false);
  });
});

describe('marketEventToQuote：扁平推送 → 嵌套盘口', () => {
  it('字段一一对应，保留时间戳', () => {
    expect(
      marketEventToQuote({ upBid: 0.4, upAsk: 0.41, downBid: 0.59, downAsk: 0.6, ts: 123 }),
    ).toEqual({ up: { bid: 0.4, ask: 0.41 }, down: { bid: 0.59, ask: 0.6 }, ts: 123 });
  });

  it('空档位保持 null（不写成 0）', () => {
    expect(
      marketEventToQuote({ upBid: null, upAsk: 0.01, downBid: 0.99, downAsk: null, ts: 5 }),
    ).toEqual({ up: { bid: null, ask: 0.01 }, down: { bid: 0.99, ask: null }, ts: 5 });
  });
});

describe('elapsedRatio 与 trimHistory', () => {
  const WS = 1_790_000_000;

  it('进度比例随窗口推进', () => {
    expect(elapsedRatio(WS, WS * 1000)).toBe(0);
    expect(elapsedRatio(WS, WS * 1000 + 150_000)).toBeCloseTo(0.5, 5);
    expect(elapsedRatio(WS, (WS + 300) * 1000)).toBe(1);
    expect(elapsedRatio(WS, (WS + 900) * 1000)).toBe(1);
  });

  it('只保留窗口内的时间点（端点包含，与后端 since 口径一致）', () => {
    const points = [
      { time: 999, price: 0 },
      { time: 1000, price: 1 },
      { time: 299_000, price: 2 },
      { time: 301_000, price: 3 },
    ];
    // now - 300000 = 1000，正好在端点上的点要留着
    expect(trimHistory(points, 301_000, 300_000)).toEqual([
      { time: 1000, price: 1 },
      { time: 299_000, price: 2 },
      { time: 301_000, price: 3 },
    ]);
  });

  it('空数组安全', () => {
    expect(trimHistory([], 1000)).toEqual([]);
  });
});
