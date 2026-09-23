import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ApiClient } from '../api/client.ts';
import type { LiveBetView, QuoteBook, RoundView } from '../api/types.ts';
import {
  computeClockOffset,
  isQuoteStale,
  marketEventToQuote,
  remainingSeconds,
  trimHistory,
  WINDOW_SECONDS,
} from '../lib/market.ts';

const MAX_ACTIVITIES = 30;
/** 价格曲线只画最近 5 分钟 */
const HISTORY_KEEP_MS = WINDOW_SECONDS * 1000;
/** 价格序列靠轮询补齐（SSE 只推盘口与成交流） */
const HISTORY_POLL_MS = 5000;

export interface MarketError {
  code: string;
  message: string;
}

export interface PredictionMarket {
  round: RoundView | null;
  quote: QuoteBook | null;
  /** 本回合剩余秒数（按服务端校准后的时钟） */
  countdown: number;
  /** 服务端与本机的时钟差，毫秒 */
  clockOffsetMs: number;
  priceHistory: { time: number; price: number }[];
  activities: LiveBetView[];
  /** 盘口是否已超龄（超龄时不该下单） */
  quoteStale: boolean;
  /** 行情是否来自降级模式（本地模拟） */
  degraded: boolean;
  error: MarketError | null;
  refresh(): Promise<void>;
}

/**
 * 盘口与回合的订阅中心：SSE 推什么就用什么，只在窗口切换时补一次 REST。
 *
 * 倒计时不跟着推送走，而是每秒按「服务端校准时钟」自己算：
 * 推送可能丢、可能迟，但 5 分钟一局的倒计时不能有任何一秒是靠别人喂的。
 */
export function usePredictionMarket(client: ApiClient): PredictionMarket {
  const [round, setRound] = useState<RoundView | null>(null);
  const [quote, setQuote] = useState<QuoteBook | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [priceHistory, setPriceHistory] = useState<{ time: number; price: number }[]>([]);
  const [activities, setActivities] = useState<LiveBetView[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [error, setError] = useState<MarketError | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const windowStartRef = useRef<number | null>(null);

  const applyRound = useCallback((next: RoundView) => {
    if (Number.isFinite(next.serverTimeMs) && next.serverTimeMs > 0) {
      setClockOffsetMs(computeClockOffset(next.serverTimeMs, Date.now()));
    }
    windowStartRef.current = next.windowStart;
    setRound(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await client.current();
      applyRound(data.round);
      if (data.quote != null) setQuote(data.quote);
      setError(null);
    } catch (e) {
      setError({
        code: (e as { code?: string }).code ?? 'INTERNAL_ERROR',
        message: e instanceof Error ? e.message : '加载失败',
      });
    }
  }, [client, applyRound]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 价格序列：开盘时补一次，之后定期对齐（后端已按窗口裁剪）
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void client
        .priceHistory()
        .then((data) => {
          if (alive) setPriceHistory(data.points);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, HISTORY_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client]);

  useEffect(() => {
    return client.stream({
      onRound: (next) => {
        const known = windowStartRef.current;
        // 旧回合的结算推送不覆盖当前回合，只补拉一次让页面刷新
        if (known != null && next.windowStart < known) {
          void refresh();
          return;
        }
        applyRound(next);
      },
      onMarket: (event) => {
        setQuote(marketEventToQuote(event));
        setDegraded(event.degraded === true);
      },
      onActivity: (activity) => {
        setActivities((prev) => [activity, ...prev].slice(0, MAX_ACTIVITIES));
      },
      onError: () =>
        setError({ code: 'STREAM_DOWN', message: '实时连接中断，正在重连' }),
    });
  }, [client, applyRound, refresh]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  /**
   * 倒计时按「当前」时间算，不用 state 里那份每秒采样一次的快照：
   * 快照最多会滞后一秒，倒计时就会出现 +1 秒的假象。
   * 心跳只负责触发重渲染，数值本身始终读最新时钟。
   */
  const countdown = useMemo(
    () => (round == null ? 0 : remainingSeconds(round.windowStart, Date.now(), clockOffsetMs)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nowMs 仅用于驱动每秒重算
    [round, nowMs, clockOffsetMs],
  );

  // 回合走完的瞬间补拉一次：新窗口的回合与目标价都在后端
  const rolledRef = useRef(0);
  useEffect(() => {
    if (round == null || countdown > 0) return;
    if (rolledRef.current === round.windowStart) return;
    rolledRef.current = round.windowStart;
    void refresh();
  }, [countdown, round, refresh]);

  const visibleHistory = useMemo(
    () => trimHistory(priceHistory, nowMs, HISTORY_KEEP_MS),
    [priceHistory, nowMs],
  );

  return {
    round,
    quote,
    countdown,
    clockOffsetMs,
    priceHistory: visibleHistory,
    activities,
    // 用校准后的时钟判新旧：盘口时间戳来自服务端，比本机钟可能超前
    quoteStale: isQuoteStale(quote, Date.now() + clockOffsetMs),
    degraded,
    error,
    refresh,
  };
}
