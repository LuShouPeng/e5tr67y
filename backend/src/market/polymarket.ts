import { WINDOW_SECONDS } from '../domain/types.ts';

const ORIGIN = 'https://polymarket.com';
const GAMMA_ORIGIN = 'https://gamma-api.polymarket.com';
const CLOB_ORIGIN = 'https://clob.polymarket.com';

/** 官方回合的 slug 就是窗口起点：`btc-updown-5m-1756000000` */
export function eventSlug(windowStart: number): string {
  return `btc-updown-5m-${windowStart}`;
}

export function gammaEventUrl(windowStart: number): string {
  return `${GAMMA_ORIGIN}/events/slug/${eventSlug(windowStart)}`;
}

/**
 * 开收盘价接口。**必须带 `twapEnabled=true&twapLookbackSeconds=60`**：
 * 不带返回的是边界那一刻的现价，而官方结算是窗口末 60 秒的 Chainlink TWAP，两者不是一回事。
 */
export function cryptoPriceUrl(windowStart: number, windowSeconds: number = WINDOW_SECONDS): string {
  const start = new Date(windowStart * 1000).toISOString();
  const end = new Date((windowStart + windowSeconds) * 1000).toISOString();
  return `${ORIGIN}/api/crypto/crypto-price?symbol=BTC&variant=fiveminute`
    + `&eventStartTime=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`
    + '&twapEnabled=true&twapLookbackSeconds=60';
}

export function clobBookUrl(tokenId: string): string {
  return `${CLOB_ORIGIN}/book?token_id=${encodeURIComponent(tokenId)}`;
}

/** Gamma 的这两个字段有时是数组，有时是「被转义成字符串的数组」，两种都要吃 */
export function parseJsonArrayField(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export interface EventTokens {
  upTokenId: string | null;
  downTokenId: string | null;
}

/**
 * 从 Gamma 事件里取 UP / DOWN 的 CLOB token。
 * 按 `outcomes` 与 `clobTokenIds` 的**下标对应关系**解析，而不是靠顺序猜：
 * 两个数组是并行排列的，错位就买反了方向。
 */
export function parseGammaTokens(event: unknown, slug: string): EventTokens | null {
  const markets = (event as { markets?: unknown })?.markets;
  if (!Array.isArray(markets) || markets.length === 0) return null;

  let fallback: { outcomes: unknown[]; tokenIds: unknown[] } | null = null;
  for (const raw of markets) {
    const market = raw as Record<string, unknown>;
    if (market == null || typeof market !== 'object') continue;
    const tokenIds = parseJsonArrayField(market.clobTokenIds);
    const outcomes = parseJsonArrayField(market.outcomes);
    if (tokenIds == null || outcomes == null) continue;
    if (fallback == null) fallback = { outcomes, tokenIds };
    if (market.slug === slug) {
      fallback = { outcomes, tokenIds };
      break;
    }
  }
  if (fallback == null) return null;

  let upTokenId: string | null = null;
  let downTokenId: string | null = null;
  const count = Math.min(fallback.outcomes.length, fallback.tokenIds.length);
  for (let i = 0; i < count; i++) {
    const outcome = String(fallback.outcomes[i] ?? '').toLowerCase();
    const tokenId = fallback.tokenIds[i];
    if (typeof tokenId !== 'string' || tokenId === '') continue;
    if (outcome === 'up') upTokenId = tokenId;
    else if (outcome === 'down') downTokenId = tokenId;
  }
  if (upTokenId == null) upTokenId = asToken(fallback.tokenIds[0]);
  if (downTokenId == null) downTokenId = asToken(fallback.tokenIds[1]);
  return { upTokenId, downTokenId };
}

function asToken(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export interface CryptoPrice {
  openPrice: number | null;
  closePrice: number | null;
  /** false 表示这个窗口还没收官，closePrice 不作数 */
  completed: boolean;
}

export function parseCryptoPrice(json: unknown): CryptoPrice | null {
  if (json == null || typeof json !== 'object' || Array.isArray(json)) return null;
  const obj = json as Record<string, unknown>;
  return {
    openPrice: toPrice(obj.openPrice),
    closePrice: toPrice(obj.closePrice),
    completed: obj.completed === true,
  };
}

function toPrice(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 档位数组 [{price,size}]：买盘取最高、卖盘取最低，不假设上游排过序 */
export function bestPrice(levels: unknown, highest: boolean): number | null {
  if (!Array.isArray(levels)) return null;
  let best: number | null = null;
  for (const raw of levels) {
    const price = toPrice((raw as Record<string, unknown>)?.price);
    if (price == null) continue;
    if (best == null || (highest ? price > best : price < best)) best = price;
  }
  return best;
}

export interface RawBook {
  bid: number | null;
  ask: number | null;
}

export function parseBook(json: unknown): RawBook | null {
  if (json == null || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  if (!('bids' in obj) && !('asks' in obj)) return null;
  return { bid: bestPrice(obj.bids, true), ask: bestPrice(obj.asks, false) };
}

/** HTTP `Date` 头 → 毫秒时间戳，用作服务端时钟基准 */
export function parseHttpDateMs(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export interface MarketMeta {
  /** CTF 条件 id（0x + 64 位十六进制），赢了领奖（redeemPositions）要用 */
  conditionId: string | null;
  /** neg-risk 市场领奖要走 NegRiskAdapter；BTC 5 分钟涨跌盘是普通二元市场 */
  negRisk: boolean;
}

/** 从 Gamma 事件里取本窗口市场的 conditionId 与 negRisk；优先 slug 精确匹配的那个市场 */
export function parseGammaMarketMeta(event: unknown, slug: string): MarketMeta | null {
  const markets = (event as { markets?: unknown })?.markets;
  if (!Array.isArray(markets)) return null;
  let found: MarketMeta | null = null;
  for (const raw of markets) {
    const market = raw as Record<string, unknown>;
    if (market == null || typeof market !== 'object') continue;
    const conditionId =
      typeof market.conditionId === 'string' && /^0x[0-9a-fA-F]{64}$/.test(market.conditionId) ? market.conditionId : null;
    const meta = { conditionId, negRisk: market.negRisk === true };
    if (found == null) found = meta;
    if (market.slug === slug) return meta;
  }
  return found;
}
