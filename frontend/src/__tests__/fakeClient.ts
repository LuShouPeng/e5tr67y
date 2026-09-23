import { vi } from 'vitest';

import type { ApiClient, EventSourceLike, StreamHandlers } from '../api/client.ts';
import { createApiClient } from '../api/client.ts';
import type { CurrentResponse } from '../api/types.ts';

export interface FakeServer {
  /** 当前回合响应，测试可直接改 */
  current: CurrentResponse;
  priceHistory: { points: { time: number; price: number }[]; latest: { time: number; price: number } | null };
  /** current() 被调用的次数 */
  currentCalls: number;
  /** 让 current() 失败 */
  failWith: { status: number; code: string } | null;
  bets: unknown[];
  rounds: unknown[];
  pnl: unknown;
  live: { rows: unknown[] };
  buyImpl?: (side: string, amount: number) => unknown;
  sellImpl?: (betId: number, contracts?: number) => unknown;
}

export function fakeServer(overrides: Partial<FakeServer> = {}): FakeServer {
  const windowStart = 1_790_000_000 - (1_790_000_000 % 300);
  return {
    current: {
      round: {
        id: 1,
        windowStart,
        startPrice: 85_000,
        endPrice: null,
        outcome: null,
        status: 'OPEN',
        remainingSeconds: 300,
        serverTimeMs: windowStart * 1000,
      },
      quote: { up: { bid: 0.48, ask: 0.49 }, down: { bid: 0.51, ask: 0.52 }, ts: windowStart * 1000 },
    },
    priceHistory: { points: [], latest: null },
    currentCalls: 0,
    failWith: null,
    bets: [],
    rounds: [],
    pnl: {},
    live: { rows: [] },
    ...overrides,
  };
}

export interface FakeStream {
  emit(type: 'round' | 'market' | 'activity', data: unknown): void;
  emitRaw(type: string, raw: string): void;
  closed: number;
  sources: number;
}

/** 造一个"带 SSE 的假客户端"：REST 走内存实现，推送由测试手动 emit */
export function makeFakeClient(server: FakeServer): {
  client: ApiClient;
  stream: FakeStream;
} {
  const listeners = new Map<string, Array<(e: { data: string }) => void>>();
  const state: FakeStream = {
    closed: 0,
    sources: 0,
    emit(type, data) {
      for (const fn of listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
    },
    emitRaw(type, raw) {
      for (const fn of listeners.get(type) ?? []) fn({ data: raw });
    },
  };

  const source: EventSourceLike = {
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    close() {
      state.closed++;
    },
  };

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);

    const ok = (body: unknown): Response =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

    if (server.failWith != null && url.includes('prediction/current')) {
      return new Response(
        JSON.stringify({ error: { code: server.failWith.code, message: 'x' } }),
        { status: server.failWith.status },
      );
    }

    if (url.includes('prediction/current')) {
      server.currentCalls++;
      return ok(server.current);
    }
    if (url.includes('price-history')) return ok(server.priceHistory);
    if (url.includes('prediction/bets')) return ok({ rows: server.bets, total: server.bets.length, pageNum: 1, pageSize: 10 });
    if (url.includes('prediction/rounds')) return ok({ rows: server.rounds, total: server.rounds.length, pageNum: 1, pageSize: 10 });
    if (url.includes('prediction/pnl')) return ok(server.pnl);
    if (url.includes('prediction/live')) return ok(server.live);
    if (url.includes('/buy')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { side: string; amount: number };
      return ok(server.buyImpl?.(body.side, body.amount) ?? { id: 1 });
    }
    if (url.includes('/sell/')) {
      const contracts = new URL(url, 'http://x').searchParams.get('contracts');
      return ok(
        server.sellImpl?.(1, contracts == null ? undefined : Number(contracts)) ?? { id: 1 },
      );
    }
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: url } }), { status: 404 });
  }) as unknown as typeof fetch;

  const client = createApiClient({
    fetchImpl,
    eventSourceFactory: () => {
      state.sources++;
      return source;
    },
  });

  return { client, stream: state };
}

export type { StreamHandlers };
