import type { Tick } from '../strategy/model.ts';

/**
 * Polymarket 实时数据流（RTDS）里的 Chainlink BTC/USD 现货。
 *
 * 结算看的是 Chainlink 价格，所以策略算「现在领先多少」必须用这条，而不是交易所现货：
 * `crypto-price` 接口只给开/收盘两个 60 秒均价，拿它判断盘中走势等于闭眼。
 * 订阅 `crypto_prices_chainlink`（逐秒现货，时间戳是 Chainlink 自己的）和
 * `crypto_prices_twap_sixty`（官网显示的 60 秒均价）两个主题；官方要求每 5 秒发一次文本 PING。
 */

export const LIVE_DATA_URL = 'wss://ws-live-data.polymarket.com/';
const SPOT_TOPIC = 'crypto_prices_chainlink';
const TWAP_TOPIC = 'crypto_prices_twap_sixty';
const PING_MS = 5_000;
/** 现货旧过这么久就换一条新连接 */
const STALE_RECONNECT_MS = 15_000;
/** 留够 10 分钟：覆盖本回合 + 上一回合 + 近 3 分钟实际波动 */
const KEEP_MS = 10 * 60_000;

/** 只用到 WebSocket 的这几个成员，测试注入假的 */
export interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void;
}

export type WsFactory = (url: string) => WsLike;

export interface ChainlinkStream {
  start(): void;
  stop(): void;
  /** `fromMs` 起（含）的现货 tick，时间升序 */
  ticksSince(fromMs: number): Tick[];
  latest(): Tick | null;
  /** 官网口径的 60 秒均价最新值 */
  latestTwap(): Tick | null;
  /** 直接喂一条消息（测试与回放用） */
  handleMessage(raw: string): void;
}

export interface ChainlinkStreamOptions {
  wsFactory?: WsFactory;
  now?: () => number;
  onTick?: (tick: Tick) => void;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

function defaultFactory(url: string): WsLike {
  return new WebSocket(url) as unknown as WsLike;
}

export function subscribeMessage(): string {
  return JSON.stringify({
    action: 'subscribe',
    subscriptions: [SPOT_TOPIC, TWAP_TOPIC].map((topic) => ({
      topic,
      type: '*',
      filters: JSON.stringify({ symbol: 'btc/usd' }),
    })),
  });
}

export function createChainlinkStream(options: ChainlinkStreamOptions = {}): ChainlinkStream {
  const factory = options.wsFactory ?? defaultFactory;
  const now = options.now ?? Date.now;
  const ticks: Tick[] = [];
  let twapLatest: Tick | null = null;
  let ws: WsLike | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lastMessageMs = 0;

  function push(tick: Tick): void {
    const last = ticks[ticks.length - 1];
    if (last && tick.timeMs < last.timeMs) return;
    if (last && tick.timeMs === last.timeMs) ticks[ticks.length - 1] = tick;
    else ticks.push(tick);
    const cutoff = tick.timeMs - KEEP_MS;
    let drop = 0;
    while (drop < ticks.length && ticks[drop]!.timeMs < cutoff) drop++;
    if (drop > 0) ticks.splice(0, drop);
    options.onTick?.(tick);
  }

  function handleMessage(raw: string): void {
    if (raw === 'PONG' || raw === '') return;
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const m = msg as { topic?: unknown; payload?: { value?: unknown; timestamp?: unknown } };
    const value = Number(m.payload?.value);
    if (!Number.isFinite(value) || value <= 0) return;
    lastMessageMs = now();
    if (m.topic === SPOT_TOPIC) {
      const ts = Number(m.payload?.timestamp);
      push({ timeMs: Number.isFinite(ts) && ts > 0 ? ts : now(), price: value });
    } else if (m.topic === TWAP_TOPIC) {
      twapLatest = { timeMs: now(), price: value };
    }
  }

  function connect(): void {
    try {
      ws?.close();
    } catch {
      // 旧连接关不掉无所谓
    }
    const socket = factory(LIVE_DATA_URL);
    ws = socket;
    lastMessageMs = now();
    socket.addEventListener('open', () => socket.send(subscribeMessage()));
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') handleMessage(event.data);
    });
    socket.addEventListener('close', () => {
      if (running && ws === socket) setTimeout(() => running && ws === socket && connect(), 2_000).unref?.();
    });
    socket.addEventListener('error', (event) => options.log?.('RTDS 连接出错', { error: String(event.data ?? '') }));
  }

  return {
    start() {
      if (running) return;
      running = true;
      connect();
      pingTimer = setInterval(() => {
        try {
          ws?.send('PING');
        } catch {
          // 发不出去由看门狗重连
        }
      }, PING_MS);
      pingTimer.unref?.();
      watchdog = setInterval(() => {
        if (now() - lastMessageMs > STALE_RECONNECT_MS) {
          options.log?.('RTDS 超时无数据，重连');
          connect();
        }
      }, STALE_RECONNECT_MS);
      watchdog.unref?.();
    },
    stop() {
      running = false;
      if (pingTimer) clearInterval(pingTimer);
      if (watchdog) clearInterval(watchdog);
      pingTimer = null;
      watchdog = null;
      try {
        ws?.close();
      } catch {
        // ignore
      }
      ws = null;
    },
    ticksSince(fromMs) {
      return ticks.filter((t) => t.timeMs >= fromMs);
    },
    latest: () => ticks[ticks.length - 1] ?? null,
    latestTwap: () => twapLatest,
    handleMessage,
  };
}
