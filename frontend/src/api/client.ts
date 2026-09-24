import type {
  ApiErrorBody,
  BetView,
  BuyPlan,
  CurrentResponse,
  LiveBetView,
  MarketEvent,
  PageView,
  PnlView,
  PricePoint,
  QuoteBook,
  RoundView,
  Side,
} from './types.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** 盘口不可用是「稍后会好」类错误，UI 用弱提示而不是报错 */
  get retryable(): boolean {
    return this.status === 503 || this.code === 'PRICE_UNAVAILABLE';
  }
}

/** SSE 的最小接口：只依赖这点能力，测试里塞一个假的就行 */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
}

export interface StreamHandlers {
  onRound?: (round: RoundView) => void;
  onMarket?: (market: MarketEvent) => void;
  onActivity?: (activity: LiveBetView) => void;
  onError?: (error: unknown) => void;
  onOpen?: () => void;
}

export interface ApiClientOptions {
  baseUrl?: string;
  userId?: number;
  username?: string;
  fetchImpl?: typeof fetch;
  eventSourceFactory?: (url: string, init?: { withCredentials?: boolean }) => EventSourceLike;
}

export interface ApiClient {
  current(): Promise<CurrentResponse>;
  priceHistory(): Promise<{ points: PricePoint[]; latest: PricePoint | null }>;
  /** 买入试算（不落库不扣款）：手续费与份数以后端为准，前端不重算费率 */
  preview(side: Side, amount: number): Promise<BuyPlan>;
  buy(side: Side, amount: number): Promise<BetView>;
  sell(betId: number, contracts?: number): Promise<BetView>;
  bets(pageNum?: number, pageSize?: number): Promise<PageView<BetView>>;
  rounds(pageNum?: number, pageSize?: number): Promise<PageView<RoundView>>;
  pnl(): Promise<PnlView>;
  live(): Promise<{ rows: LiveBetView[] }>;
  /** 订阅 SSE，返回退订函数 */
  stream(handlers: StreamHandlers): () => void;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? '';
  const userId = options.userId ?? 1;
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  function headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    h['x-user-id'] = String(userId);
    if (options.username != null && options.username !== '') h['x-username'] = options.username;
    return h;
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, { ...init, headers: headers() });
    const text = await res.text();
    const body = parseJson(text);

    if (!res.ok) {
      const err = (body as ApiErrorBody | null)?.error;
      throw new ApiError(res.status, err?.code ?? 'INTERNAL_ERROR', err?.message ?? `请求失败（${res.status}）`);
    }
    return body as T;
  }

  const qs = (params: Record<string, string | number | undefined>): string => {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) search.set(k, String(v));
    }
    const s = search.toString();
    return s === '' ? '' : `?${s}`;
  };

  return {
    current: () => request<CurrentResponse>('/api/prediction/current'),

    priceHistory: () =>
      request<{ points: PricePoint[]; latest: PricePoint | null }>('/api/prediction/price-history'),

    preview: (side, amount) =>
      request<BuyPlan>(`/api/prediction/preview${qs({ side, amount })}`),

    buy: (side, amount) =>
      request<BetView>('/api/prediction/buy', {
        method: 'POST',
        body: JSON.stringify({ side, amount }),
      }),

    sell: (betId, contracts) =>
      request<BetView>(`/api/prediction/sell/${betId}${qs({ contracts })}`, { method: 'POST' }),

    bets: (pageNum = 1, pageSize = 10) =>
      request<PageView<BetView>>(`/api/prediction/bets${qs({ pageNum, pageSize })}`),

    rounds: (pageNum = 1, pageSize = 10) =>
      request<PageView<RoundView>>(`/api/prediction/rounds${qs({ pageNum, pageSize })}`),

    pnl: () => request<PnlView>('/api/prediction/pnl'),

    live: () => request<{ rows: LiveBetView[] }>('/api/prediction/live'),

    stream(handlers) {
      const factory =
        options.eventSourceFactory ??
        ((url: string) => new EventSource(url) as unknown as EventSourceLike);
      const source = factory(`${baseUrl}/api/prediction/stream`);

      const bind = <T>(type: string, fn?: (payload: T) => void): void => {
        if (fn == null) return;
        source.addEventListener(type, (event) => {
          const data = parseJson(event.data);
          if (data != null) fn(data as T);
        });
      };

      bind<RoundView>('round', handlers.onRound);
      bind<MarketEvent>('market', handlers.onMarket);
      bind<LiveBetView>('activity', handlers.onActivity);
      if (handlers.onError != null) {
        source.addEventListener('error', (event) => handlers.onError?.(event));
      }
      handlers.onOpen?.();

      return () => source.close();
    },
  };
}

export type { QuoteBook };
