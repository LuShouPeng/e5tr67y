import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, loadConfig } from '../src/config.ts';
import { flowMetrics, parseAggTrades, parseForceOrder, parseKlines } from '../src/market/binance.ts';
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
