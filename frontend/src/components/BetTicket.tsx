import { useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, type ApiClient } from '../api/client.ts';
import type { BuyPlan, Side } from '../api/types.ts';
import { ERROR_HINT } from '../api/types.ts';
import { fmtMoney, fmtNum, sideLabel, toCents } from '../lib/format.ts';

export interface BetTicketProps {
  client: ApiClient;
  side: Side;
  onSideChange: (side: Side) => void;
  /** 回合是否可交易（已封盘/未开盘都不行） */
  tradable: boolean;
  quoteStale: boolean;
  /** 游戏钱包余额，用于「上限」按钮与余额不足提示 */
  balance: number | null;
  onSubmitted: (message: string) => void;
}

const PRESETS = [10, 50, 100, 500, 1000];
const MAX_AMOUNT = 10_000;
/** 手续费相对本金最多 7%（价格趋近 0 时），按最坏情况留额度上限，绝不超扣 */
const WORST_FEE_RATIO = 1.07;

export function BetTicket({
  client,
  side,
  onSideChange,
  tradable,
  quoteStale,
  balance,
  onSubmitted,
}: BetTicketProps) {
  const [amount, setAmount] = useState('100');
  const [plan, setPlan] = useState<BuyPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const numericAmount = Number(amount);
  const amountValid =
    Number.isFinite(numericAmount) && numericAmount >= 1 && numericAmount <= MAX_AMOUNT;

  const seq = useRef(0);

  // 试算走后端：费率、取整、可用价位都以服务端为准，前端只负责显示
  useEffect(() => {
    if (!amountValid) {
      setPlan(null);
      setPlanError(null);
      return;
    }
    const ticket = ++seq.current;
    const timer = setTimeout(() => {
      void client
        .preview(side, numericAmount)
        .then((next) => {
          if (seq.current !== ticket) return;
          setPlan(next);
          setPlanError(null);
        })
        .catch((e: unknown) => {
          if (seq.current !== ticket) return;
          setPlan(null);
          const code = e instanceof ApiError ? e.code : 'INTERNAL_ERROR';
          setPlanError(ERROR_HINT[code] ?? (e instanceof Error ? e.message : '试算失败'));
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [client, side, numericAmount, amountValid]);

  const maxAmount = useMemo(() => {
    if (balance == null) return MAX_AMOUNT;
    // +1e-6 修掉 10.7/1.07 = 9.999999999999998 这类尾差，否则上限会莫名少一分钱
    const capped = Math.floor((balance / WORST_FEE_RATIO) * 100 + 1e-6) / 100;
    return Math.max(0, Math.min(MAX_AMOUNT, capped));
  }, [balance]);

  const disabled = !tradable || quoteStale || !amountValid || submitting;
  const disabledReason = !tradable
    ? '回合已封盘，等待结算'
    : quoteStale
      ? '盘口已超龄，稍后重试'
      : !amountValid
        ? '金额需在 1 ~ 10000 之间'
        : null;

  async function submit(): Promise<void> {
    if (disabled) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const bet = await client.buy(side, numericAmount);
      setFeedback({
        kind: 'ok',
        text: `已买入 ${fmtNum(bet.contracts, 4)} 份 ${sideLabel(side)}，成本 ${fmtMoney(bet.cost)}`,
      });
      onSubmitted('买入成功');
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'INTERNAL_ERROR';
      setFeedback({
        kind: 'error',
        text: ERROR_HINT[code] ?? (e instanceof Error ? e.message : '下单失败'),
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">下注</span>
        <div className="topbar-spacer" />
        <div className="row">
          <button
            type="button"
            className={`btn sm ${side === 'UP' ? 'buy-up' : ''}`}
            onClick={() => onSideChange('UP')}
            aria-pressed={side === 'UP'}
          >
            看涨
          </button>
          <button
            type="button"
            className={`btn sm ${side === 'DOWN' ? 'buy-down' : ''}`}
            onClick={() => onSideChange('DOWN')}
            aria-pressed={side === 'DOWN'}
          >
            看跌
          </button>
        </div>
      </div>

      <div className="card-body stack">
        <div className="field">
          <label htmlFor="bet-amount">金额（USDT）</label>
          <input
            id="bet-amount"
            className="input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="100"
          />
        </div>

        <div className="chips">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className="chip"
              onClick={() => setAmount(String(preset))}
            >
              {preset}
            </button>
          ))}
          <button
            type="button"
            className="chip"
            onClick={() => setAmount(maxAmount > 0 ? maxAmount.toFixed(2) : '0')}
          >
            上限
          </button>
        </div>

        <div className="divider" />

        {plan != null && (
          <dl className="kv">
            <dt>成交价（卖一）</dt>
            <dd className="num">{toCents(plan.price)}</dd>
            <dt>获得份数</dt>
            <dd className="num">{fmtNum(plan.contracts, 4)}</dd>
            <dt>合约成本</dt>
            <dd className="num">{fmtMoney(plan.cost)}</dd>
            <dt>吃单费</dt>
            <dd className="num">{fmtMoney(plan.fee, 4)}</dd>
            <dt>
              <b>共扣</b>
            </dt>
            <dd className="num">
              <b>{fmtMoney(plan.total)}</b>
            </dd>
            <dt>猜对回款</dt>
            <dd className="num up">{fmtMoney(plan.payout)}</dd>
            <dt>猜对净赚</dt>
            <dd className="num up">{fmtMoney(plan.payout - plan.total)}</dd>
          </dl>
        )}

        {plan == null && planError != null && <div className="notice warn">{planError}</div>}
        {plan == null && planError == null && amountValid && <div className="notice">试算中…</div>}

        {balance != null && (
          <div className="faint num" style={{ fontSize: 11 }}>
            游戏钱包余额 {fmtMoney(balance)}
          </div>
        )}

        <button
          type="button"
          className={`btn block ${side === 'UP' ? 'buy-up' : 'buy-down'}`}
          disabled={disabled}
          onClick={() => void submit()}
        >
          {submitting ? '提交中…' : `买入${sideLabel(side)}`}
        </button>

        {disabledReason != null && <div className="faint">{disabledReason}</div>}

        {feedback != null && (
          <div className={`notice ${feedback.kind === 'ok' ? '' : 'error'}`}>{feedback.text}</div>
        )}
      </div>
    </div>
  );
}
