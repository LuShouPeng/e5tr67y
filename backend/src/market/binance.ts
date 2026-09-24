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

/** 最近 windowMs 的主动买卖与大单；trades 需覆盖 [now − windowMs, now] */
export function flowMetrics(trades: readonly AggTrade[], nowMs: number, windowMs = 60_000): FlowMetrics | null {
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

export interface BinanceMarket {
  /** 最近 n 根 1m K 线（最后一根还在走） */
  klines(limit?: number): Promise<Kline[]>;
  /** 最近 windowMs 的逐笔成交（最多最新 1000 笔；行情极快时覆盖不满 windowMs） */
  recentTrades(nowMs: number, windowMs?: number): Promise<AggTrade[]>;
  /** fromMs 以来的强平；没开强平流为空 */
  liquidationsSince(fromMs: number): Liquidation[];
  startLiquidations(): void;
  stop(): void;
}

export interface BinanceOptions {
  apiBase?: string;
  fetchJson?: JsonFetch;
  wsFactory?: WsFactory;
  liquidationsUrl?: string;
}

export function createBinanceMarket(options: BinanceOptions = {}): BinanceMarket {
  const base = (options.apiBase ?? DEFAULT_BINANCE_API).replace(/\/+$/, '');
  const fetchJson = options.fetchJson ?? defaultJsonFetch;
  const liquidations: Liquidation[] = [];
  let ws: WsLike | null = null;
  let running = false;

  function connectLiquidations(): void {
    const factory = options.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WsLike);
    const socket = factory(options.liquidationsUrl ?? BINANCE_FUTURES_WS);
    ws = socket;
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const liq = parseForceOrder(event.data);
      if (!liq) return;
      liquidations.push(liq);
      const cutoff = liq.timeMs - 30 * 60_000;
      while (liquidations.length > 0 && liquidations[0]!.timeMs < cutoff) liquidations.shift();
    });
    socket.addEventListener('close', () => {
      if (running && ws === socket) setTimeout(() => running && ws === socket && connectLiquidations(), 5_000).unref?.();
    });
  }

  return {
    async klines(limit = 61) {
      return parseKlines(await fetchJson(`${base}/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=${limit}`));
    },
    async recentTrades(nowMs, windowMs = 90_000) {
      // 不带 startTime：带了会从起点往后数 1000 笔，行情快时拿不到最新的；不带则是最新 1000 笔
      const trades = parseAggTrades(await fetchJson(`${base}/api/v3/aggTrades?symbol=${SYMBOL}&limit=1000`));
      return trades.filter((t) => t.timeMs >= nowMs - windowMs);
    },
    liquidationsSince(fromMs) {
      return liquidations.filter((l) => l.timeMs >= fromMs);
    },
    startLiquidations() {
      if (running) return;
      running = true;
      connectLiquidations();
    },
    stop() {
      running = false;
      try {
        ws?.close();
      } catch {
        // ignore
      }
      ws = null;
    },
  };
}
