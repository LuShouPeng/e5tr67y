import { useState } from 'react';

import { createApiClient, type ApiClient } from './api/client.ts';
import type { Side } from './api/types.ts';
import { ERROR_HINT } from './api/types.ts';
import { OddsBoard } from './components/OddsBoard.tsx';
import { RoundPanel } from './components/RoundPanel.tsx';
import { usePredictionMarket } from './hooks/usePredictionMarket.ts';
import { fmtCountdown, fmtWindow } from './lib/format.ts';

export interface AppProps {
  /** 测试注入：默认用真实 fetch 与同源 /api */
  client?: ApiClient;
}

const defaultClient = createApiClient();

export function App({ client = defaultClient }: AppProps) {
  const [pick, setPick] = useState<Side>('UP');
  const market = usePredictionMarket(client);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          BTC 5 分钟涨跌预测
          <small>Polymarket 实时概率</small>
        </div>
        <div className="topbar-spacer" />
        {market.round != null && (
          <>
            <span className="badge num">回合 {fmtWindow(market.round.windowStart)}</span>
            <span className={`badge num ${market.round.status === 'OPEN' ? 'live' : 'locked'}`}>
              <i className="dot pulse" />
              {market.round.status === 'OPEN' ? '可交易' : '已封盘'}
            </span>
            <span className="badge num">剩余 {fmtCountdown(market.countdown)}</span>
          </>
        )}
      </header>

      <main className="main">
        <section className="col">
          <RoundPanel
            round={market.round}
            countdown={market.countdown}
            clockOffsetMs={market.clockOffsetMs}
            priceHistory={market.priceHistory}
            degraded={market.degraded}
            onRefresh={() => void market.refresh()}
          />

          <div className="card">
            <div className="card-head">
              <span className="card-title">赔率盘口</span>
              {market.quoteStale && market.quote != null && (
                <span className="badge degraded">旧价</span>
              )}
            </div>
            <div className="card-body">
              <OddsBoard quote={market.quote} stale={market.quoteStale} onPick={setPick} />
            </div>
          </div>
        </section>

        <section className="col">
          {market.error != null && (
            <div className="notice error">
              {ERROR_HINT[market.error.code] ?? market.error.message}
              <button
                type="button"
                className="btn sm"
                style={{ marginLeft: 10 }}
                onClick={() => void market.refresh()}
              >
                重试
              </button>
            </div>
          )}

          <div className="card">
            <div className="card-head">
              <span className="card-title">下注</span>
              <div className="topbar-spacer" />
              <span className="badge">当前选择 {pick === 'UP' ? '看涨' : '看跌'}</span>
            </div>
            <div className="card-body muted">下注面板将在下一个迭代接入（S2-3）。</div>
          </div>

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
