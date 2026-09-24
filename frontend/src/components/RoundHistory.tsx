import { useCallback, useEffect, useState } from 'react';

import { ApiError, type ApiClient } from '../api/client.ts';
import type { RoundView } from '../api/types.ts';
import { ERROR_HINT } from '../api/types.ts';
import { fmtMoney, fmtWindow, outcomeLabel, roundStatusLabel } from '../lib/format.ts';

export interface RoundHistoryProps {
  client: ApiClient;
  refreshKey: number;
}

const PAGE_SIZE = 8;

/**
 * 往期回合：把「目标价 → 结算价」并排放，用户一眼能核对判涨跌的依据。
 * 只列已结算的回合——还在走的回合没有结论，混在一起只会让人误读。
 */
export function RoundHistory({ client, refreshKey }: RoundHistoryProps) {
  const [rows, setRows] = useState<RoundView[]>([]);
  const [total, setTotal] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (page: number) => {
      setLoading(true);
      try {
        const result = await client.rounds(page, PAGE_SIZE);
        setRows(result.rows);
        setTotal(result.total);
        setError(null);
      } catch (e) {
        const code = e instanceof ApiError ? e.code : 'INTERNAL_ERROR';
        setError(ERROR_HINT[code] ?? (e instanceof Error ? e.message : '加载失败'));
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void load(pageNum);
  }, [load, pageNum, refreshKey]);

  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">往期回合</span>
        <div className="topbar-spacer" />
        <span className="faint num" style={{ fontSize: 11 }}>
          共 {total} 回合
        </span>
      </div>

      <div className="card-body">
        {loading && <div className="empty">加载中…</div>}
        {!loading && error != null && <div className="notice error">{error}</div>}
        {!loading && error == null && rows.length === 0 && (
          <div className="empty">还没有已结算的回合</div>
        )}

        {rows.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>窗口</th>
                <th>目标价</th>
                <th>结算价</th>
                <th>结果</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((round) => (
                <tr key={round.id}>
                  <td className="num">{fmtWindow(round.windowStart)}</td>
                  <td className="num">{round.startPrice == null ? '--' : fmtMoney(round.startPrice)}</td>
                  <td className="num">{round.endPrice == null ? '--' : fmtMoney(round.endPrice)}</td>
                  <td
                    className={
                      round.outcome === 'UP' ? 'up' : round.outcome === 'DOWN' ? 'down' : 'muted'
                    }
                  >
                    <b>{outcomeLabel(round.outcome)}</b>
                  </td>
                  <td>{roundStatusLabel(round.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {maxPage > 1 && (
          <div className="row-between" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn sm"
              disabled={pageNum <= 1}
              onClick={() => setPageNum((n) => Math.max(1, n - 1))}
            >
              上一页
            </button>
            <span className="faint num" style={{ fontSize: 11 }}>
              {pageNum} / {maxPage}
            </span>
            <button
              type="button"
              className="btn sm"
              disabled={pageNum >= maxPage}
              onClick={() => setPageNum((n) => Math.min(maxPage, n + 1))}
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
