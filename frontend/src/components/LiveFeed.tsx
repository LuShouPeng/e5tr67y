import { useEffect, useState } from 'react';

import type { ApiClient } from '../api/client.ts';
import type { LiveBetView } from '../api/types.ts';
import { fmtAgo, fmtMoney, sideLabel } from '../lib/format.ts';
import { mergeActivities } from '../lib/market.ts';

export interface LiveFeedProps {
  client: ApiClient;
  /** SSE 实时推来的成交（最新的在最前） */
  activities: LiveBetView[];
  refreshKey: number;
}

const MAX_ROWS = 20;

/**
 * 全站成交流：SSE 管「之后发生的」，REST 补「进页面之前发生的」。
 * 两路合起来去重，用户看到的是连续的一条流，而不是从自己打开页面才开始。
 */
export function LiveFeed({ client, activities, refreshKey }: LiveFeedProps) {
  const [seed, setSeed] = useState<LiveBetView[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    void client
      .live()
      .then((data) => {
        if (alive) setSeed(data.rows);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [client, refreshKey]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const rows = mergeActivities(activities, seed, MAX_ROWS);

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">实时成交流</span>
        <i className="dot pulse" style={{ color: 'var(--up)' }} />
        <div className="topbar-spacer" />
        <span className="faint num" style={{ fontSize: 11 }}>
          {rows.length} 笔
        </span>
      </div>

      <div className="card-body">
        {rows.length === 0 ? (
          <div className="empty">还没有人下注，做第一个</div>
        ) : (
          <div className="feed">
            {rows.map((row, index) => (
              <div className="feed-row" key={`${row.ts}-${row.username}-${index}`}>
                <span
                  className={`badge ${row.side === 'UP' ? 'live' : ''}`}
                  style={
                    row.side === 'DOWN'
                      ? { color: 'var(--down)', background: 'var(--down-soft)' }
                      : undefined
                  }
                >
                  {sideLabel(row.side)}
                </span>
                <span className="who muted">{row.username || '匿名'}</span>
                <span className="num">{fmtMoney(row.amount)}</span>
                <span className="faint num" style={{ fontSize: 11, minWidth: 52, textAlign: 'right' }}>
                  {fmtAgo(row.ts, nowMs)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
