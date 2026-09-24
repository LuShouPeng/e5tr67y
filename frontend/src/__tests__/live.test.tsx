import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LiveFeed } from '../components/LiveFeed.tsx';
import { PnlCard } from '../components/PnlCard.tsx';
import { createApiClient } from '../api/client.ts';
import type { LiveBetView, PnlView } from '../api/types.ts';
import { mergeActivities } from '../lib/market.ts';
import { fakeServer, makeFakeClient } from './fakeClient.ts';

const NOW = Date.now();

function activity(over: Partial<LiveBetView> = {}): LiveBetView {
  return { username: 're***', side: 'UP', amount: 100, ts: NOW, createdAt: '', ...over };
}

function pnl(over: Partial<PnlView> = {}): PnlView {
  return {
    totalBets: 5,
    activeBets: 1,
    wonBets: 2,
    lostBets: 1,
    soldBets: 1,
    voidBets: 0,
    settledBets: 4,
    winRate: 50,
    totalCost: 330,
    realizedPnl: 58.32,
    activeCost: 100,
    activeValue: 120,
    unrealizedPnl: 20,
    totalPnl: 78.32,
    gameBalance: 99_895.8,
    equity: 100_015.8,
    ...over,
  };
}

describe('mergeActivities：REST 历史与 SSE 实时去重合并', () => {
  it('两路合并，SSE 的排在前面', () => {
    const merged = mergeActivities(
      [activity({ ts: 200, amount: 50 })],
      [activity({ ts: 100, amount: 10 }), activity({ ts: 200, amount: 50 })],
    );
    expect(merged.map((m) => m.ts)).toEqual([200, 100]);
  });

  it('内容相同只保留一条（REST 回包晚于推送时会重复）', () => {
    const same = activity({ ts: 300, amount: 77 });
    expect(mergeActivities([same], [same])).toHaveLength(1);
  });

  it('内容不同则都保留（同一秒的两个人不该被吞掉）', () => {
    const merged = mergeActivities(
      [activity({ ts: 300, username: 'aa***', amount: 10 })],
      [activity({ ts: 300, username: 'bb***', amount: 10 })],
    );
    expect(merged).toHaveLength(2);
  });

  it('超出上限截断', () => {
    const many = Array.from({ length: 30 }, (_, i) => activity({ ts: 1000 + i, amount: i }));
    expect(mergeActivities(many, many, 20)).toHaveLength(20);
  });

  it('两路都空时返回空数组', () => {
    expect(mergeActivities([], [])).toEqual([]);
  });
});

describe('LiveFeed：实时成交流', () => {
  it('空态提示', async () => {
    const { client } = makeFakeClient(fakeServer());
    render(<LiveFeed client={client} activities={[]} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('还没有人下注，做第一个')).toBeInTheDocument());
  });

  it('把 SSE 推送与 REST 历史合起来显示，并给出相对时间', async () => {
    const server = fakeServer({
      live: { rows: [{ username: 'ol***', side: 'DOWN', amount: 50, ts: NOW - 120_000, createdAt: '' }] },
    });
    const { client } = makeFakeClient(server);
    render(
      <LiveFeed
        client={client}
        activities={[activity({ username: 'ne***', side: 'UP', amount: 100, ts: NOW })]}
        refreshKey={0}
      />,
    );

    await waitFor(() => expect(screen.getByText('ne***')).toBeInTheDocument());
    expect(screen.getByText('ol***')).toBeInTheDocument();
    expect(screen.getByText('看涨')).toBeInTheDocument();
    expect(screen.getByText('看跌')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText('刚刚')).toBeInTheDocument();
    expect(screen.getByText('2 分钟前')).toBeInTheDocument();
  });

  it('用户名为空时显示匿名，不显示空白', async () => {
    const { client } = makeFakeClient(fakeServer());
    render(<LiveFeed client={client} activities={[activity({ username: '' })]} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('匿名')).toBeInTheDocument());
  });
});

describe('PnlCard：已实现与未实现分开摆', () => {
  it('渲染总盈亏/已实现/未实现/胜率与战绩', async () => {
    const { client } = makeFakeClient(fakeServer({ pnl: pnl() }));
    render(<PnlCard client={client} refreshKey={0} />);

    await waitFor(() => expect(screen.getByText('+78.32')).toBeInTheDocument());
    expect(screen.getByText('+58.32')).toBeInTheDocument();
    expect(screen.getByText('+20.00')).toBeInTheDocument();
    expect(screen.getByText('50.00%')).toBeInTheDocument();
    expect(screen.getByText('$330.00')).toBeInTheDocument();
    expect(screen.getByText('$100.00 / $120.00')).toBeInTheDocument();
    expect(screen.getByText('4 笔已了结')).toBeInTheDocument();
  });

  it('总权益用高亮，余额可被上层覆盖', async () => {
    const { client } = makeFakeClient(fakeServer({ pnl: pnl() }));
    render(<PnlCard client={client} refreshKey={0} balance={88_888} />);

    await waitFor(() => expect(screen.getByText('$100,015.80')).toBeInTheDocument());
    expect(screen.getByText('$88,888.00')).toBeInTheDocument();
  });

  it('亏损用跌色', async () => {
    const { client } = makeFakeClient(
      fakeServer({ pnl: pnl({ totalPnl: -50, realizedPnl: -30, unrealizedPnl: -20 }) }),
    );
    render(<PnlCard client={client} refreshKey={0} />);

    await waitFor(() => expect(screen.getByText('-50.00')).toBeInTheDocument());
    expect(screen.getByText('-50.00')).toHaveClass('down');
  });

  it('作废笔数大于 0 时才显示', async () => {
    const { client: withVoid } = makeFakeClient(fakeServer({ pnl: pnl({ voidBets: 2 }) }));
    const first = render(<PnlCard client={withVoid} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText(/2 作废/)).toBeInTheDocument());
    first.unmount();

    const { client: noVoid } = makeFakeClient(fakeServer({ pnl: pnl() }));
    render(<PnlCard client={noVoid} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText(/1 卖出/)).toBeInTheDocument());
    expect(screen.queryByText(/作废/)).toBeNull();
  });

  it('接口失败时给出提示而不是空白', async () => {
    const failing = createApiClient({
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }), {
          status: 500,
        }),
    });
    render(<PnlCard client={failing} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('服务内部错误')).toBeInTheDocument());
  });
});
