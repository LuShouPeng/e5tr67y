import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { OddsBoard } from '../components/OddsBoard.tsx';
import { PriceChart } from '../components/PriceChart.tsx';
import { RoundPanel } from '../components/RoundPanel.tsx';
import type { QuoteBook, RoundView } from '../api/types.ts';

const QUOTE: QuoteBook = {
  up: { bid: 0.68, ask: 0.69 },
  down: { bid: 0.31, ask: 0.32 },
  ts: Date.now(),
};

describe('OddsBoard：概率价按美分显示', () => {
  it('中价换算成美分，买一卖一分列', () => {
    render(<OddsBoard quote={QUOTE} />);
    // UP 中价 0.685 → 68.5¢
    expect(screen.getByText('68.5¢')).toBeInTheDocument();
    // DOWN 中价 0.315 → 31.5¢
    expect(screen.getByText('31.5¢')).toBeInTheDocument();
    expect(screen.getByText('68¢')).toBeInTheDocument();
    expect(screen.getByText('69¢')).toBeInTheDocument();
  });

  it('无盘口时给出提示，而不是显示 0¢', () => {
    render(<OddsBoard quote={null} />);
    expect(screen.getByText('暂无报价，等行情接入')).toBeInTheDocument();
    expect(screen.getAllByText('--').length).toBe(2);
  });

  it('买一为空时显示「空」（这一档没人接）', () => {
    render(<OddsBoard quote={{ up: { bid: null, ask: 0.69 }, down: { bid: 0.31, ask: null }, ts: 1 }} />);
    expect(screen.getAllByText('空').length).toBe(2);
  });

  it('超龄时提醒此时下单会被拒', () => {
    render(<OddsBoard quote={QUOTE} stale />);
    expect(screen.getByText(/超过 15 秒未更新/)).toBeInTheDocument();
  });

  it('点击按钮把方向带出去', async () => {
    const picks: string[] = [];
    const { getByRole } = render(<OddsBoard quote={QUOTE} onPick={(s) => picks.push(s)} />);
    getByRole('button', { name: '下注涨' }).click();
    getByRole('button', { name: '下注跌' }).click();
    expect(picks).toEqual(['UP', 'DOWN']);
  });
});

describe('PriceChart：手绘 SVG', () => {
  const points = [
    { time: 1000, price: 100 },
    { time: 2000, price: 110 },
    { time: 3000, price: 105 },
  ];

  it('点太少时显示等待态', () => {
    render(<PriceChart points={[{ time: 1, price: 1 }]} />);
    expect(screen.getByText('等待价格数据…')).toBeInTheDocument();
  });

  it('按点数生成折线，并标出最后一点', () => {
    const { container } = render(<PriceChart points={points} />);
    const path = container.querySelector('path')!;
    expect(path.getAttribute('d')?.match(/[ML]/g)).toHaveLength(3);
    expect(container.querySelector('circle')).not.toBeNull();
  });

  it('末价与起价比较决定涨绿跌红', () => {
    const up = render(<PriceChart points={points} />);
    expect(up.container.querySelector('path')?.getAttribute('stroke')).toBe('var(--up)');

    const down = render(
      <PriceChart points={[{ time: 1, price: 110 }, { time: 2, price: 100 }]} />,
    );
    expect(down.container.querySelector('path')?.getAttribute('stroke')).toBe('var(--down)');
  });

  it('给了目标价就画虚线参照线', () => {
    const { getByTestId, getByText } = render(<PriceChart points={points} targetPrice={108} />);
    expect(getByTestId('target-line')).toBeInTheDocument();
    expect(getByText(/目标价 \$108\.00/)).toBeInTheDocument();
  });

  it('没给目标价就不画参照线', () => {
    // 单独一个用例：RTL 的查询绑定在 document.body 上，同一次测试里多次渲染会互相看到
    const { queryByTestId } = render(<PriceChart points={points} />);
    expect(queryByTestId('target-line')).toBeNull();
  });

  it('价格恒定时不出现除零/NaN 坐标', () => {
    const flat = render(
      <PriceChart points={[{ time: 1, price: 100 }, { time: 2, price: 100 }]} />,
    );
    expect(flat.container.querySelector('path')?.getAttribute('d')).not.toMatch(/NaN/);
  });

  it('末价显示在标题里', () => {
    render(<PriceChart points={points} />);
    expect(screen.getByText('$105.00')).toBeInTheDocument();
  });
});

describe('RoundPanel：目标价是判涨跌的参照系', () => {
  const round: RoundView = {
    id: 1,
    windowStart: new Date(2026, 8, 23, 17, 5, 0).getTime() / 1000,
    startPrice: 85_000,
    endPrice: null,
    outcome: null,
    status: 'OPEN',
    remainingSeconds: 264,
    serverTimeMs: Date.now(),
  };
  const history = [
    { time: Date.now() - 60_000, price: 84_900 },
    { time: Date.now(), price: 85_100 },
  ];

  it('渲染回合区间与倒计时', () => {
    render(
      <RoundPanel round={round} countdown={264} clockOffsetMs={0} priceHistory={history} />,
    );
    expect(screen.getByText('17:05–17:10')).toBeInTheDocument();
    expect(screen.getByTestId('countdown')).toHaveTextContent('剩余 04:24');
  });

  it('目标价缺失时显示「获取中」，不显示 $0.00', () => {
    render(
      <RoundPanel
        round={{ ...round, startPrice: null }}
        countdown={100}
        clockOffsetMs={0}
        priceHistory={history}
      />,
    );
    expect(screen.getByText('获取中')).toBeInTheDocument();
  });

  it('价格高于目标价时距目标为正（涨色），低于时为负', () => {
    const { unmount } = render(
      <RoundPanel round={round} countdown={100} clockOffsetMs={0} priceHistory={history} />,
    );
    expect(screen.getByText('+$100.00')).toHaveClass('up');
    unmount();

    render(
      <RoundPanel
        round={round}
        countdown={100}
        clockOffsetMs={0}
        priceHistory={[{ time: Date.now(), price: 84_000 }]}
      />,
    );
    expect(screen.getByText('-$1,000.00')).toHaveClass('down');
  });

  it('降级行情时亮出提示', () => {
    render(
      <RoundPanel
        round={round}
        countdown={100}
        clockOffsetMs={0}
        priceHistory={history}
        degraded
      />,
    );
    expect(screen.getByText('本地模拟行情')).toBeInTheDocument();
  });

  it('没有回合时倒计时占位而不是 00:00', () => {
    render(<RoundPanel round={null} countdown={0} clockOffsetMs={0} priceHistory={[]} />);
    expect(screen.getByTestId('countdown')).toHaveTextContent('--:--');
  });
});
