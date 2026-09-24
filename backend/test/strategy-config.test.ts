import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, loadConfig } from '../src/config.ts';
import { createBinanceMarket, flowMetrics, parseAggTradeMessage, parseAggTrades, parseForceOrder, parseKlines } from '../src/market/binance.ts';
import type { WsLike } from '../src/market/chainlinkStream.ts';
import { createChainlinkStream, subscribeMessage } from '../src/market/chainlinkStream.ts';

describe('配置校验', () => {
  it('默认：自动降级行情、策略关闭、实盘关闭且 dry-run', () => {
    const c = loadConfig({});
    assert.equal(c.feedMode, 'auto');
    assert.equal(c.strategy.enabled, false);
    assert.equal(c.strategy.judge, 'math');
    assert.equal(c.strategy.broker, 'paper');
    assert.equal(c.live.dryRun, true);
  });

  it('MARKET_FEED 拼错直接报错，不再悄悄按真盘跑', () => {
    assert.throws(() => loadConfig({ MARKET_FEED: 'Auto' }), ConfigError);
  });

  it('实盘三道前置：显式开启、只用真盘、要私钥', () => {
    const base = { STRATEGY_ENABLED: 'true', STRATEGY_BROKER: 'live' };
    assert.throws(() => loadConfig(base), /LIVE_TRADING_ENABLED/);
    assert.throws(() => loadConfig({ ...base, LIVE_TRADING_ENABLED: 'true' }), /MARKET_FEED 必须是 polymarket/);
    assert.throws(() => loadConfig({ ...base, LIVE_TRADING_ENABLED: 'true', MARKET_FEED: 'polymarket' }), /POLY_PRIVATE_KEY/);
    const ok = loadConfig({ ...base, LIVE_TRADING_ENABLED: 'true', MARKET_FEED: 'polymarket', POLY_PRIVATE_KEY: '0xabc' });
    assert.equal(ok.live.enabled, true);
  });

  it('Jev 判官需要 key；检查点格式校验', () => {
    assert.throws(() => loadConfig({ STRATEGY_ENABLED: 'true', STRATEGY_JUDGE: 'jev' }), /JEV_API_KEY/);
    assert.throws(() => loadConfig({ STRATEGY_CHECKPOINTS: '30,abc' }), ConfigError);
    assert.deepEqual(loadConfig({ STRATEGY_CHECKPOINTS: '60, 120' }).strategy.runner.checkpointSeconds, [60, 120]);
  });
});

describe('Binance 数据解析', () => {
  it('K 线取收盘价', () => {
    assert.deepEqual(parseKlines([[0, '1', '2', '0.5', '1.5', '10'], ['bad']]), [{ openTimeMs: 0, close: 1.5 }]);
  });

  it('逐笔：主动买卖、大单、10/30 秒涨跌', () => {
    const now = 100_000;
    const trades = parseAggTrades([
      { p: '59990', q: '0.1', T: now - 70_000, m: true }, // 窗口外：证明窗口前就有数据
      { p: '60000', q: '0.1', T: now - 40_000, m: false },
      { p: '60010', q: '2', T: now - 20_000, m: false },
      { p: '60020', q: '0.1', T: now - 5_000, m: true },
    ]);
    const m = flowMetrics(trades, now)!;
    assert.equal(m.tradeCount, 3);
    assert.ok(m.tradeDelta > 0.9);
    assert.equal(m.largeTradeBias, 1);
    assert.equal(m.move10, 10);
    assert.equal(m.move30, 20);
    assert.equal(flowMetrics([], now), null);
  });

  it('逐笔数据没盖住整个窗口（最早一笔已在窗口内）→ 不给，免得把十几秒说成「最近一分钟」', () => {
    const now = 100_000;
    const burst = parseAggTrades(Array.from({ length: 50 }, (_, i) => ({ p: '60000', q: '1', T: now - 12_000 + i * 200, m: false })));
    assert.equal(flowMetrics(burst, now), null);
  });

  it('强平消息', () => {
    const liq = parseForceOrder(JSON.stringify({ o: { s: 'BTCUSDT', S: 'SELL', ap: '60000', z: '0.5', T: 1 } }));
    assert.deepEqual(liq, { timeMs: 1, side: 'SELL', usdt: 30_000 });
    assert.equal(parseForceOrder('{"o":{"s":"ETHUSDT"}}'), null);
  });
});

