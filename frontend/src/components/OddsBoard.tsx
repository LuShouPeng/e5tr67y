import type { QuoteBook } from '../api/types.ts';
import { toCents } from '../lib/format.ts';
import { impliedUpProbability } from '../lib/market.ts';

export interface OddsBoardProps {
  quote: QuoteBook | null;
  stale?: boolean;
  /** 点击某一侧直接带入下注方向 */
  onPick?: (side: 'UP' | 'DOWN') => void;
}

/**
 * 赔率盘口：概率价按美分显示（Polymarket 的习惯）。
 * 50¢ = 市场认为五成概率；价格越高代表越看好那一边。
 */
export function OddsBoard({ quote, stale = false, onPick }: OddsBoardProps) {
  const upProb = impliedUpProbability(quote);
  const downProb = upProb == null ? null : 1 - upProb;

  return (
    <div className="stack">
      <div className="odds">
        <SideCard
          kind="up"
          name="看涨 UP"
          probability={upProb}
          label="涨"
          level={quote?.up ?? null}
          onPick={onPick}
        />
        <SideCard
          kind="down"
          name="看跌 DOWN"
          probability={downProb}
          label="跌"
          level={quote?.down ?? null}
          onPick={onPick}
        />
      </div>

      {quote == null && <div className="notice">暂无报价，等行情接入</div>}
      {quote != null && stale && (
        <div className="notice warn">盘口已超过 15 秒未更新，此时下单会被后端拒绝</div>
      )}
    </div>
  );
}

function SideCard({
  kind,
  name,
  probability,
  label,
  level,
  onPick,
}: {
  kind: 'up' | 'down';
  name: string;
  probability: number | null;
  label: string;
  level: { bid: number | null; ask: number | null } | null;
  onPick?: (side: 'UP' | 'DOWN') => void;
}) {
  const side = kind === 'up' ? 'UP' : 'DOWN';
  const hasBid = level?.bid != null;
  const hasAsk = level?.ask != null;

  return (
    <div className={`odds-side ${kind}`}>
      <div className="row-between">
        <span className="name">{name}</span>
        {onPick != null && (
          <button type="button" className="btn sm" onClick={() => onPick(side)}>
            下注{label}
          </button>
        )}
      </div>

      <div className="mid num">{probability == null ? '--' : toCents(probability)}</div>

      <div className="pair">
        买一 <b>{hasBid ? toCents(level?.bid) : '空'}</b>
        {' · '}
        卖一 <b>{hasAsk ? toCents(level?.ask) : '空'}</b>
      </div>
    </div>
  );
}
