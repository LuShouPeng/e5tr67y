import { describe, expect, it, vi } from 'vitest';

import { ApiError, createApiClient, type EventSourceLike } from '../api/client.ts';
import type { ApiErrorBody } from '../api/types.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  ) as unknown as typeof fetch;
}

describe('createApiClient：请求构造', () => {
  it('带上身份头，走相对路径（开发期由 Vite 代理到后端）', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ round: { id: 1 }, quote: null }));
    const client = createApiClient({ fetchImpl, userId: 42, username: 'trader' });

    await client.current();

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('/api/prediction/current');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-user-id']).toBe('42');
    expect(headers['x-username']).toBe('trader');
  });

  it('匿名叫法不带 username 头（后端有默认值）', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({}));
    const client = createApiClient({ fetchImpl });
    await client.pnl();
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-username']).toBeUndefined();
    expect(headers['x-user-id']).toBe('1');
  });

  it('baseUrl 前缀可用', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({}));
    const client = createApiClient({ fetchImpl, baseUrl: 'http://127.0.0.1:8787' });
    await client.live();
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(
      'http://127.0.0.1:8787/api/prediction/live',
    );
  });
});

describe('createApiClient：各端点', () => {
  it('buy 发 POST + JSON body', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ id: 9, side: 'UP' }));
    const client = createApiClient({ fetchImpl });
    const bet = await client.buy('UP', 100);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('/api/prediction/buy');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).body).toBe(JSON.stringify({ side: 'UP', amount: 100 }));
    expect(bet.id).toBe(9);
  });

  it('sell 没给份数时不带查询参数，给了就带上', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ id: 1 }));
    const client = createApiClient({ fetchImpl });

    await client.sell(7);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(
      '/api/prediction/sell/7',
    );

    await client.sell(7, 50);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![0]).toBe(
      '/api/prediction/sell/7?contracts=50',
    );
  });

  it('分页参数带默认值', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ rows: [], total: 0 }));
    const client = createApiClient({ fetchImpl });
    await client.bets();
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(
      '/api/prediction/bets?pageNum=1&pageSize=10',
    );
    await client.rounds(3, 5);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![0]).toBe(
      '/api/prediction/rounds?pageNum=3&pageSize=5',
    );
  });
});

describe('错误处理：把后端的错误码原样带出来', () => {
  it('非 2xx 抛 ApiError，含状态码与领域错误码', async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse({ error: { code: 'ROUND_LOCKED', message: '回合已封盘，等待结算' } }, 409),
    );
    const client = createApiClient({ fetchImpl });

    await expect(client.buy('UP', 10)).rejects.toThrow(ApiError);
    try {
      await client.buy('UP', 10);
    } catch (e) {
      const err = e as ApiError;
      expect(err.status).toBe(409);
      expect(err.code).toBe('ROUND_LOCKED');
      expect(err.message).toBe('回合已封盘，等待结算');
      expect(err.retryable).toBe(false);
    }
  });

  it('503 / PRICE_UNAVAILABLE 标记为可重试（UI 用弱提示）', async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse({ error: { code: 'PRICE_UNAVAILABLE', message: '盘口不可用' } }, 503),
    );
    const client = createApiClient({ fetchImpl });
    await expect(client.buy('UP', 10)).rejects.toMatchObject({ retryable: true });
  });

  it('响应体不是 JSON 时也能给出可读消息', async () => {
    const fetchImpl = mockFetch(async () => new Response('502 Bad Gateway', { status: 502 }));
    const client = createApiClient({ fetchImpl });
    await expect(client.current()).rejects.toMatchObject({ status: 502, code: 'INTERNAL_ERROR' });
  });

  it('错误体缺字段时回落到默认码', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({} as ApiErrorBody, 500));
    const client = createApiClient({ fetchImpl });
    await expect(client.current()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

describe('stream：SSE 事件分发', () => {
  class FakeEventSource implements EventSourceLike {
    listeners = new Map<string, Array<(e: { data: string }) => void>>();
    closed = false;

    addEventListener(type: string, listener: (event: { data: string }) => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }

    close(): void {
      this.closed = true;
    }

    emit(type: string, data: unknown): void {
      for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
    }
  }

  it('按事件名分发 round / market / activity，并在退订时关闭连接', () => {
    const source = new FakeEventSource();
    const client = createApiClient({
      eventSourceFactory: (url) => {
        expect(url).toBe('/api/prediction/stream');
        return source;
      },
    });

    const rounds: unknown[] = [];
    const markets: unknown[] = [];
    const activities: unknown[] = [];
    const unsubscribe = client.stream({
      onRound: (r) => rounds.push(r),
      onMarket: (m) => markets.push(m),
      onActivity: (a) => activities.push(a),
    });

    source.emit('round', { id: 1, status: 'OPEN', remainingSeconds: 120 });
    source.emit('market', { upBid: 0.49, upAsk: 0.5, downBid: 0.49, downAsk: 0.5, ts: 1 });
    source.emit('activity', { username: 're***', side: 'UP', amount: 10, ts: 2 });

    expect(rounds).toEqual([{ id: 1, status: 'OPEN', remainingSeconds: 120 }]);
    expect(markets).toHaveLength(1);
    expect(activities).toHaveLength(1);

    unsubscribe();
    expect(source.closed).toBe(true);
  });

  it('坏 JSON 不会让订阅者崩，只是丢掉这一条', () => {
    const source = new FakeEventSource();
    const client = createApiClient({ eventSourceFactory: () => source });
    const seen: unknown[] = [];
    client.stream({ onMarket: (m) => seen.push(m) });

    for (const fn of source.listeners.get('market') ?? []) fn({ data: 'not json' });
    expect(seen).toHaveLength(0);

    source.emit('market', { upBid: 1, upAsk: null, downBid: null, downAsk: null, ts: 3 });
    expect(seen).toHaveLength(1);
  });

  it('只订阅传入的处理器', () => {
    const source = new FakeEventSource();
    const client = createApiClient({ eventSourceFactory: () => source });
    client.stream({ onActivity: () => undefined });
    expect(source.listeners.has('round')).toBe(false);
    expect(source.listeners.has('market')).toBe(false);
    expect(source.listeners.has('activity')).toBe(true);
  });
});