describe('Chainlink 实时流', () => {
  it('订阅两个主题，现货按 Chainlink 时间戳入序列', () => {
    const msg = JSON.parse(subscribeMessage()) as { subscriptions: { topic: string; filters: string }[] };
    assert.deepEqual(msg.subscriptions.map((s) => s.topic), ['crypto_prices_chainlink', 'crypto_prices_twap_sixty']);
    const s = createChainlinkStream({ now: () => 5_000 });
    s.handleMessage(JSON.stringify({ topic: 'crypto_prices_chainlink', payload: { value: 60000.5, timestamp: 1000 } }));
    s.handleMessage(JSON.stringify({ topic: 'crypto_prices_chainlink', payload: { value: 60001, timestamp: 2000 } }));
    s.handleMessage(JSON.stringify({ topic: 'crypto_prices_chainlink', payload: { value: 1, timestamp: 1500 } })); // 乱序丢弃
    s.handleMessage(JSON.stringify({ topic: 'crypto_prices_twap_sixty', payload: { value: 60000.7 } }));
    s.handleMessage('PONG');
    assert.deepEqual(s.ticksSince(0), [
      { timeMs: 1000, price: 60000.5 },
      { timeMs: 2000, price: 60001 },
    ]);
    assert.equal(s.latestTwap()!.price, 60000.7);
  });
});

/** 假 WebSocket：记录监听器，测试里手动触发 open / message / close */
function fakeWs(): WsLike & { fire(type: 'open' | 'message' | 'close', data?: unknown): void; closed: boolean } {
  const listeners = new Map<string, ((e: { data?: unknown }) => void)[]>();
  return {
    closed: false,
    send() {},
    close() {
      this.closed = true;
    },
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    fire(type, data) {
      for (const fn of listeners.get(type) ?? []) fn({ data });
    },
  };
}

describe('Binance 实时流缓存', () => {
  const aggMsg = (T: number, p = 60000, q = 0.1, m = false) => JSON.stringify({ e: 'aggTrade', s: 'BTCUSDT', p: String(p), q: String(q), T, m });

  it('逐笔流盖得住窗口就用缓存，否则退回 REST；强平流没连上 / 连晚了回 null', async () => {
    let clock = 1_000_000;
    const sockets: ReturnType<typeof fakeWs>[] = [];
    const restCalls: string[] = [];
    const market = createBinanceMarket({
      now: () => clock,
      wsFactory: () => {
        const ws = fakeWs();
        sockets.push(ws);
        return ws;
      },
      fetchJson: async (url) => {
        restCalls.push(url);
        return [{ p: '61000', q: '1', T: clock - 1000, m: true }];
      },
    });
    // 还没 start：强平 = 不知道，不是「没有」
    assert.equal(market.liquidationsSince(0), null);
    market.start({ liquidations: true });
    const [tradeWs, liqWs] = sockets as [ReturnType<typeof fakeWs>, ReturnType<typeof fakeWs>];
    assert.equal(sockets.length, 2);

    // 逐笔流刚连上、缓存盖不住 90 秒窗口 → 走 REST
    tradeWs.fire('open');
    tradeWs.fire('message', aggMsg(clock - 500));
    assert.equal((await market.recentTrades(clock)).length, 1);
    assert.equal(restCalls.length, 1);

    // 两分钟后缓存从窗口前就连续在收 → 用缓存，不再打 REST
    for (let i = 0; i < 120; i++) {
      clock += 1000;
      tradeWs.fire('message', aggMsg(clock, 60000 + i, 0.2, i % 2 === 0));
    }
    const buffered = await market.recentTrades(clock, 60_000);
    assert.equal(restCalls.length, 1);
    assert.equal(buffered.length, 61);
    assert.ok(buffered[0]!.timeMs === clock - 60_000);
    const m = flowMetrics(buffered, clock)!;
    assert.equal(m.tradeCount, 60);
    assert.ok(Math.abs(m.tradeDelta) < 0.05);

    // 强平流：连上晚于窗口开始 → 该窗口不知道；连上之后开始的窗口 → 给结果（可以是空数组）
    assert.equal(market.liquidationsSince(clock - 5000), null);
    liqWs.fire('open');
    const connectedAt = clock;
    assert.equal(market.liquidationsSince(connectedAt - 1), null);
    assert.deepEqual(market.liquidationsSince(connectedAt), []);
    liqWs.fire('message', JSON.stringify({ o: { s: 'BTCUSDT', S: 'BUY', ap: '60000', z: '1', T: clock + 10 } }));
    assert.equal(market.liquidationsSince(connectedAt)!.length, 1);
    // 断开 → 又变成不知道
    liqWs.fire('close');
    assert.equal(market.liquidationsSince(connectedAt), null);

    market.stop();
    assert.ok(tradeWs.closed && liqWs.closed);
    assert.equal(market.status().tradesConnectedSinceMs, null);
  });

  it('aggTrade 消息解析：只认 BTCUSDT 的 aggTrade', () => {
    assert.deepEqual(parseAggTradeMessage(aggMsg(5, 1, 2, true)), { timeMs: 5, price: 1, qty: 2, buyerIsMaker: true });
    assert.equal(parseAggTradeMessage(JSON.stringify({ e: 'aggTrade', s: 'ETHUSDT', p: '1', q: '1', T: 1 })), null);
    assert.equal(parseAggTradeMessage('not json'), null);
  });
});
