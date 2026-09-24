import { WINDOW_SECONDS } from '../domain/types.ts';
import type { QuoteStore } from './quoteStore.ts';
import type { PriceHistory } from './priceHistory.ts';
import {
  clobBookUrl,
  cryptoPriceUrl,
  eventSlug,
  gammaEventUrl,
  parseBook,
  parseCryptoPrice,
  parseGammaMarketMeta,
  parseGammaTokens,
  type MarketMeta,
  parseHttpDateMs,
} from './polymarket.ts';
import { createSimulatedMarket, type SimulatedMarket } from './simulated.ts';
import type { Clock } from '../services/clock.ts';
import type { EventBus } from '../services/eventBus.ts';
import type { PredictionService, SettlePrices } from '../services/predictionService.ts';

export interface FetchResponse {
  status: number;
  headers?: { get(name: string): string | null } | null;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string) => Promise<FetchResponse>;

export type FeedMode = 'polymarket' | 'simulated' | 'auto';

export interface FeedStatus {
  mode: Exclude<FeedMode, 'auto'>;
  consecutiveFailures: number;
  lastSuccessMs: number | null;
  lastError: string | null;
  /** 上游返回的 Date 头基准（毫秒），用于校准本机时钟 */
  upstreamTimeMs: number | null;
}

export interface FeedSnapshot {
  windowStart: number;
  targetPrice: number | null;
  btcPrice: number | null;
  quote: { upBid: number | null; upAsk: number | null; downBid: number | null; downAsk: number | null } | null;
  degraded: boolean;
}

export interface FeedOptions {
  quotes: QuoteStore;
  prices: PriceHistory;
  service: PredictionService;
  clock: Clock;
  events?: EventBus;
  fetchImpl?: FetchLike;
  pollMs?: number;
  mode?: FeedMode;
  maxFailuresBeforeFallback?: number;
  simulated?: SimulatedMarket;
  log?: (message: string, meta?: Record<string, unknown>) => void;
  /** 另有逐秒现货（Chainlink 流）写价格序列时置 true，这里就不再把开盘均价塞进曲线 */
  externalPriceHistory?: boolean;
}

export interface MarketFeed {
  /** 拉一轮行情；测试直接调它，不必等定时器 */
  refresh(): Promise<FeedSnapshot>;
  start(): void;
  stop(): void;
  status(): FeedStatus;
  /** 供结算使用：该窗口已知的开收盘价（缺则 null） */
  settlePrices(windowStart: number): SettlePrices | null;
  /** 该窗口 UP / DOWN 的 CLOB token 与 conditionId（实盘下单、领奖用）；还没解析到为 null */
  tokens(windowStart: number): ({ upTokenId: string | null; downTokenId: string | null } & Partial<MarketMeta>) | null;
}

const DEFAULT_TIMEOUT_MS = 6000;

async function defaultFetch(url: string): Promise<FetchResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0', accept: 'application/json' },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 行情接入：定时把 Polymarket 的目标价、盘口喂给本地盘口与价格序列。
 *
 * 降级策略是「**拿不到价不算错，算没有报价**」：
 * 上游一旦超时/非 200/解析失败，就不动盘口（旧盘口会自然超龄，下单被拒），
 * 连续失败到阈值再整体切到本地模拟，避免页面彻底空转。
 */
