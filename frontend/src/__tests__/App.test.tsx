import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from '../App.tsx';
import { ApiError, createApiClient } from '../api/client.ts';
import type { CurrentResponse } from '../api/types.ts';

const ROUND: CurrentResponse = {
  round: {
    id: 1,
    windowStart: new Date(2026, 8, 23, 17, 5, 0).getTime() / 1000,
    startPrice: 85_990.82,
    endPrice: null,
    outcome: null,
    status: 'OPEN',
    remainingSeconds: 264,
    serverTimeMs: 0,
  },
  quote: {
    up: { bid: 0.68, ask: 0.69 },
    down: { bid: 0.31, ask: 0.32 },
    ts: 0,
  },
};

function clientReturning(body: unknown, status = 200) {
  return createApiClient({
    fetchImpl: async () => new Response(JSON.stringify(body), { status }),
  });
}

describe('App：骨架与回合状态', () => {
  it('渲染品牌、回合区间、封盘状态与倒计时', async () => {
    render(<App client={clientReturning(ROUND)} />);

    expect(screen.getByText('BTC 5 分钟涨跌预测')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('回合 17:05–17:10')).toBeInTheDocument());
    expect(screen.getByText('可交易')).toBeInTheDocument();
    expect(screen.getByText('剩余 04:24')).toBeInTheDocument();
  });

  it('展示目标价与盘口', async () => {
    render(<App client={clientReturning(ROUND)} />);
    await waitFor(() => expect(screen.getByText('$85,990.82')).toBeInTheDocument());
    expect(screen.getByText('涨 0.69 / 跌 0.32')).toBeInTheDocument();
  });

  it('目标价还没到时不显示 0，而显示「获取中」', async () => {
    const pending: CurrentResponse = {
      ...ROUND,
      round: { ...ROUND.round, startPrice: null },
      quote: null,
    };
    render(<App client={clientReturning(pending)} />);
    await waitFor(() => expect(screen.getByText('获取中')).toBeInTheDocument());
    expect(screen.getByText('暂无报价')).toBeInTheDocument();
  });

  it('已封盘的回合用封盘徽标', async () => {
    const locked: CurrentResponse = { ...ROUND, round: { ...ROUND.round, status: 'LOCKED' } };
    render(<App client={clientReturning(locked)} />);
    await waitFor(() => expect(screen.getByText('已封盘')).toBeInTheDocument());
  });

  it('接口失败给出中文提示与重试按钮', async () => {
    const failing = createApiClient({
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: 'PRICE_UNAVAILABLE', message: 'x' } }), {
          status: 503,
        }),
    });
    render(<App client={failing} />);
    await waitFor(() => expect(screen.getByText('盘口不可用，稍后重试')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('未知错误码回落到通用文案', async () => {
    const failing = createApiClient({
      fetchImpl: async () => {
        throw new ApiError(500, 'WEIRD_CODE', 'boom');
      },
    });
    render(<App client={failing} />);
    await waitFor(() => expect(screen.getByText('加载失败，请稍后重试')).toBeInTheDocument());
  });

  it('玩法说明里写明「相等算涨」与费率为乘式', async () => {
    render(<App client={clientReturning(ROUND)} />);
    // 先等异步加载落地，避免断言时组件还在更新（act 警告）
    await screen.findByText('可交易');
    expect(screen.getByText(/相等也算涨/)).toBeInTheDocument();
    expect(screen.getByText(/份数 × 7% × 价格 × \(1 − 价格\)/)).toBeInTheDocument();
  });
});
