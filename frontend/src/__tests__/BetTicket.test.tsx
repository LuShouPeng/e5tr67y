import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createApiClient } from '../api/client.ts';
import { BetTicket } from '../components/BetTicket.tsx';
import { fakeServer, makeFakeClient } from './fakeClient.ts';

function setup(overrides: Parameters<typeof fakeServer>[0] = {}, props: Partial<Parameters<typeof BetTicket>[0]> = {}) {
  const server = fakeServer(overrides);
  const { client } = makeFakeClient(server);
  const submitted: string[] = [];
  const utils = render(
    <BetTicket
      client={props.client ?? client}
      side={props.side ?? 'UP'}
      onSideChange={props.onSideChange ?? (() => undefined)}
      tradable={props.tradable ?? true}
      quoteStale={props.quoteStale ?? false}
      balance={props.balance ?? 100_000}
      onSubmitted={(m) => submitted.push(m)}
    />,
  );
  return { ...utils, server, submitted };
}

describe('BetTicket：试算以后端为准', () => {
  it('默认 100 金额，试算后显示份数、成本、手续费、共扣与回款', async () => {
    setup();

    // 默认按 50¢ 与 7% 费率：100 USDT → 200 份，成本 100，费 3.5
    await waitFor(() => expect(screen.getByText('200.0000')).toBeInTheDocument());
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText('50¢')).toBeInTheDocument();
    expect(screen.getByText('$3.5000')).toBeInTheDocument();
    expect(screen.getByText('$103.50')).toBeInTheDocument();
    expect(screen.getByText('$200.00')).toBeInTheDocument();
    // 猜对净赚 = 200 - 103.5
    expect(screen.getByText('$96.50')).toBeInTheDocument();
  });

  it('面板里不重复实现费率：数字来自 /preview 接口', async () => {
    const { server } = setup();
    await waitFor(() => expect(screen.getByText('200.0000')).toBeInTheDocument());
    expect(server.calls.some((u) => u.includes('/api/prediction/preview'))).toBe(true);
  });

  it('金额预置档位切换后重新试算', async () => {
    setup();
    await waitFor(() => expect(screen.getByText('200.0000')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '500' }));
    // 500 USDT @50¢ → 1000 份，费 17.5
    await waitFor(() => expect(screen.getByText('1,000.0000')).toBeInTheDocument());
    expect(screen.getByText('$17.5000')).toBeInTheDocument();
  });

  it('上限按钮按最坏手续费留额度，不会试算就超扣', async () => {
    setup({}, { balance: 10.7 });
    // 10.7 / 1.07 = 10.00
    fireEvent.click(screen.getByRole('button', { name: '上限' }));
    await waitFor(() =>
      expect((screen.getByLabelText('金额（USDT）') as HTMLInputElement).value).toBe('10.00'),
    );
  });

  it('金额越界时不试算，并锁住下单', async () => {
    const { server } = setup();
    // 先等首次试算落地
    await waitFor(() => expect(screen.getByText('200.0000')).toBeInTheDocument());
    const before = server.calls.filter((u) => u.includes('preview')).length;

    const input = screen.getByLabelText('金额（USDT）');
    fireEvent.change(input, { target: { value: '0' } });

    await waitFor(() => expect(screen.getByText('金额需在 1 ~ 10000 之间')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '买入看涨' })).toBeDisabled();
    // 非法金额不发试算请求
    expect(server.calls.filter((u) => u.includes('preview')).length).toBe(before);
  });

  it('非数字输入被过滤', () => {
    setup();
    const input = screen.getByLabelText('金额（USDT）') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1a2b3' } });
    expect(input.value).toBe('123');
  });
});

describe('BetTicket：下单与错误提示', () => {
  it('下单成功给出份数与成本回执', async () => {
    const { submitted, server } = setup({
      buyImpl: (side, amount) => ({
        id: 7,
        side,
        contracts: 200,
        cost: amount,
        avgPrice: 0.5,
        status: 'ACTIVE',
        payout: null,
        roundId: 1,
        windowStart: 0,
        createdAt: '',
        currentValue: null,
      }),
    });

    await waitFor(() => expect(screen.getByText('200.0000')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '买入看涨' }));

    await waitFor(() => expect(screen.getByText(/已买入 200.0000 份 看涨/)).toBeInTheDocument());
    expect(submitted).toEqual(['买入成功']);
    expect(server.calls.some((u) => u.includes('/api/prediction/buy'))).toBe(true);
  });

  it('后端拒绝时显示中文原因（按错误码映射）', async () => {
    setup({ buyError: { status: 409, code: 'ROUND_LOCKED' } });
    await waitFor(() => expect(screen.getByText('200.0000')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '买入看涨' }));
    await waitFor(() => expect(screen.getByText('回合已封盘，等结算')).toBeInTheDocument());
  });

  it('余额不足时给出明确提示', async () => {
    setup({ buyError: { status: 400, code: 'INSUFFICIENT_BALANCE' } });
    await waitFor(() => expect(screen.getByText('200.0000')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '买入看涨' }));
    await waitFor(() => expect(screen.getByText('游戏钱包余额不足')).toBeInTheDocument());
  });

  it('封盘 / 盘口超龄 / 金额非法都会锁住下单并说明原因', async () => {
    const locked = setup({}, { tradable: false });
    expect(screen.getByRole('button', { name: '买入看涨' })).toBeDisabled();
    expect(screen.getByText('回合已封盘，等待结算')).toBeInTheDocument();
    locked.unmount();

    const stale = setup({}, { quoteStale: true });
    expect(screen.getByRole('button', { name: '买入看涨' })).toBeDisabled();
    expect(screen.getByText('盘口已超龄，稍后重试')).toBeInTheDocument();
  });

  it('试算被拒（盘口不可用）时不显示误导性的 0', async () => {
    setup({ previewError: { status: 503, code: 'PRICE_UNAVAILABLE' } });
    await waitFor(() => expect(screen.getByText('盘口不可用，稍后重试')).toBeInTheDocument());
    expect(screen.queryByText('获得份数')).toBeNull();
  });
});

describe('BetTicket：切换方向', () => {
  it('点方向按钮把选择抛给上层', () => {
    const picked: string[] = [];
    setup({}, { onSideChange: (s) => picked.push(s) });
    fireEvent.click(screen.getByRole('button', { name: '看跌' }));
    expect(picked).toEqual(['DOWN']);
  });

  it('按当前方向试算', async () => {
    const { server } = setup({}, { side: 'DOWN' });
    await waitFor(() => expect(server.calls.some((u) => u.includes('side=DOWN'))).toBe(true));
  });
});

describe('BetTicket：未知错误码回落', () => {
  it('没有映射的错误码显示后端原文', async () => {
    const server = fakeServer({ buyError: { status: 500, code: 'WEIRD' } });
    const client = createApiClient({
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: 'WEIRD', message: '后端原话' } }), { status: 500 }),
    });
    void server;

    render(
      <BetTicket
        client={client}
        side="UP"
        onSideChange={() => undefined}
        tradable
        quoteStale={false}
        balance={null}
        onSubmitted={() => undefined}
      />,
    );
    // 试算也失败 → 走试算错误通道，显示后端原文而不是崩溃
    await waitFor(() => expect(screen.getByText('后端原话')).toBeInTheDocument());
  });
});
