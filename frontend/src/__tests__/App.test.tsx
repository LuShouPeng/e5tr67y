import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from '../App.tsx';
import { fakeServer, makeFakeClient } from './fakeClient.ts';

describe('App：骨架与回合状态', () => {
  it('渲染品牌与顶栏回合信息', async () => {
    const { client } = makeFakeClient(fakeServer());
    render(<App client={client} />);

    expect(screen.getByText('BTC 5 分钟涨跌预测')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('可交易')).toBeInTheDocument());
    expect(screen.getByText(/回合 /)).toBeInTheDocument();
  });

  it('展示目标价与盘口', async () => {
    const { client } = makeFakeClient(fakeServer());
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByText('$85,000.00')).toBeInTheDocument());
    // UP 中价 (0.48+0.49)/2 = 0.485 → 48.5¢
    expect(screen.getByText('48.5¢')).toBeInTheDocument();
    expect(screen.getByText('51.5¢')).toBeInTheDocument();
  });

  it('目标价还没到时不显示 0，而显示「获取中」', async () => {
    const server = fakeServer();
    server.current.round.startPrice = null;
    server.current.quote = null;
    const { client } = makeFakeClient(server);
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByText('获取中')).toBeInTheDocument());
    expect(screen.getByText('暂无报价，等行情接入')).toBeInTheDocument();
  });

  it('已封盘的回合用封盘徽标', async () => {
    const server = fakeServer();
    server.current.round.status = 'LOCKED';
    const { client } = makeFakeClient(server);
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByText('已封盘')).toBeInTheDocument());
  });

  it('接口失败给出中文提示与重试按钮', async () => {
    const { client } = makeFakeClient(
      fakeServer({ failWith: { status: 503, code: 'PRICE_UNAVAILABLE' } }),
    );
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByText('盘口不可用，稍后重试')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('未知错误码回落到后端原文', async () => {
    const { client } = makeFakeClient(fakeServer({ failWith: { status: 500, code: 'WEIRD_CODE' } }));
    render(<App client={client} />);

    // ERROR_HINT 里没有这个码 → 直接用后端返回的 message（假后端把 code 当 message 回）
    await waitFor(() => expect(screen.getByText('WEIRD_CODE')).toBeInTheDocument());
  });

  it('玩法说明里写明「相等算涨」与费率乘式', async () => {
    const { client } = makeFakeClient(fakeServer());
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByText('可交易')).toBeInTheDocument());
    expect(screen.getByText(/相等也算涨/)).toBeInTheDocument();
    expect(screen.getByText(/份数 × 7% × 价格 × \(1 − 价格\)/)).toBeInTheDocument();
  });

  it('点击赔率盘口的方向按钮会同步到下注面板', async () => {
    const { client } = makeFakeClient(fakeServer());
    const { getByRole, getByText } = render(<App client={client} />);
    await waitFor(() => expect(getByText('可交易')).toBeInTheDocument());

    // 下单面板的「看涨」默认选中
    expect(getByRole('button', { name: '看涨' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(getByRole('button', { name: '下注跌' }));
    await waitFor(() =>
      expect(getByRole('button', { name: '看跌' })).toHaveAttribute('aria-pressed', 'true'),
    );
  });
});
