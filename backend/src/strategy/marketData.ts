import type { BinanceMarket } from '../market/binance.ts';
import { flowMetrics } from '../market/binance.ts';
import type { ChainlinkStream } from '../market/chainlinkStream.ts';
import type { MarketFeed } from '../market/feed.ts';
import type { QuoteStore } from '../market/quoteStore.ts';
import type { Clock } from '../services/clock.ts';
import type { PredictionService } from '../services/predictionService.ts';
import type { StrategyMarketData } from './runner.ts';

/** 把各路数据源拼成策略回路要的那一个接口 */
export function createStrategyMarketData(deps: {
  feed: MarketFeed;
  quotes: QuoteStore;
  chainlink: ChainlinkStream;
  binance: BinanceMarket;
  service: PredictionService;
  clock: Clock;
  liquidationsEnabled: boolean;
}): StrategyMarketData {
  const { feed, quotes, chainlink, binance, service, clock } = deps;
  return {
    openPrice: (ws) => feed.settlePrices(ws)?.startPrice ?? null,
    ticksSince: (fromMs) => chainlink.ticksSince(fromMs),
    klines: () => binance.klines(61),
    async flow(nowMs) {
      const trades = await binance.recentTrades(nowMs);
      const m = flowMetrics(trades, nowMs);
      // 逐笔流 30 秒没更新就当不新鲜
      return m != null && nowMs - m.lastTradeMs <= 30_000 ? m : null;
    },
    liquidationsSince: (fromMs) => (deps.liquidationsEnabled ? binance.liquidationsSince(fromMs) : null),
    book() {
      const b = quotes.get();
      if (b == null) return null;
      return { book: { upAsk: b.up.ask, upBid: b.up.bid, downAsk: b.down.ask, downBid: b.down.bid }, ts: b.ts };
    },
    healthy() {
      const s = feed.status();
      return s.mode === 'polymarket' && s.lastSuccessMs != null && clock.now() - s.lastSuccessMs < 30_000;
    },
    outcome(ws) {
      const r = service.roundOf(ws);
      return r?.status === 'SETTLED' ? r.outcome : null;
    },
  };
}
