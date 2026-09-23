import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMarketFeed, type FetchLike, type FeedMode } from '../src/market/feed.ts';
import { createSimulatedMarket } from '../src/market/simulated.ts';
import { createPriceHistory } from '../src/market/priceHistory.ts';
import { BASE_NOW, makeHarness, type Harness } from './helpers.ts';

const WS = Date.UTC(2026, 8, 23, 7, 5, 0, 0) / 1000;
const slug = `btc-updown-5m-${WS}`;
const prevSlug = `btc-updown-5m-${WS - 300}`;

interface Stub {
  status?: number;
  body: unknown;
  date?: string;
}

/** 按 URL 片段分发的假上游，并记录每个 URL 被请求的次数 */
function stubFetch(stubs: Array<[match: string, stub: Stub]>, calls: string[] = []): FetchLike {
  return async (url: string) => {
    calls.push(url);
    for (const [match, stub] of stubs) {
      if (url.includes(match)) {
        return {
          status: stub.status ?? 200,
          headers: { get: (name) => (name.toLowerCase() === 'date' ? stub.date ?? null : null) },
          json: async () => stub.body,
        };
      }
    }
    return { status: 404, headers: null, json: async () => ({}) };
  };
}

function eventBody(outcomes: string[], tokenIds: string[], marketSlug = slug) {
  return {
    markets: [
      { slug: marketSlug, outcomes: JSON.stringify(outcomes), clobTokenIds: JSON.stringify(tokenIds) },
    ],
  };
}

const OK_STUBS: Array<[string, Stub]> = [
  [
    'crypto-price',
    {
      body: { openPrice: '60000.00', closePrice: null, completed: false },
      date: 'Wed, 23 Sep 2026 07:05:00 GMT',
    },
  ],
  ['events/slug', { body: eventBody(['Up', 'Down'], ['t-up', 't-down']) }],
  ['token_id=t-up', { body: { bids: [{ price: '0.47' }, { price: '0.49' }], asks: [{ price: '0.52' }] } }],
  ['token_id=t-down', { body: { bids: [{ price: '0.48' }], asks: [{ price: '0.54' }, { price: '0.53' }] } }],
];

function makeFeed(
  options: {
    stubs?: Array<[string, Stub]>;
    mode?: FeedMode;
    calls?: string[];
    h?: Harness;
  } = {},
) {
  const h = options.h ?? makeHarness({ book: null, withRound: false, startPrice: null });
  const quotes = h.quotes;
  const prices = createPriceHistory();
  const calls = options.calls ?? [];
  const feed = createMarketFeed({
    quotes,
    prices,
    service: h.service,
    clock: h.clock,
    events: h.events,
    fetchImpl: stubFetch(options.stubs ?? OK_STUBS, calls),
    mode: options.mode ?? 'polymarket',
    simulated: createSimulatedMarket({ seed: 5 }),
  });
  return { h, quotes, prices, feed, calls };
}

describe('refresh：正常路径把目标价与盘口喂进去', () => {
  it('写盘口、推价格、给当前回合补目标价', async () => {
    const { h, quotes, prices, feed } = makeFeed();
    try {
      const snapshot = await feed.refresh();
      assert.equal(snapshot.windowStart, WS);
      assert.equal(snapshot.degraded, false);
      assert.equal(snapshot.targetPrice, 60_000);

      assert.deepEqual(quotes.get(), {
        up: { bid: 0.49, ask: 0.52 },
        down: { bid: 0.48, ask: 0.53 },
        ts: BASE_NOW,
      });
      assert.equal(prices.latest()?.price, 60_000);
      assert.equal(h.rounds.findByWindowStart(WS)?.startPrice, 60_000);
    } finally {
      h.close();
    }
  });

  it('向上游发出 4 类请求（开盘价 + 上一窗口价 + Gamma + 两个 token 的账本）', async () => {
    const calls: string[] = [];
    const { h, feed } = makeFeed({
      calls,
      stubs: [
        ...OK_STUBS,
        ['2026-09-23T07%3A00%3A00.000Z', { body: { openPrice: '59990', closePrice: '60010', completed: true } }],
      ],
    });
    try {
      await feed.refresh();
      assert.equal(calls.filter((u) => u.includes('crypto-price')).length, 2, '当前 + 上一窗口各一次');
      assert.equal(calls.filter((u) => u.includes('events/slug')).length, 1);
      assert.equal(calls.filter((u) => u.includes('clob.polymarket.com')).length, 2);
    } finally {
      h.close();
    }
  });

  it('同一窗口的 Gamma 只查一次（token 缓存）', async () => {
    const calls: string[] = [];
    const { h, feed } = makeFeed({ calls });
    try {
      await feed.refresh();
      await feed.refresh();
      await feed.refresh();
      assert.equal(calls.filter((u) => u.includes('events/slug')).length, 1);
    } finally {
      h.close();
    }
  });

  it('记录上游 Date 头作时钟基准', async () => {
    const { h, feed } = makeFeed();
    try {
      await feed.refresh();
      assert.equal(feed.status().upstreamTimeMs, Date.UTC(2026, 8, 23, 7, 5, 0));
    } finally {
      h.close();
    }
  });
});

