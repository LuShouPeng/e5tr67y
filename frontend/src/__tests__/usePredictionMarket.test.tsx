import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { usePredictionMarket } from '../hooks/usePredictionMarket.ts';
import { fakeServer, makeFakeClient } from './fakeClient.ts';

describe('usePredictionMarket：回合、盘口与倒计时', () => {
  /**
   * 这里刻意用真实定时器。
   *
   * hook 的行为依赖真实时钟（倒计时、盘口是否超龄都直接读 Date.now()），
   * 假定时器会把 Date.now() 也冻住，断言就失去意义（试过：7 个用例直接挂）。
   * 代价是 1 秒心跳偶尔在 act 之外触发一次状态更新，React 会打一行开发模式提示，
   * 属于噪声而非失败。
   */

  it('首屏拉一次 current，落到 round 与 quote', async () => {
    const server = fakeServer();
    const { client } = makeFakeClient(server);
    const { result } = renderHook(() => usePredictionMarket(client));

    await waitFor(() => expect(result.current.round).not.toBeNull());
    expect(server.currentCalls).toBe(1);
    expect(result.current.round?.status).toBe('OPEN');
    expect(result.current.quote?.up.ask).toBe(0.49);
    expect(result.current.error).toBeNull();
  });

  it('倒计时按服务端校准时钟算，不受本机时钟偏差影响', async () => {
    const server = fakeServer();
    // 服务端说此刻是窗口起点，本机实际慢 60 秒
    const windowStart = server.current.round.windowStart;
    server.current.round.serverTimeMs = windowStart * 1000 + 60_000;
    const { client } = makeFakeClient(server);

    const { result } = renderHook(() => usePredictionMarket(client));
    await waitFor(() => expect(result.current.round).not.toBeNull());

    // 校准后已过去 60 秒 → 剩余 240 秒（而不是本机时钟算出的 300）
    expect(result.current.countdown).toBe(240);
  });

  it('SSE 推送新的盘口后，quote 跟着变，且不再有旧价标记', async () => {
    const server = fakeServer();
    const { client, stream } = makeFakeClient(server);
    const { result } = renderHook(() => usePredictionMarket(client));
    await waitFor(() => expect(result.current.round).not.toBeNull());

    act(() => {
      stream.emit('market', {
        upBid: 0.8, upAsk: 0.81, downBid: 0.19, downAsk: 0.2,
        ts: Date.now(), degraded: false,
      });
    });

    expect(result.current.quote?.up).toEqual({ bid: 0.8, ask: 0.81 });
    expect(result.current.quote?.down).toEqual({ bid: 0.19, ask: 0.2 });
    expect(result.current.quoteStale).toBe(false);
  });

  it('降级标记随推送流转', async () => {
    const server = fakeServer();
    const { client, stream } = makeFakeClient(server);
    const { result } = renderHook(() => usePredictionMarket(client));

    act(() => {
      stream.emit('market', {
        upBid: 0.5, upAsk: 0.51, downBid: 0.49, downAsk: 0.5, ts: Date.now(), degraded: true,
      });
    });
    expect(result.current.degraded).toBe(true);

    act(() => {
      stream.emit('market', {
        upBid: 0.5, upAsk: 0.51, downBid: 0.49, downAsk: 0.5, ts: Date.now(),
      });
    });
    expect(result.current.degraded).toBe(false);
  });

  it('成交流逐条累积，最多保留 30 条', async () => {
    const server = fakeServer();
    const { client, stream } = makeFakeClient(server);
    const { result } = renderHook(() => usePredictionMarket(client));

    act(() => {
      for (let i = 0; i < 40; i++) {
        stream.emit('activity', { username: `u${i}***`, side: 'UP', amount: i, ts: i, createdAt: '' });
      }
    });

    expect(result.current.activities).toHaveLength(30);
    // 最新的在最前面
    expect(result.current.activities[0]?.amount).toBe(39);
  });

  it('旧回合的结算推送不覆盖当前回合，只补拉一次 REST', async () => {
    const server = fakeServer();
    const { client, stream } = makeFakeClient(server);
    const { result } = renderHook(() => usePredictionMarket(client));
    await waitFor(() => expect(result.current.round).not.toBeNull());

    const before = server.currentCalls;
    const currentWs = result.current.round!.windowStart;

    act(() => {
      stream.emit('round', {
        ...server.current.round,
        windowStart: currentWs - 300,
        status: 'SETTLED',
        outcome: 'UP',
      });
    });

    // 当前回合不被旧推送顶掉
    expect(result.current.round?.windowStart).toBe(currentWs);
    await waitFor(() => expect(server.currentCalls).toBe(before + 1));
  });

  it('新回合推送直接生效', async () => {
    const server = fakeServer();
    const { client, stream } = makeFakeClient(server);
    const { result } = renderHook(() => usePredictionMarket(client));
    await waitFor(() => expect(result.current.round).not.toBeNull());

    const nextWs = result.current.round!.windowStart + 300;
    act(() => {
      stream.emit('round', {
        ...server.current.round,
        id: 2,
        windowStart: nextWs,
        startPrice: 86_000,
        serverTimeMs: nextWs * 1000,
      });
    });

    expect(result.current.round?.windowStart).toBe(nextWs);
    expect(result.current.round?.startPrice).toBe(86_000);
  });

  it('接口失败时给出错误码，供 UI 映射中文提示', async () => {
    const server = fakeServer({ failWith: { status: 503, code: 'PRICE_UNAVAILABLE' } });
    const { client } = makeFakeClient(server);
    const { result } = renderHook(() => usePredictionMarket(client));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.code).toBe('PRICE_UNAVAILABLE');
  });

  it('SSE 报错时走同一条错误通道', async () => {
    const server = fakeServer();
    const { client, stream } = makeFakeClient(server);
    const { result } = renderHook(() => usePredictionMarket(client));

    act(() => {
      stream.emitRaw('error', 'boom');
    });
    expect(result.current.error?.code).toBe('STREAM_DOWN');
  });

  it('价格序列从 REST 拉取，并按窗口裁剪', async () => {
    const server = fakeServer();
    const now = Date.now();
    server.priceHistory = {
      points: [
        { time: now - 400_000, price: 1 },
        { time: now - 1000, price: 85_500 },
      ],
      latest: { time: now - 1000, price: 85_500 },
    };
    const { client } = makeFakeClient(server);
    const { result } = renderHook(() => usePredictionMarket(client));

    await waitFor(() => expect(result.current.priceHistory.length).toBeGreaterThan(0));
    expect(result.current.priceHistory).toEqual([{ time: now - 1000, price: 85_500 }]);
  });

  it('退订时关闭 SSE 连接', async () => {
    const server = fakeServer();
    const { client, stream } = makeFakeClient(server);
    const { unmount } = renderHook(() => usePredictionMarket(client));
    expect(stream.sources).toBe(1);

    unmount();
    expect(stream.closed).toBe(1);
  });
});
