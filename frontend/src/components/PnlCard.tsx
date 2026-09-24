import { useEffect, useState } from 'react';

import { ApiError, type ApiClient } from '../api/client.ts';
import type { PnlView } from '../api/types.ts';
import { ERROR_HINT } from '../api/types.ts';
import { fmtMoney, fmtNum, fmtSigned, trendClass } from '../lib/format.ts';

export interface PnlCardProps {
  client: ApiClient;
  refreshKey: number;
  /** 上层已经取到的余额，避免重复请求 */
  balance?: number | null;
}

/**
 * 盈亏统计：把「已实现」与「未实现」分开摆。
 * 两者混成一个「总盈亏」会让人以为钱已经到手，而持仓只是按盘口估的值。
 */
export function PnlCard({ client, refreshKey, balance = null }: PnlCardProps) {
  const [data, setData] = useState<PnlView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void client
      .pnl()
      .then((next) => {
        if (!alive) return;
        setData(next);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const code = e instanceof ApiError ? e.code : 'INTERNAL_ERROR';
        setError(ERROR_HINT[code] ?? (e instanceof Error ? e.message : '加载失败'));
      });
    return () => {
      alive = false;
    };
  }, [client, refreshKey]);

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">我的成绩</span>
        <div className="topbar-spacer" />
        {data != null && (
          <span className="faint num" style={{ fontSize: 11 }}>
            {data.settledBets} 笔已了结
          </span>
        )}
      </div>

      <div className="card-body">
        {error != null && <div className="notice error">{error}</div>}
        {data == null && error == null && <div className="empty">统计中…</div>}

        {data != null && (
          <div className="stack">
            <div className="stats">
              <div className="stat">
                <span className="label">总盈亏</span>
                <span className={`value num ${trendClass(data.totalPnl)}`}>
                  {fmtSigned(data.totalPnl)}
                </span>
              </div>
              <div className="stat">
                <span className="label">已实现</span>
                <span className={`value num ${trendClass(data.realizedPnl)}`}>
                  {fmtSigned(data.realizedPnl)}
                </span>
              </div>
              <div className="stat">
                <span className="label">未实现</span>
                <span className={`value num ${trendClass(data.unrealizedPnl)}`}>
                  {fmtSigned(data.unrealizedPnl)}
                </span>
              </div>
              <div className="stat">
                <span className="label">胜率</span>
                <span className="value num">{fmtNum(data.winRate, 2)}%</span>
              </div>
            </div>

            <dl className="kv">
              <dt>累计投入</dt>
              <dd className="num">{fmtMoney(data.totalCost)}</dd>
              <dt>持仓成本 / 现值</dt>
              <dd className="num">
                {fmtMoney(data.activeCost)} / {fmtMoney(data.activeValue)}
              </dd>
              <dt>游戏钱包余额</dt>
              <dd className="num">{fmtMoney(balance ?? data.gameBalance)}</dd>
              <dt>
                <b>总权益</b>
              </dt>
              <dd className="num">
                <b>{fmtMoney(data.equity)}</b>
              </dd>
              <dt>战绩</dt>
              <dd className="num">
                <span className="up">{data.wonBets} 猜对</span>
                {' · '}
                <span className="down">{data.lostBets} 猜错</span>
                {' · '}
                <span className="muted">{data.soldBets} 卖出</span>
                {data.voidBets > 0 && (
                  <>
                    {' · '}
                    <span className="muted">{data.voidBets} 作废</span>
                  </>
                )}
              </dd>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