describe('settlePrices：completed 才认收盘价', () => {
  it('上一窗口已收官时给出开收盘价', async () => {
    const { h, feed } = makeFeed({
      stubs: [
        ['2026-09-23T07%3A00%3A00.000Z', { body: { openPrice: '59990', closePrice: '60010', completed: true } }],
        ...OK_STUBS,
      ],
    });
    try {
      await feed.refresh();
      assert.deepEqual(feed.settlePrices(WS - 300), { startPrice: 59990, endPrice: 60010 });
    } finally {
      h.close();
    }
  });

  it('未收官（completed=false）时收盘价留空，不拿半个窗口当结果', async () => {
    const { h, feed } = makeFeed({
      stubs: [
        ['2026-09-23T07%3A00%3A00.000Z', { body: { openPrice: '59990', closePrice: '60010', completed: false } }],
        ...OK_STUBS,
      ],
    });
    try {
      await feed.refresh();
      assert.deepEqual(feed.settlePrices(WS - 300), { startPrice: 59990, endPrice: null });
    } finally {
      h.close();
    }
  });

  it('没拉过的窗口返回 null', async () => {
    const { h, feed } = makeFeed();
    try {
      assert.equal(feed.settlePrices(WS - 3000), null);
    } finally {
      h.close();
    }
  });
});

describe('降级：拿不到价不算错，算没有报价', () => {
  it('上游 500 时不动盘口并计数失败', async () => {
    const h = makeHarness({ book: { upAsk: 0.5, upBid: 0.4 } });
    try {
      const quotes = h.quotes;
      const before = quotes.get();
      const feed = createMarketFeed({
        quotes,
        prices: createPriceHistory(),
        service: h.service,
        clock: h.clock,
        fetchImpl: stubFetch([['crypto-price', { status: 500, body: {} }]]),
        mode: 'polymarket',
        simulated: createSimulatedMarket({ seed: 5 }),
      });

      const snapshot = await feed.refresh();
      assert.equal(snapshot.degraded, true);
      assert.equal(feed.status().consecutiveFailures, 1);
      assert.ok(feed.status().lastError?.includes('500'));
      assert.deepEqual(quotes.get(), before, '旧盘口保持不动，让其自然超龄');
      assert.ok(feed.status().upstreamTimeMs === null);
    } finally {
      h.close();
    }
  });

  it('Gamma 查不到 token 时不写盘口（宁可不报价）', async () => {
    const { h, quotes, feed } = makeFeed({
      stubs: [
        ['crypto-price', { body: { openPrice: '60000', completed: false } }],
        ['events/slug', { body: { markets: [] } }],
      ],
    });
    try {
      const snapshot = await feed.refresh();
      assert.equal(snapshot.degraded, false, '请求本身是成功的');
      assert.equal(snapshot.quote, null);
      assert.equal(quotes.get(), null);
    } finally {
      h.close();
    }
  });

  it('auto 模式连续失败到阈值后切到本地模拟，页面不再空转', async () => {
    const { h, quotes, feed } = makeFeed({
      mode: 'auto',
      stubs: [['crypto-price', { status: 503, body: {} }]],
    });
    try {
      await feed.refresh();
      await feed.refresh();
      assert.equal(feed.status().mode, 'polymarket');
      assert.equal(feed.status().consecutiveFailures, 2);

      await feed.refresh();
      assert.equal(feed.status().mode, 'simulated');
      assert.equal(feed.status().consecutiveFailures, 3);

      const snapshot = await feed.refresh();
      assert.equal(snapshot.degraded, true);
      assert.notEqual(snapshot.quote, null, '模拟盘口已就绪');
      assert.notEqual(quotes.get(), null);
      assert.notEqual(snapshot.targetPrice, null);
    } finally {
      h.close();
    }
  });

  it('模拟模式开箱即用：无需上游就能下单', async () => {
    const h = makeHarness({ book: null, withRound: false, startPrice: null });
    try {
      const feed = createMarketFeed({
        quotes: h.quotes,
        prices: createPriceHistory(),
        service: h.service,
        clock: h.clock,
        fetchImpl: stubFetch([]),
        mode: 'simulated',
        simulated: createSimulatedMarket({ seed: 5 }),
      });
      const snapshot = await feed.refresh();
      assert.notEqual(snapshot.quote, null);
      assert.notEqual(snapshot.targetPrice, null);

      const bet = h.service.buy(1, 'UP', 100);
      assert.equal(bet.status, 'ACTIVE');
      assert.equal(bet.contracts > 0, true);
    } finally {
      h.close();
    }
  });
});

describe('事件推送与生命周期', () => {
  it('每次刷新都推 market 事件', async () => {
    const { h, feed } = makeFeed();
    try {
      const seen: unknown[] = [];
      h.events.subscribe((e) => {
        if (e.type === 'market') seen.push(e.data);
      });
      await feed.refresh();
      await feed.refresh();
      assert.equal(seen.length, 2);
      assert.match(JSON.stringify(seen[0]), /upBid/);
    } finally {
      h.close();
    }
  });

  it('start/stop 幂等，stop 后不再拉取', async () => {
    const calls: string[] = [];
    const { h, feed } = makeFeed({ calls });
    try {
      feed.start();
      feed.start();
      await new Promise((r) => setTimeout(r, 30));
      feed.stop();
      feed.stop();
      const afterStop = calls.length;
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(calls.length, afterStop);
    } finally {
      h.close();
    }
  });

  it('模拟器的收盘价与开盘价同源，离线也能自洽结算', async () => {
    const sim = createSimulatedMarket({ seed: 11 });
    assert.notEqual(sim.openPrice(WS), sim.closePrice(WS));
    assert.ok(Math.abs(sim.closePrice(WS) - sim.openPrice(WS)) / sim.openPrice(WS) < 0.02);
  });
});
