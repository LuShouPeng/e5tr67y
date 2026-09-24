/**
 * 公平概率模型（移植自上游 wtfibought `PredictionModel` / `PredictionStateWriter` 的数学部分）。
 *
 * UP 份额就是「末分钟均价 ≥ 开盘均价」这张数字期权，价只由领先幅度、剩余时间、波动决定。
 * 价格当零漂移随机游走：进末分钟前，末分钟均价的噪声 = σ² × (到末分钟的秒数 + 60/3)；
 * 进了末分钟，已走过的部分锁死，只剩余下几秒的噪声。
 * 「末分钟」是收盘前 63 到 3 秒：官方 TWAP 在 T 时刻的值 = 截至 T−3 秒的 60 个整秒现货价的均价。
 */

export const TWAP_SECONDS = 60;
/** 结算均价在收盘前这么多秒截止 */
export const SETTLE_LAG_SECONDS = 3;

/** 一跳：时刻(ms) + 价 */
export interface Tick {
  timeMs: number;
  price: number;
}

/** 1m K 线只用收盘价 */
export interface Kline {
  openTimeMs: number;
  close: number;
}

/**
 * 纯数学的 z，正 = 偏 UP。
 *
 * @param leadPct      现价相对开盘均价（%）
 * @param twapSoFarPct 末分钟已走过部分的均价相对开盘均价（%）；还没进末分钟为 null
 * @param sigma1mPct   1 分钟典型波动（%）
 * @param r            离结算均价截止的秒数
 */
export function modelZ(leadPct: number, twapSoFarPct: number | null, sigma1mPct: number, r: number): number {
  const sigmaSec = sigma1mPct / Math.sqrt(60);
  if (!(sigmaSec > 0)) return leadPct === 0 ? 0 : Math.sign(leadPct) * 10;
  if (r >= TWAP_SECONDS) {
    const sigma = sigmaSec * Math.sqrt(r - TWAP_SECONDS + TWAP_SECONDS / 3);
    return leadPct / sigma;
  }
  const remaining = Math.max(r, 0.001);
  const elapsed = TWAP_SECONDS - remaining;
  const mean = (elapsed * (twapSoFarPct ?? leadPct) + remaining * leadPct) / TWAP_SECONDS;
  // 末分钟：余下 r 秒的均价期望是现价、噪声 σ² r³ / (3 × 60²)
  const sigma = (sigmaSec * Math.pow(remaining, 1.5)) / (TWAP_SECONDS * Math.sqrt(3));
  return mean / sigma;
}

/** 标准正态分布函数（Abramowitz–Stegun 7.1.26，误差 < 1.5e-7） */
export function normCdf(z: number): number {
  if (z > 8) return 1;
  if (z < -8) return 0;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** (to − from) / from × 100 */
export function pct(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

/** 相邻已收盘 1m K 线的绝对涨跌（%）；末根还在形成，不算 */
export function absReturnsPct(bars: readonly Kline[]): number[] {
  const rets: number[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    rets.push(Math.abs(pct(bars[i - 1]!.close, bars[i]!.close)));
  }
  return rets;
}

/** 1 分钟典型波动（%）：绝对收益中位数 × 1.4826，不让一两根大 K 线把它拉高 */
export function sigma1mPct(bars: readonly Kline[]): number {
  const rets = absReturnsPct(bars).sort((a, b) => a - b);
  if (rets.length === 0) return 0;
  return rets[Math.floor(rets.length / 2)]! * 1.4826;
}

/** 时刻 t 的价：最后一个不晚于 t 的点，都晚于 t 就取首个 */
export function priceAt(points: readonly Tick[], t: number): number {
  let price = points[0]!.price;
  for (const p of points) {
    if (p.timeMs > t) break;
    price = p.price;
  }
  return price;
}

/**
 * 最近几分钟的实际波动（%，折成 1 分钟）：每 10 秒取一个价，10 秒涨跌的均方根 × √6。
 * 不到 6 段回 0，交给一小时典型值。
 */
export function recentSigma1mPct(ticks: readonly Tick[], nowMs: number, spanMs = 180_000, stepMs = 10_000): number {
  if (ticks.length === 0) return 0;
  const start = Math.max(nowMs - spanMs, ticks[0]!.timeMs);
  const rets: number[] = [];
  let prev = priceAt(ticks, start);
  for (let t = start + stepMs; t <= nowMs; t += stepMs) {
    const cur = priceAt(ticks, t);
    rets.push(pct(prev, cur));
    prev = cur;
  }
  if (rets.length < 6) return 0;
  const ss = rets.reduce((acc, r) => acc + r * r, 0);
  return Math.sqrt(ss / rets.length) * Math.sqrt((60 * 1000) / stepMs);
}

/**
 * 窗口 [fromMs, toMs] 内的时间加权均价：tick 之间按「上一价一直有效」计权。
 * 窗口前最后一个价从 fromMs 起生效；窗口内外都没价回 null。
 */
export function twap(points: readonly Tick[], fromMs: number, toMs: number): number | null {
  if (points.length === 0 || toMs <= fromMs) return null;
  let weighted = 0;
  let covered = 0;
  let current: number | null = null;
  let segmentStart = fromMs;
  for (const p of points) {
    if (p.timeMs <= fromMs) {
      current = p.price;
      continue;
    }
    if (p.timeMs > toMs) break;
    if (current != null) {
      const dt = p.timeMs - segmentStart;
      weighted += current * dt;
      covered += dt;
    }
    current = p.price;
    segmentStart = p.timeMs;
  }
  if (current == null) return null;
  const dt = toMs - segmentStart;
  weighted += current * dt;
  covered += dt;
  return covered > 0 ? weighted / covered : current;
}
