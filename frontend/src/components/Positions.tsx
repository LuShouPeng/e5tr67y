import { useCallback, useEffect, useState } from 'react';

import { ApiError, type ApiClient } from '../api/client.ts';
import type { BetView, Side } from '../api/types.ts';
import { ERROR_HINT } from '../api/types.ts';
import {
  betStatusLabel,
  fmtMoney,
  fmtNum,
  fmtSigned,
  fmtWindow,
  sideLabel,
  toCents,
  trendClass,
} from '../lib/format.ts';

export interface PositionsProps {
  client: ApiClient;
  /** 变化时重新拉一次（下单/结算后由上层递增） */
  refreshKey: number;
  /** 当前回合起点：只有这一回合的持仓在盘口有效期内卖得掉 */
  currentWindowStart: number | null;
  onChanged: () => void;
}

const PAGE_SIZE = 8;

export function Positions({ client, refreshKey, currentWindowStart, onChanged }: PositionsProps) {
  const [rows, setRows] = useState<BetView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await client.bets(1, PAGE_SIZE);
      setRows(page.rows);
      setError(null);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'INTERNAL_ERROR';
      setError(ERROR_HINT[code] ?? (e instanceof Error ? e.message : '加载失败'));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function sell(bet: BetView): Promise<void> {
    setBusyId(bet.id);
    setFeedback(null);
    try {
      const partial = currentSellRatio(bet);
      const sold = await client.sell(bet.id, partial);
      setFeedback(
        `已卖出 ${fmtNum(sold.contracts, 4)} 份 ${sideLabel(bet.side)}，到手 ${fmtMoney(sold.payout ?? 0)}`,
      );
      await load();
      onChanged();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'INTERNAL_ERROR';
      setFeedback(ERROR_HINT[code] ?? (e instanceof Error ? e.message : '卖出失败'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">我的持仓</span>
        <div className="topbar-spacer" />
        <button type="button" className="btn sm" onClick={() => void load()}>
          刷新
        </button>
      </div>

      <div className="card-body">
        {loading && <div className="empty">加载中…</div>}
        {!loading && error != null && <div className="notice error">{error}</div>}
        {!loading && error == null && rows.length === 0 && (
          <div className="empty">还没有下过注，先在右侧下注面板试一手</div>
        )}

        {rows.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>方向</th>
                <th>份数</th>
                <th>均价</th>
                <th>成本</th>
                <th>当前</th>
                <th>盈亏</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((bet) => {
                const value = bet.currentValue ?? bet.payout ?? bet.cost;
                const pnl = value - bet.cost;
                const sellable = bet.status === 'ACTIVE' && bet.windowStart === currentWindowStart;
                return (
                  <tr key={bet.id}>
                    <td className={bet.side === 'UP' ? 'up' : 'down'}>
                      <b>{sideLabel(bet.side)}</b>
                    </td>
                    <td className="num">{fmtNum(bet.contracts, 4)}</td>
                    <td className="num">{toCents(bet.avgPrice)}</td>
                    <td className="num">{fmtMoney(bet.cost)}</td>
                    <td className="num">{fmtMoney(value)}</td>
                    <td className={`num ${trendClass(pnl)}`}>{fmtSigned(pnl)}</td>
                    <td>{betStatusLabel(bet.status)}</td>
                    <td>
                      {sellable ? (
                        <button
                          type="button"
                          className="btn sm"
                          disabled={busyId === bet.id}
                          onClick={() => void sell(bet)}
                        >
                          {busyId === bet.id ? '卖出中…' : '卖出'}
                        </button>
                      ) : (
                        <span className="faint">{bet.status === 'ACTIVE' ? '非本回合' : '—'}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {feedback != null && (
          <div className="notice" style={{ marginTop: 10 }}>
            {feedback}
          </div>
        )}
      </div>
    </div>
  );
}

/** 卖一半：至少留 0.0001 份，避免卖出后剩下的份额被舍成 0 */
function currentSellRatio(bet: BetView): number | undefined {
  const half = Math.floor((bet.contracts / 2) * 10_000) / 10_000;
  return half > 0 && half < bet.contracts ? half : undefined;
}

export type { Side };
