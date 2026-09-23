import { WINDOW_SECONDS } from '../domain/types.ts';

const TWAP_LOOKBACK_SECONDS = 60;
/** 盘口半价差：一手买一卖一之间留 2 分 */
const HALF_SPREAD = 0.01;
/** 价格偏离目标价 0.1% 对应概率偏移 4 个点 */
const SENSITIVITY = 40;

export interface SimulatedSample {
  btcPrice: number;
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
}

export interface SimulatedMarket {
  /** 某一秒的价格 */
  priceAt(second: number): number;
  /** 窗口目标价：开盘时刻往前 60 秒的均值 */
  openPrice(windowStart: number): number;
  /** 窗口收盘价：窗口末 60 秒的均值 */
  closePrice(windowStart: number): number;
  /** 某一时刻的参考价（前端曲线用） */
  referencePrice(nowMs: number): number;
  /** 某一时刻的盘口 */
  quoteAt(nowMs: number, windowStart: number): SimulatedSample;
}

/** 整数混淆哈希 → [0,1)：同一 (seed, n) 永远同一个值，因此模拟完全可复现 */
function hash01(seed: number, n: number): number {
  let x = (seed ^ 0x9e3779b9) + Math.imul(n, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 本地行情模拟器：上游不可达时顶上，保证离线也能把整个玩法跑通。
 *
 * 价格是一条**闭式**曲线（几个正弦 + 逐秒哈希噪声），不是累加随机游走：
 * 闭式意味着任意时刻都能 O(1) 求值、且与调用顺序无关，测试里可复现、
 * 也不必为「回看历史」维护游标。
 */
export function createSimulatedMarket(
  options: { seed?: number; basePrice?: number; drift?: number } = {},
): SimulatedMarket {
  const seed = options.seed ?? 20260923;
  const basePrice = options.basePrice ?? 60_000;
  const drift = options.drift ?? 0.004;

  function priceAt(second: number): number {
    const wave = 0.6 * Math.sin(second / 37) + 0.35 * Math.sin(second / 11 + 1.3);
    const noise = 0.5 * (hash01(seed, second) - 0.5);
    return basePrice * (1 + drift * (wave + noise));
  }

  function twap(fromSecond: number, toSecond: number): number {
    let sum = 0;
    let count = 0;
    for (let s = fromSecond; s < toSecond; s++) {
      sum += priceAt(s);
      count++;
    }
    return count === 0 ? basePrice : round2(sum / count);
  }

  function openPrice(windowStart: number): number {
    return twap(windowStart - TWAP_LOOKBACK_SECONDS, windowStart);
  }

  function closePrice(windowStart: number): number {
    const end = windowStart + WINDOW_SECONDS;
    return twap(end - TWAP_LOOKBACK_SECONDS, end);
  }

  return {
    priceAt,
    openPrice,
    closePrice,
    referencePrice: (nowMs) => round2(priceAt(Math.floor(nowMs / 1000))),
    quoteAt(nowMs, windowStart) {
      const price = priceAt(Math.floor(nowMs / 1000));
      const target = openPrice(windowStart);
      const move = target === 0 ? 0 : (price - target) / target;
      const up = clamp(0.5 + move * SENSITIVITY, 0.05, 0.95);
      const down = 1 - up;
      return {
        btcPrice: round2(price),
        upBid: round2(clamp(up - HALF_SPREAD, 0.01, 0.99)),
        upAsk: round2(clamp(up + HALF_SPREAD, 0.01, 0.99)),
        downBid: round2(clamp(down - HALF_SPREAD, 0.01, 0.99)),
        downAsk: round2(clamp(down + HALF_SPREAD, 0.01, 0.99)),
      };
    },
  };
}
