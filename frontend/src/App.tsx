import { useCallback, useEffect, useState } from 'react';

import { createApiClient, type ApiClient } from './api/client.ts';
import type { CurrentResponse } from './api/types.ts';
import { ERROR_HINT } from './api/types.ts';
import { fmtCountdown, fmtMoney, fmtWindow } from './lib/format.ts';

export interface AppProps {
  /** 测试注入：默认用真实 fetch 与同源 /api */
  client?: ApiClient;
}

const defaultClient = createApiClient();

export function App({ client = defaultClient }: AppProps) {
  const [state, setState] = useState<{
    data: CurrentResponse | null;
    error: string | null;
    loading: boolean;
  }>({ data: null, error: null, loading: true });

  const load = useCallback(async () => {
    try {
      const data = await client.current();
      setState({ data, error: null, loading: false });
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'INTERNAL_ERROR';
      setState({ data: null, error: ERROR_HINT[code] ?? '加载失败，请稍后重试', loading: false });
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const round = state.data?.round ?? null;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          BTC 5 分钟涨跌预测
          <small>Polymarket 实时概率</small>
        </div>
        <div className="topbar-spacer" />
        {round != null && (
          <>
            <span className="badge num">回合 {fmtWindow(round.windowStart)}</span>
            <span className={`badge num ${round.status === 'OPEN' ? 'live' : 'locked'}`}>
              <i className="dot pulse" />
              {round.status === 'OPEN' ? '可交易' : '已封盘'}
            </span>
            <span className="badge num">剩余 {fmtCountdown(round.remainingSeconds)}</span>
          </>
        )}
      </header>

      <main className="main">
        <section className="col">
          <div className="card">
            <div className="card-head">
              <span className="card-title">回合状态</span>
            </div>
            <div className="card-body">
              {state.loading && <p className="muted">正在读取回合…</p>}
              {state.error != null && (
                <p className="down">
                  {state.error}
                  <button type="button" className="badge" onClick={() => void load()} style={{ marginLeft: 10 }}>
                    重试
                  </button>
                </p>
              )}
              {round != null && (
                <dl className="kv">
                  <dt>窗口</dt>
                  <dd className="num">{fmtWindow(round.windowStart)}</dd>
                  <dt>目标价</dt>
                  <dd className="num">
                    {round.startPrice == null ? '获取中' : fmtMoney(round.startPrice)}
                  </dd>
                  <dt>结果</dt>
                  <dd className="num">{round.outcome ?? '待定'}</dd>
                  <dt>盘口</dt>
                  <dd className="num">
                    {state.data?.quote == null
                      ? '暂无报价'
                      : `涨 ${state.data.quote.up.ask ?? '--'} / 跌 ${state.data.quote.down.ask ?? '--'}`}
                  </dd>
                </dl>
              )}
            </div>
          </div>
        </section>

        <section className="col">
          <div className="card">
            <div className="card-head">
              <span className="card-title">玩法说明</span>
            </div>
            <div className="card-body muted">
              <p style={{ marginTop: 0 }}>
                每 5 分钟一回合，预测 BTC 收盘的 Chainlink 60 秒 TWAP 是否 <b>不低于</b> 开盘时的
                TWAP：不低于算涨（相等也算涨），否则算跌。每份合约猜对兑付 $1。
              </p>
              <p style={{ marginBottom: 0 }}>
                吃单费按 Polymarket 口径：<span className="num">份数 × 7% × 价格 × (1 − 价格)</span>，
                50¢ 时最贵（每份 1.75¢），越接近 0/1 越便宜。
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
