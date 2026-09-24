import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Positions } from '../components/Positions.tsx';
import { RoundHistory } from '../components/RoundHistory.tsx';
import type { BetView, RoundView } from '../api/types.ts';
import { fakeServer, makeFakeClient } from './fakeClient.ts';

const WS = 1_790_000_000 - (1_790_000_000 % 300);

function bet(over: Partial<BetView> = {}): BetView {
  return {
    id: 1,
    roundId: 1,
    windowStart: WS,
    side: 'UP',
    contracts: 200,
    cost: 100,
    avgPrice: 0.5,
    payout: null,
    status: 'ACTIVE',
    createdAt: '2026-09-23 12:25:42',
    currentValue: 120,
    ...over,
  };
}

function round(over: Partial<RoundView> = {}): RoundView {
  return {
    id: 1,
    windowStart: WS,
    startPrice: 85_000,
    endPrice: 85_120,
    outcome: 'UP',
    status: 'SETTLED',
    remainingSeconds: 0,
    serverTimeMs: WS * 1000,
    ...over,
  };
}

describe('Positions：持仓与卖出', () => {
  it('空态提示先下注', async () => {
    const { client } = makeFakeClient(fakeServer());
    render(<Positions client={client} refreshKey={0} currentWindowStart={WS} onChanged={() => undefined} />);
    await waitFor(() => expect(screen.getByText(/还没有下过注/)).toBeInTheDocument());
  });

  it('列出方向、份数、均价、成本、当前估值与盈亏', async () => {
    const server = fakeServer({ bets: [bet()] });
    const { client } = makeFakeClient(server);
    render(<Positions client={client} refreshKey={0} currentWindowStart={WS} onChanged={() => undefined} />);

    await waitFor(() => expect(screen.getByText('200.0000')).toBeInTheDocument());
    expect(screen.getByText('50¢')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText('$120.00')).toBeInTheDocument();
    // 未实现盈亏 +20
    expect(screen.getByText('+20.00')).toHaveClass('up');
  });

  it('只有当前回合的持仓能卖，旧回合显示原因', async () => {
    const server = fakeServer({
      bets: [
        bet({ id: 1, windowStart: WS }),
        bet({ id: 2, windowStart: WS - 300 }),
        bet({ id: 3, status: 'WON', payout: 200, currentValue: null }),
      ],
    });
    const { client } = makeFakeClient(server);
    render(<Positions client={client} refreshKey={0} currentWindowStart={WS} onChanged={() => undefined} />);

    await waitFor(() => expect(screen.getByText('非本回合')).toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: '卖出' })).toHaveLength(1);
    expect(screen.getByText('猜对')).toBeInTheDocument();
  });

  it('卖出走半仓（部分卖出），成功后给出到手金额', async () => {
    const server = fakeServer({
      bets: [bet()],
      sellImpl: (_id, contracts) => ({
        ...bet(),
        contracts: contracts ?? 200,
        status: 'SOLD',
        payout: 58.32,
      }),
    });
    const { client } = makeFakeClient(server);
    const changed: number[] = [];
    render(
      <Positions
        client={client}
        refreshKey={0}
        currentWindowStart={WS}
        onChanged={() => changed.push(1)}
      />,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: '卖出' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '卖出' }));

    await waitFor(() => expect(screen.getByText(/已卖出 100.0000 份 看涨/)).toBeInTheDocument());
    // 半仓 = 100 份，且带上了 contracts 参数
    expect(server.calls.some((u) => u.includes('contracts=100'))).toBe(true);
    expect(changed).toHaveLength(1);
  });

  it('卖出被后端拒绝时显示中文原因', async () => {
    const server = fakeServer({ bets: [bet()], sellError: { status: 409, code: 'ROUND_LOCKED' } });
    const { client } = makeFakeClient(server);
    render(<Positions client={client} refreshKey={0} currentWindowStart={WS} onChanged={() => undefined} />);

    await waitFor(() => expect(screen.getByRole('button', { name: '卖出' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '卖出' }));
    await waitFor(() => expect(screen.getByText('回合已封盘，等结算')).toBeInTheDocument());
  });

  it('刷新按钮会重新拉取', async () => {
    const server = fakeServer({ bets: [bet()] });
    const { client } = makeFakeClient(server);
    render(<Positions client={client} refreshKey={0} currentWindowStart={WS} onChanged={() => undefined} />);

    await waitFor(() => expect(screen.getByText('200.0000')).toBeInTheDocument());
    const before = server.calls.filter((u) => u.includes('prediction/bets')).length;
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() =>
      expect(server.calls.filter((u) => u.includes('prediction/bets')).length).toBe(before + 1),
    );
  });
});

describe('RoundHistory：往期回合', () => {
  it('空态提示', async () => {
    const { client } = makeFakeClient(fakeServer());
    render(<RoundHistory client={client} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('还没有已结算的回合')).toBeInTheDocument());
  });

  it('并排显示目标价与结算价，结果标涨跌', async () => {
    const server = fakeServer({ rounds: [round()] });
    const { client } = makeFakeClient(server);
    render(<RoundHistory client={client} refreshKey={0} />);

    await waitFor(() => expect(screen.getByText('$85,000.00')).toBeInTheDocument());
    expect(screen.getByText('$85,120.00')).toBeInTheDocument();
    // 涨跌色在单元格上，文字本身是加粗的 <b>
    expect(screen.getByText('涨').closest('td')).toHaveClass('up');
    expect(screen.getByText('已结算')).toBeInTheDocument();
  });

  it('作废回合的结算价为 --，结果为「作废」', async () => {
    const server = fakeServer({
      rounds: [round({ outcome: 'VOID', endPrice: null })],
    });
    const { client } = makeFakeClient(server);
    render(<RoundHistory client={client} refreshKey={0} />);

    await waitFor(() => expect(screen.getByText('作废')).toBeInTheDocument());
    expect(screen.getAllByText('--').length).toBeGreaterThan(0);
  });

  it('只有一页时不显示翻页控件', async () => {
    const server = fakeServer({ rounds: [round()] });
    const { client } = makeFakeClient(server);
    render(<RoundHistory client={client} refreshKey={0} />);

    await waitFor(() => expect(screen.getByText('$85,000.00')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '下一页' })).toBeNull();
  });
});