export function createMarketFeed(options: FeedOptions): MarketFeed {
  const { quotes, prices, service, clock } = options;
  const doFetch = options.fetchImpl ?? defaultFetch;
  const pollMs = options.pollMs ?? 5000;
  const maxFailures = options.maxFailuresBeforeFallback ?? 3;
  const simulated = options.simulated ?? createSimulatedMarket();

  let mode: Exclude<FeedMode, 'auto'> = options.mode === 'simulated' ? 'simulated' : 'polymarket';
  const requestedMode: FeedMode = options.mode ?? 'polymarket';

  const tokenCache = new Map<number, { upTokenId: string | null; downTokenId: string | null } & Partial<MarketMeta>>();
  const priceCache = new Map<number, SettlePrices>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const status: FeedStatus = {
    mode,
    consecutiveFailures: 0,
    lastSuccessMs: null,
    lastError: null,
    upstreamTimeMs: null,
  };

  async function getJson(url: string): Promise<{ json: unknown; dateMs: number | null }> {
    const res = await doFetch(url);
    if (res.status !== 200) throw new Error(`上游返回 ${res.status}：${url}`);
    const dateMs = parseHttpDateMs(res.headers?.get('date') ?? null);
    return { json: await res.json(), dateMs };
  }

  function currentWindowStart(nowMs: number): number {
    const sec = Math.floor(nowMs / 1000);
    return sec - (sec % WINDOW_SECONDS);
  }

  /** 模拟盘：目标价与价格都来自同一条闭式曲线，因此离线也能正常结算 */
  function refreshSimulated(nowMs: number, windowStart: number): FeedSnapshot {
    const sample = simulated.quoteAt(nowMs, windowStart);
    const targetPrice = simulated.openPrice(windowStart);
    quotes.set({ ...sample, ts: nowMs });
    prices.push(nowMs, sample.btcPrice);
    service.ensureRound(targetPrice);
    service.syncTargetPrice(windowStart, targetPrice);
    priceCache.set(windowStart, { startPrice: targetPrice, endPrice: null });

    const prevWs = windowStart - WINDOW_SECONDS;
    if (!priceCache.get(prevWs)?.endPrice) {
      priceCache.set(prevWs, {
        startPrice: simulated.openPrice(prevWs),
        endPrice: simulated.closePrice(prevWs),
      });
    }

    const snapshot: FeedSnapshot = {
      windowStart,
      targetPrice,
      btcPrice: sample.btcPrice,
      quote: {
        upBid: sample.upBid,
        upAsk: sample.upAsk,
        downBid: sample.downBid,
        downAsk: sample.downAsk,
      },
      degraded: true,
    };
    options.events?.publish('market', { ...snapshot.quote, ts: nowMs, degraded: true });
    return snapshot;
  }

  async function refreshUpstream(nowMs: number, windowStart: number): Promise<FeedSnapshot> {
    const current = await getJson(cryptoPriceUrl(windowStart));
    if (current.dateMs != null) status.upstreamTimeMs = current.dateMs;
    const parsed = parseCryptoPrice(current.json);
    if (parsed?.openPrice != null) {
      priceCache.set(windowStart, { startPrice: parsed.openPrice, endPrice: null });
      // 建回合与拿目标价是两个独立事件，谁先到都可能：
      // 先 ensureRound 保证回合在，再 syncTargetPrice 把晚到的价补上
      service.ensureRound(parsed.openPrice);
      service.syncTargetPrice(windowStart, parsed.openPrice);
      if (!options.externalPriceHistory) prices.push(nowMs, parsed.openPrice);
    }

    // 上一回合的收盘价：只有 completed 才算数，否则会把「还在走的窗口」当成结果
    const prevWs = windowStart - WINDOW_SECONDS;
    if (!priceCache.get(prevWs)?.endPrice) {
      const prev = await getJson(cryptoPriceUrl(prevWs));
      const prevParsed = parseCryptoPrice(prev.json);
      if (prevParsed != null) {
        priceCache.set(prevWs, {
          startPrice: prevParsed.openPrice ?? priceCache.get(prevWs)?.startPrice ?? null,
          endPrice: prevParsed.completed ? prevParsed.closePrice : null,
        });
      }
    }

    let tokens = tokenCache.get(windowStart);
    if (tokens == null) {
      const event = await getJson(gammaEventUrl(windowStart));
      tokens = {
        ...(parseGammaTokens(event.json, eventSlug(windowStart)) ?? { upTokenId: null, downTokenId: null }),
        ...(parseGammaMarketMeta(event.json, eventSlug(windowStart)) ?? {}),
      };
      tokenCache.set(windowStart, tokens);
    }

    let quote: FeedSnapshot['quote'] = null;
    let bookTs = nowMs;
    if (tokens.upTokenId != null && tokens.downTokenId != null) {
      const [upBook, downBook] = await Promise.all([
        getJson(clobBookUrl(tokens.upTokenId)),
        getJson(clobBookUrl(tokens.downTokenId)),
      ]);
      const up = parseBook(upBook.json);
      const down = parseBook(downBook.json);
      if (up != null && down != null) {
        // 时间戳取拿到盘口的这一刻：这轮刷新前面还串行请求了开收盘价与 Gamma，用开始时刻会把盘口平白记老一两秒，
        // 策略按盘口年龄拒单，差这一两秒就是 STALE_BOOK 与不 STALE 的区别
        bookTs = clock.now();
        quotes.set({
          upBid: up.bid,
          upAsk: up.ask,
          downBid: down.bid,
          downAsk: down.ask,
          ts: bookTs,
        });
        quote = { upBid: up.bid, upAsk: up.ask, downBid: down.bid, downAsk: down.ask };
      }
    }

    const snapshot: FeedSnapshot = {
      windowStart,
      targetPrice: priceCache.get(windowStart)?.startPrice ?? null,
      btcPrice: prices.latest()?.price ?? null,
      quote,
      degraded: false,
    };
    options.events?.publish('market', { ...(quote ?? {}), ts: bookTs, degraded: false });
    return snapshot;
  }

  async function refresh(): Promise<FeedSnapshot> {
    const nowMs = clock.now();
    const windowStart = currentWindowStart(nowMs);

    if (mode === 'simulated') return refreshSimulated(nowMs, windowStart);

    try {
      const snapshot = await refreshUpstream(nowMs, windowStart);
      status.consecutiveFailures = 0;
      status.lastSuccessMs = nowMs;
      status.lastError = null;
      return snapshot;
    } catch (e) {
      status.consecutiveFailures++;
      status.lastError = e instanceof Error ? e.message : String(e);
      if (requestedMode === 'auto' && status.consecutiveFailures >= maxFailures) {
        mode = 'simulated';
        status.mode = mode;
        options.log?.('上游连续失败，切换到本地模拟行情', {
          failures: status.consecutiveFailures,
        });
        return refreshSimulated(nowMs, windowStart);
      }
      // 降级：**只用不写**。不拿模拟价顶替真实盘口——那等于凭空造一个价让人成交；
      // 旧盘口留在原地自然超龄，下单会被 PRICE_UNAVAILABLE 拒掉。
      const snapshot: FeedSnapshot = {
        windowStart,
        targetPrice: priceCache.get(windowStart)?.startPrice ?? null,
        btcPrice: prices.latest()?.price ?? null,
        quote: null,
        degraded: true,
      };
      return snapshot;
    }
  }

  return {
    refresh,
    start() {
      if (running) return;
      running = true;
      void refresh();
      timer = setInterval(() => {
        void refresh();
      }, pollMs);
      timer.unref?.();
    },
    stop() {
      running = false;
      if (timer != null) clearInterval(timer);
      timer = null;
    },
    status: () => ({ ...status }),
    tokens(windowStart) {
      return tokenCache.get(windowStart) ?? null;
    },
    settlePrices(windowStart) {
      const cached = priceCache.get(windowStart);
      if (cached == null) return null;
      return { startPrice: cached.startPrice ?? null, endPrice: cached.endPrice ?? null };
    },
  };
}
