import { bestPrice } from './polymarket.ts';
import type { WsFactory, WsLike } from './chainlinkStream.ts';

/**
 * Polymarket CLOB 市场频道：当前回合 UP / DOWN 两个 token 的买一卖一实时推送（替代 REST 轮询账本）。
 *
 * 格式与上游 `PolymarketWsClient` 一致：
 * - 订阅 `{"assets_ids": [up, down], "type": "market"}`；
 * - `book`：某个 token 的全量快照（bids / asks 档位）；
 * - `price_change`：`price_changes[]` 里每项带 `asset_id`、`best_bid`、`best_ask`；
 * - 每 5 秒发一次文本 `PING`（官方要求不超过 10 秒），回 `PONG`。
 *
 * **盘口「新鲜」按连接还活着算**：盘口没变化时不会有推送，但连接每次回 PONG 都说明手里的买一卖一仍是当前值。
 * 所以时间戳 = 最近一次收到本频道任何消息（含 PONG）的时刻；连接断了时间戳就不再前进，策略自然会判它旧了。
 * 两个 token 都收到过快照 / 变动之前不算有盘口。
 */

export const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PING_MS = 5_000;
/** 这么久连 PONG 都没收到就换一条连接 */
const SILENT_RECONNECT_MS = 20_000;

export interface StreamBook {
  windowStart: number;
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
  /** 最近一次确认盘口仍有效的时刻（毫秒） */
  ts: number;
}

export interface ClobBookStream {
  /** 切到某个窗口的两个 token；同一组 token 重复调用无副作用 */
  subscribe(windowStart: number, upTokenId: string, downTokenId: string): void;
  /** 当前窗口的盘口；两个 token 都有数据之前为 null */
  current(): StreamBook | null;
  /** 直接喂一条消息（测试与回放用） */
  handleMessage(raw: string): void;
  stop(): void;
  status(): { connected: boolean; windowStart: number | null; lastMessageMs: number | null };
}

export interface ClobStreamOptions {
  wsFactory?: WsFactory;
  now?: () => number;
  /** 盘口有变化或确认仍有效时回调（喂给 QuoteStore / SSE） */
  onBook?: (book: StreamBook) => void;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

interface Top {
  bid: number | null;
  ask: number | null;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

export function subscribeMessage(upTokenId: string, downTokenId: string): string {
  return JSON.stringify({ assets_ids: [upTokenId, downTokenId], type: 'market' });
}

export function createClobBookStream(options: ClobStreamOptions = {}): ClobBookStream {
  const factory = options.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WsLike);
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});

  let ws: WsLike | null = null;
  let connected = false;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let sub: { windowStart: number; up: string; down: string } | null = null;
  let tops = new Map<string, Top>();
  /** 盘口新鲜度：最近一次收到本频道消息的时刻 */
  let lastMessageMs: number | null = null;
  /** 看门狗用：最近一次有动静（消息 / 订阅 / 重连）的时刻，不影响盘口新鲜度 */
  let lastActivityMs = 0;

  function current(): StreamBook | null {
    if (sub == null || lastMessageMs == null) return null;
    const up = tops.get(sub.up);
    const down = tops.get(sub.down);
    if (!up || !down) return null;
    return { windowStart: sub.windowStart, upBid: up.bid, upAsk: up.ask, downBid: down.bid, downAsk: down.ask, ts: lastMessageMs };
  }

  function emit(): void {
    const b = current();
    if (b) options.onBook?.(b);
  }

  function setTop(assetId: unknown, bid: number | null, ask: number | null): boolean {
    if (sub == null || typeof assetId !== 'string' || (assetId !== sub.up && assetId !== sub.down)) return false;
    tops.set(assetId, { bid, ask });
    return true;
  }

  function handleEvent(msg: Record<string, unknown>): boolean {
    const type = msg.event_type;
    if (type === 'book') {
      return setTop(msg.asset_id, bestPrice(msg.bids, true), bestPrice(msg.asks, false));
    }
    if (type === 'price_change' && Array.isArray(msg.price_changes)) {
      let changed = false;
      for (const raw of msg.price_changes) {
        const c = raw as Record<string, unknown>;
        // 只有带了 best_bid / best_ask 的变动才能直接更新买一卖一
        if (!('best_bid' in c) && !('best_ask' in c)) continue;
        const prev = typeof c.asset_id === 'string' ? tops.get(c.asset_id) : undefined;
        const bid = 'best_bid' in c ? num(c.best_bid) : (prev?.bid ?? null);
        const ask = 'best_ask' in c ? num(c.best_ask) : (prev?.ask ?? null);
        changed = setTop(c.asset_id, bid, ask) || changed;
      }
      return changed;
    }
    return false;
  }

  function handleMessage(raw: string): void {
    if (sub == null) return;
    lastMessageMs = now();
    lastActivityMs = lastMessageMs;
    if (raw === 'PONG' || raw === '') {
      emit(); // 连接还活着：盘口没变，但时间戳往前走
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const events = Array.isArray(parsed) ? parsed : [parsed];
    for (const e of events) if (e && typeof e === 'object') handleEvent(e as Record<string, unknown>);
    emit();
  }

  function closeSocket(): void {
    const s = ws;
    ws = null;
    connected = false;
    try {
      s?.close();
    } catch {
      // ignore
    }
  }

  function connect(): void {
    closeSocket();
    if (sub == null) return;
    const target = sub;
    const socket = factory(CLOB_WS_URL);
    ws = socket;
    socket.addEventListener('open', () => {
      if (ws !== socket) return;
      connected = true;
      socket.send(subscribeMessage(target.up, target.down));
    });
    socket.addEventListener('message', (event) => {
      if (ws === socket && typeof event.data === 'string') handleMessage(event.data);
    });
    socket.addEventListener('close', () => {
      if (ws !== socket) return;
      connected = false;
      ws = null;
      setTimeout(() => {
        if (ws == null && sub != null) connect();
      }, 2_000).unref?.();
    });
    socket.addEventListener('error', (event) => log('CLOB WS 出错', { error: String(event.data ?? '') }));
  }

  function ensureTimers(): void {
    if (pingTimer) return;
    pingTimer = setInterval(() => {
      try {
        if (connected) ws?.send('PING');
      } catch {
        // 发不出去交给看门狗
      }
    }, PING_MS);
    pingTimer.unref?.();
    watchdog = setInterval(() => {
      if (sub != null && now() - lastActivityMs > SILENT_RECONNECT_MS) {
        log('CLOB WS 静默超时，重连');
        lastActivityMs = now(); // 给新连接留出时间，别每拍都重连
        connect();
      }
    }, 5_000);
    watchdog.unref?.();
  }

  return {
    subscribe(windowStart, up, down) {
      if (sub && sub.windowStart === windowStart && sub.up === up && sub.down === down) return;
      // 换回合：旧盘口作废，重新订阅（官方频道按连接订阅，换 token 最稳的做法是换连接）
      sub = { windowStart, up, down };
      tops = new Map();
      lastMessageMs = null;
      lastActivityMs = now();
      ensureTimers();
      connect();
    },
    current,
    handleMessage,
    stop() {
      sub = null;
      if (pingTimer) clearInterval(pingTimer);
      if (watchdog) clearInterval(watchdog);
      pingTimer = null;
      watchdog = null;
      closeSocket();
    },
    status: () => ({ connected, windowStart: sub?.windowStart ?? null, lastMessageMs }),
  };
}
