import type { Kline } from '../strategy/model.ts';
import type { WsFactory, WsLike } from './chainlinkStream.ts';

/**
 * Binance 公开行情：给策略补上 Polymarket 自己不提供的东西。
 * - 1m K 线：近一小时的典型波动，随机游走模型的 σ 从这里来；
 * - 逐笔成交（aggTrades）：最近 60 秒主动买卖、大单方向、10/30 秒涨跌；
 * - 合约强平流（forceOrder，可选）：开盘以来多空谁在被强平。
 *
 * 现货接口默认走 `data-api.binance.vision`（Binance 官方的公开行情只读镜像），可用 BINANCE_API_BASE 改。
 */

export const DEFAULT_BINANCE_API = 'https://data-api.binance.vision';
export const BINANCE_FUTURES_WS = 'wss://fstream.binance.com/ws/btcusdt@forceOrder';
const SYMBOL = 'BTCUSDT';
/** 大单阈值（USDT），与上游一致 */
export const LARGE_TRADE_USDT = 50_000;

export type JsonFetch = (url: string) => Promise<unknown>;

async function defaultJsonFetch(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  timer.unref?.();
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (res.status !== 200) throw new Error(`Binance 返回 ${res.status}：${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export interface AggTrade {
  timeMs: number;
  price: number;
  qty: number;
  /** true = 主动卖（买方是挂单方） */
  buyerIsMaker: boolean;
}

export interface FlowMetrics {
  tradeCount: number;
  /** [-1,1]：(主动买额 − 主动卖额) / 总额 */
  tradeDelta: number;
  /** [-1,1]：大单方向偏差，没大单为 0 */
  largeTradeBias: number;
  totalUsdt: number;
  /** 最近 10 / 30 秒的涨跌（美元）；数据盖不住为 null */
  move10: number | null;
  move30: number | null;
  lastTradeMs: number;
}

export interface Liquidation {
  timeMs: number;
  /** SELL = 多头被强平，BUY = 空头被强平 */
  side: 'BUY' | 'SELL';
  usdt: number;
}

export function parseKlines(json: unknown): Kline[] {
  if (!Array.isArray(json)) return [];
  const out: Kline[] = [];
  for (const row of json) {
    if (!Array.isArray(row)) continue;
    const openTimeMs = Number(row[0]);
    const close = Number(row[4]);
    if (Number.isFinite(openTimeMs) && Number.isFinite(close) && close > 0) out.push({ openTimeMs, close });
  }
  return out;
}

export function parseAggTrades(json: unknown): AggTrade[] {
  if (!Array.isArray(json)) return [];
  const out: AggTrade[] = [];
  for (const raw of json) {
    const t = raw as Record<string, unknown>;
    const price = Number(t.p);
    const qty = Number(t.q);
    const timeMs = Number(t.T);
    if (!(price > 0) || !(qty > 0) || !Number.isFinite(timeMs)) continue;
    out.push({ timeMs, price, qty, buyerIsMaker: t.m === true });
  }
  return out.sort((a, b) => a.timeMs - b.timeMs);
}

function priceBefore(trades: readonly AggTrade[], t: number): number | null {
  let price: number | null = null;
  for (const tr of trades) {
    if (tr.timeMs > t) break;
    price = tr.price;
  }
  return price;
}

/**
 * 最近 windowMs 的主动买卖与大单。
 * trades 必须**从窗口开始之前**就有数据：最早一笔已经在窗口里，说明窗口前半段根本没拿到
 * （REST 只给最新 1000 笔，行情快时只够十几秒），这时回 null，宁可不说也不把十几秒说成「最近一分钟」。
 */
export function flowMetrics(trades: readonly AggTrade[], nowMs: number, windowMs = 60_000): FlowMetrics | null {
  if (trades.length === 0 || trades[0]!.timeMs > nowMs - windowMs) return null;
  const inWindow = trades.filter((t) => t.timeMs > nowMs - windowMs && t.timeMs <= nowMs);
  if (inWindow.length === 0) return null;
  let buy = 0;
  let sell = 0;
  let largeBuy = 0;
  let largeSell = 0;
  for (const t of inWindow) {
    const usdt = t.price * t.qty;
    if (t.buyerIsMaker) {
      sell += usdt;
      if (usdt > LARGE_TRADE_USDT) largeSell += usdt;
    } else {
      buy += usdt;
      if (usdt > LARGE_TRADE_USDT) largeBuy += usdt;
    }
  }
  const total = buy + sell;
  const largeTotal = largeBuy + largeSell;
  const last = inWindow[inWindow.length - 1]!;
  const p10 = priceBefore(trades, nowMs - 10_000);
  const p30 = priceBefore(trades, nowMs - 30_000);
  return {
    tradeCount: inWindow.length,
    tradeDelta: total > 0 ? (buy - sell) / total : 0,
    largeTradeBias: largeTotal > 0 ? (largeBuy - largeSell) / largeTotal : 0,
    totalUsdt: total,
    move10: p10 == null ? null : last.price - p10,
    move30: p30 == null ? null : last.price - p30,
    lastTradeMs: last.timeMs,
  };
}

export function parseForceOrder(raw: string): Liquidation | null {
  try {
    const msg = JSON.parse(raw) as { o?: Record<string, unknown> };
    const o = msg.o;
    if (!o || o.s !== SYMBOL) return null;
    const side = o.S === 'BUY' ? 'BUY' : o.S === 'SELL' ? 'SELL' : null;
    const price = Number(o.ap ?? o.p);
    const qty = Number(o.z ?? o.q);
    const timeMs = Number(o.T);
    if (side == null || !(price > 0) || !(qty > 0) || !Number.isFinite(timeMs)) return null;
    return { timeMs, side, usdt: price * qty };
  } catch {
    return null;
  }
}

export const BINANCE_SPOT_WS = 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade';
/** 逐笔缓存保留时长：60 秒窗口 + 30 秒涨跌基准 + 余量 */
const TRADE_KEEP_MS = 180_000;

export function parseAggTradeMessage(raw: string): AggTrade | null {
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (msg.e !== 'aggTrade' || msg.s !== SYMBOL) return null;
    return parseAggTrades([msg])[0] ?? null;
  } catch {
    return null;
  }
}

export interface BinanceMarket {
  /** 最近 n 根 1m K 线（最后一根还在走） */
  klines(limit?: number): Promise<Kline[]>;
  /**
   * 最近 windowMs 的逐笔成交，时间升序。
   * 优先用 WebSocket 攒的缓存（连续、完整）；缓存盖不住窗口时退回 REST 最新 1000 笔（行情快时可能盖不满窗口，
   * 由 flowMetrics 判定后拒绝）。
   */
  recentTrades(nowMs: number, windowMs?: number): Promise<AggTrade[]>;
  /**
   * fromMs 以来的强平。**不知道**就回 null：强平流没连上，或连上的时刻晚于 fromMs（窗口开头那段没看到），
   * 这时 state 里不写强平，而不是说「没有强平」。
   */
  liquidationsSince(fromMs: number): Liquidation[] | null;
  /** 连上逐笔流；liquidations=true 再连合约强平流 */
  start(options?: { liquidations?: boolean }): void;
  stop(): void;
  status(): { tradesConnectedSinceMs: number | null; liquidationsConnectedSinceMs: number | null; bufferedTrades: number };
}

export interface BinanceOptions {
  apiBase?: string;
  fetchJson?: JsonFetch;
  wsFactory?: WsFactory;
  tradesUrl?: string;
  liquidationsUrl?: string;
  now?: () => number;
}

export function createBinanceMarket(options: BinanceOptions = {}): BinanceMarket {
  const base = (options.apiBase ?? DEFAULT_BINANCE_API).replace(/\/+$/, '');
  const fetchJson = options.fetchJson ?? defaultJsonFetch;
  const now = options.now ?? Date.now;
  const factory = options.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WsLike);
  const trades: AggTrade[] = [];
  const liquidations: Liquidation[] = [];
  let running = false;

  /** 一条会自动重连的流：记住连上的时刻，断开就清零 */
  function stream(url: string, onMessage: (raw: string) => void): { connectedSinceMs: number | null; close(): void } {
    const state = { connectedSinceMs: null as number | null, socket: null as WsLike | null, close: () => {} };
    function connect(): void {
      const socket = factory(url);
      state.socket = socket;
      socket.addEventListener('open', () => {
        if (state.socket === socket) state.connectedSinceMs = now();
      });
      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string') onMessage(event.data);
      });
      socket.addEventListener('close', () => {
        if (state.socket !== socket) return;
        state.connectedSinceMs = null;
        if (running) setTimeout(() => running && state.socket === socket && connect(), 5_000).unref?.();
      });
    }
    state.close = () => {
      const socket = state.socket;
      state.socket = null;
      state.connectedSinceMs = null;
      try {
        socket?.close();
      } catch {
        // ignore
      }
    };
    connect();
    return state;
  }

  let tradeStream: ReturnType<typeof stream> | null = null;
  let liqStream: ReturnType<typeof stream> | null = null;

  function pushTrade(t: AggTrade): void {
    const last = trades[trades.length - 1];
    if (last && t.timeMs < last.timeMs) return;
    trades.push(t);
    const cutoff = t.timeMs - TRADE_KEEP_MS;
    let drop = 0;
    while (drop < trades.length && trades[drop]!.timeMs < cutoff) drop++;
    if (drop > 0) trades.splice(0, drop);
  }

  return {
    async klines(limit = 61) {
      return parseKlines(await fetchJson(`${base}/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=${limit}`));
    },
    async recentTrades(nowMs, windowMs = 90_000) {
      const from = nowMs - windowMs;
      const since = tradeStream?.connectedSinceMs;
      // 缓存从窗口开始之前就在连续接收，才算盖得住
      if (since != null && since <= from && trades.length > 0 && trades[0]!.timeMs <= from) {
        return trades.filter((t) => t.timeMs >= from && t.timeMs <= nowMs);
      }
      // 不带 startTime：带了会从起点往后数 1000 笔，行情快时拿不到最新的；不带则是最新 1000 笔
      const rest = parseAggTrades(await fetchJson(`${base}/api/v3/aggTrades?symbol=${SYMBOL}&limit=1000`));
      return rest.filter((t) => t.timeMs >= from);
    },
    liquidationsSince(fromMs) {
      const since = liqStream?.connectedSinceMs;
      if (since == null || since > fromMs) return null;
      return liquidations.filter((l) => l.timeMs >= fromMs);
    },
    start(opts = {}) {
      if (running) return;
      running = true;
      tradeStream = stream(options.tradesUrl ?? BINANCE_SPOT_WS, (raw) => {
        const t = parseAggTradeMessage(raw);
        if (t) pushTrade(t);
      });
      if (opts.liquidations) {
        liqStream = stream(options.liquidationsUrl ?? BINANCE_FUTURES_WS, (raw) => {
          const liq = parseForceOrder(raw);
          if (!liq) return;
          liquidations.push(liq);
          const cutoff = liq.timeMs - 30 * 60_000;
          while (liquidations.length > 0 && liquidations[0]!.timeMs < cutoff) liquidations.shift();
        });
      }
    },
    stop() {
      running = false;
      tradeStream?.close();
      liqStream?.close();
      tradeStream = null;
      liqStream = null;
    },
    status: () => ({
      tradesConnectedSinceMs: tradeStream?.connectedSinceMs ?? null,
      liquidationsConnectedSinceMs: liqStream?.connectedSinceMs ?? null,
      bufferedTrades: trades.length,
    }),
  };
}
