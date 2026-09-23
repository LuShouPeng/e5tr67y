import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { openDatabase } from './infra/db.ts';
import { createAccountRepo } from './infra/repos/accountRepo.ts';
import { createBetRepo } from './infra/repos/betRepo.ts';
import { createRoundRepo } from './infra/repos/roundRepo.ts';
import { createPriceHistory } from './market/priceHistory.ts';
import { createQuoteStore } from './market/quoteStore.ts';
import { createMarketFeed, type FeedMode } from './market/feed.ts';
import { buildApp } from './http/app.ts';
import { systemClock } from './services/clock.ts';
import { createEventBus } from './services/eventBus.ts';
import { createPredictionService } from './services/predictionService.ts';
import { createScheduler } from './services/scheduler.ts';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.WIIB_DB ?? 'data/prediction.sqlite';
/** polymarket：只用真盘；simulated：只用本地模拟；auto：上游连续失败后自动降级 */
const FEED_MODE = (process.env.MARKET_FEED ?? 'auto') as FeedMode;

if (DB_PATH !== ':memory:') {
  mkdirSync(dirname(DB_PATH), { recursive: true });
}

const db = openDatabase(DB_PATH);
const rounds = createRoundRepo(db);
const bets = createBetRepo(db);
const accounts = createAccountRepo(db);
const quotes = createQuoteStore();
const prices = createPriceHistory();
const events = createEventBus();
const clock = systemClock;

const service = createPredictionService({ db, rounds, bets, accounts, quotes, clock, events });

const app = buildApp({ service, quotes, prices, events, clock, logger: true });

// 行情是回合的输入：喂目标价与盘口，并把已收官窗口的开收盘价交给调度器定盘
const feed = createMarketFeed({
  quotes,
  prices,
  service,
  clock,
  events,
  mode: FEED_MODE,
  log: (message, meta) => app.log.warn({ ...meta }, message),
});

const scheduler = createScheduler({
  service,
  clock,
  priceLookup: (windowStart) => feed.settlePrices(windowStart),
  onError: (e) => app.log.error(e),
});

feed.start();
scheduler.start();

await app.listen({ port: PORT, host: HOST });
app.log.info({ db: DB_PATH, feedMode: FEED_MODE }, 'polymarket-predict backend 已启动');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    scheduler.stop();
    feed.stop();
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
