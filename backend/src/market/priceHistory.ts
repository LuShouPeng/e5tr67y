export interface PricePoint {
  /** 毫秒时间戳 */
  time: number;
  price: number;
}

export interface PriceHistory {
  push(timeMs: number, price: number): void;
  /** 取 `fromMs` 之后的点（含端点） */
  since(fromMs: number): PricePoint[];
  latest(): PricePoint | null;
  size(): number;
}

/**
 * 定长环形缓冲的价格序列，供页面画最近一段的曲线。
 * 满了就从头覆盖：内存占用恒定，不需要任何清理任务。
 */
export function createPriceHistory(windowMs = 300_000, maxPoints = 1024): PriceHistory {
  const points: PricePoint[] = [];

  function trim(nowMs: number): void {
    const cutoff = nowMs - windowMs;
    let drop = 0;
    while (drop < points.length && points[drop]!.time < cutoff) drop++;
    if (drop > 0) points.splice(0, drop);
  }

  return {
    push(timeMs, price) {
      if (!Number.isFinite(timeMs) || !Number.isFinite(price)) return;
      const last = points[points.length - 1];
      if (last && last.time === timeMs) {
        points[points.length - 1] = { time: timeMs, price };
        return;
      }
      if (last && timeMs < last.time) return; // 乱序点丢弃，曲线不能回折
      points.push({ time: timeMs, price });
      if (points.length > maxPoints) points.splice(0, points.length - maxPoints);
      trim(timeMs);
    },
    since(fromMs) {
      return points.filter((p) => p.time >= fromMs);
    },
    latest() {
      return points.length > 0 ? points[points.length - 1]! : null;
    },
    size: () => points.length,
  };
}
