import type { RoundView } from '../api/types.ts';
import { fmtCountdown, fmtMoney, fmtWindow } from '../lib/format.ts';
import { elapsedRatio } from '../lib/market.ts';
import { PriceChart } from './PriceChart.tsx';

export interface RoundPanelProps {
  round: RoundView | null;
  countdown: number;
  clockOffsetMs: number;
  priceHistory: { time: number; price: number }[];
  degraded?: boolean;
  onRefresh?: () => void;
}

/**
 * 回合主面板：目标价（判涨跌的基准）、倒计时、价格曲线。
 * 目标价是这条曲线的参照系——曲线本身不解释输赢，与目标价的关系才解释。
 */
export function RoundPanel({
  round,
  countdown,
  clockOffsetMs,
  priceHistory,
  degraded = false,
  onRefresh,
}: RoundPanelProps) {
  const latest = priceHistory.length > 0 ? priceHistory[priceHistory.length - 1]!.price : null;
  const target = round?.startPrice ?? null;
  const diff = latest != null && target != null ? latest - target : null;
  const diffPct = diff != null && target != null && target !== 0 ? (diff / target) * 100 : null;

  // elapsedRatio 自己会加上时钟差，这里传本机时间即可（不可先加一次再传）
  const ratio = round == null ? 0 : elapsedRatio(round.windowStart, Date.now(), clockOffsetMs);

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">本回合</span>
        <span className="badge num">{round == null ? '--:--' : fmtWindow(round.windowStart)}</span>
        {degraded && <span className="badge degraded">本地模拟行情</span>}
        <div className="topbar-spacer" />
        <span className="badge num" data-testid="countdown">
          {/* 没有回合时是「未知」而不是 00:00 —— 后者会被读成「刚好结束」 */}
          剩余 {round == null ? '--:--' : fmtCountdown(countdown)}
        </span>
        {onRefresh != null && (
          <button type="button" className="btn sm" onClick={onRefresh}>
            刷新
          </button>
        )}
      </div>

      <div className="card-body stack">
        <div className="ticker">
          <div className="grow">
            <div className="faint" style={{ fontSize: 11 }}>
              当前 BTC（Chainlink 60 秒 TWAP 口径）
            </div>
            <div className="price num">{fmtMoney(latest)}</div>
          </div>
          <div className="stat">
            <span className="label">目标价</span>
            <span className="value num">{target == null ? '获取中' : fmtMoney(target)}</span>
          </div>
          <div className="stat">
            <span className="label">距目标</span>
            <span className={`value num ${diff == null ? 'muted' : diff >= 0 ? 'up' : 'down'}`}>
              {diff == null ? '--' : `${diff >= 0 ? '+' : ''}${fmtMoney(diff)}`}
            </span>
            <span className="faint num" style={{ fontSize: 10 }}>
              {diffPct == null ? '--' : `${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(3)}%`}
            </span>
          </div>
        </div>

        <div className="timer" aria-hidden="true">
          <i style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
        </div>

        <PriceChart points={priceHistory} targetPrice={target} />
      </div>
    </div>
  );
}
