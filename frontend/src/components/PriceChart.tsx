import { useMemo } from 'react';

import type { PricePoint } from '../api/types.ts';
import { fmtMoney, fmtTime } from '../lib/format.ts';

export interface PriceChartProps {
  points: readonly PricePoint[];
  /** 目标价：收盘价与它比较定涨跌，画一条虚线给用户对齐 */
  targetPrice?: number | null;
  height?: number;
}

const WIDTH = 600;
const PAD_Y = 8;

/**
 * 价格曲线（手写 SVG）。
 *
 * 不引图表库：这里只需要一条折线加一条目标线，图表库的体积和配置成本
 * 远大于这 30 行；而且标题里的数值要等宽对齐，自绘才好把文字放进同一个坐标系。
 */
export function PriceChart({ points, targetPrice = null, height = 96 }: PriceChartProps) {
  const model = useMemo(() => {
    const usable = points.filter((p) => Number.isFinite(p.price));
    if (usable.length < 2) return null;

    const prices = usable.map((p) => p.price);
    if (targetPrice != null && Number.isFinite(targetPrice)) prices.push(targetPrice);
    let min = Math.min(...prices);
    let max = Math.max(...prices);
    // 全部价格相同（或极窄区间）时给一点上下留白，否则线会贴在边上
    if (max - min < 1e-9) {
      min -= 1;
      max += 1;
    } else {
      const pad = (max - min) * 0.12;
      min -= pad;
      max += pad;
    }

    const t0 = usable[0]!.time;
    const t1 = usable[usable.length - 1]!.time;
    const span = Math.max(1, t1 - t0);
    const inner = height - PAD_Y * 2;

    const xy = (p: PricePoint): [number, number] => [
      ((p.time - t0) / span) * WIDTH,
      PAD_Y + (1 - (p.price - min) / (max - min)) * inner,
    ];

    const coords = usable.map(xy);
    const last = coords[coords.length - 1]!;
    const targetY =
      targetPrice != null && Number.isFinite(targetPrice)
        ? PAD_Y + (1 - (targetPrice - min) / (max - min)) * inner
        : null;

    return {
      path: coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' '),
      area: `${coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} ${WIDTH},${height} 0,${height}`,
      last,
      targetY,
      rising: usable[usable.length - 1]!.price >= usable[0]!.price,
      first: usable[0]!,
      finalPrice: usable[usable.length - 1]!.price,
    };
  }, [points, targetPrice, height]);

  if (model == null) {
    return <div className="empty">等待价格数据…</div>;
  }

  const stroke = model.rising ? 'var(--up)' : 'var(--down)';
  const gradientId = 'wiib-chart-fill';

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 6 }}>
        <span className="num" style={{ fontSize: 18, fontWeight: 700 }}>
          {fmtMoney(model.finalPrice)}
        </span>
        <span className="faint num" style={{ fontSize: 11 }}>
          {fmtTime(model.first.time / 1000)} 起
        </span>
      </div>
      <svg
        className="chart"
        viewBox={`0 0 ${WIDTH} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="BTC 近期价格曲线"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.18" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>

        <polygon points={model.area} fill={`url(#${gradientId})`} />

        {model.targetY != null && (
          <line
            x1="0"
            x2={WIDTH}
            y1={model.targetY}
            y2={model.targetY}
            stroke="var(--fg-faint)"
            strokeWidth="1"
            strokeDasharray="4 4"
            data-testid="target-line"
          />
        )}

        <path d={model.path} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" />

        <circle cx={model.last[0]} cy={model.last[1]} r="2.6" fill={stroke} />
      </svg>
      {targetPrice != null && (
        <div className="faint num" style={{ fontSize: 11, textAlign: 'right' }}>
          目标价 {fmtMoney(targetPrice)}（虚线）
        </div>
      )}
    </div>
  );
}
