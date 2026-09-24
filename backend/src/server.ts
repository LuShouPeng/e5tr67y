import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { ConfigError, loadConfig, type AppConfig } from './config.ts';
import { createPaperBroker } from './execution/paperBroker.ts';
import type { Broker } from './execution/broker.ts';
import { buildApp } from './http/app.ts';
import type { StrategyRouteDeps } from './http/routes/strategy.ts';
import { openDatabase } from './infra/db.ts';
import { createAccountRepo } from './infra/repos/accountRepo.ts';
import { createBetRepo } from './infra/repos/betRepo.ts';
import { createRoundRepo } from './infra/repos/roundRepo.ts';
import { createClob } from './live/clob.ts';
import { createGeoGuard } from './live/geoblock.ts';
import { createLiveBroker, type LiveBroker } from './live/liveBroker.ts';
import { openLiveStore, type LiveStore } from './live/liveStore.ts';
import { createRedeemChain, RedeemUnavailableError } from './live/redeemChain.ts';
import { createRedeemer, type Redeemer } from './live/redeemer.ts';
import { createOrderQueue, type OrderQueue } from './execution/orderQueue.ts';
import { createBinanceMarket } from './market/binance.ts';
import { createChainlinkStream } from './market/chainlinkStream.ts';
import { createMarketFeed } from './market/feed.ts';
import { createPriceHistory } from './market/priceHistory.ts';
import { createQuoteStore } from './market/quoteStore.ts';
import { systemClock } from './services/clock.ts';
import { createEventBus } from './services/eventBus.ts';
import { createPredictionService } from './services/predictionService.ts';
import { createScheduler } from './services/scheduler.ts';
import { createDecisionRepo } from './strategy/decisionRepo.ts';
import { createClaudeJudge } from './strategy/judges/claudeJudge.ts';
import { createJevJudge } from './strategy/judges/jevJudge.ts';
import { createMathJudge } from './strategy/judges/mathJudge.ts';
import type { Judge } from './strategy/judges/types.ts';
import { createStrategyMarketData } from './strategy/marketData.ts';
import { createStrategyRunner, type StrategyRunner } from './strategy/runner.ts';

let config: AppConfig;
try {
  config = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`配置错误：${e.message}`);
    process.exit(1);
  }
  throw e;
}

function ensureDir(path: string): void {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
}

ensureDir(config.dbPath);

const db = openDatabase(config.dbPath);
const rounds = createRoundRepo(db);
const bets = createBetRepo(db);
const accounts = createAccountRepo(db);
const quotes = createQuoteStore();
const prices = createPriceHistory();
const events = createEventBus();
const clock = systemClock;

const service = createPredictionService({ db, rounds, bets, accounts, quotes, clock, events });

// 策略要逐秒 Chainlink 现货：有它时价格曲线也改用它（原先真盘下曲线只有开盘均价一个点）
const needLivePrices = config.feedMode !== 'simulated';
const chainlink = createChainlinkStream({ onTick: (t) => prices.push(t.timeMs, t.price) });

// 行情是回合的输入：喂目标价与盘口，并把已收官窗口的开收盘价交给调度器定盘
let logWarn: (message: string, meta?: Record<string, unknown>) => void = () => {};
const feed = createMarketFeed({
  quotes,
  prices,
  service,
  clock,
  events,
  mode: config.feedMode,
  pollMs: config.feedPollMs,
  externalPriceHistory: needLivePrices,
  log: (message, meta) => logWarn(message, meta),
});

const scheduler = createScheduler({
  service,
  clock,
  priceLookup: (windowStart) => feed.settlePrices(windowStart),
  onError: (e) => console.error(e),
});

// ==================== 自动策略（可选） ====================

let runner: StrategyRunner | null = null;
let strategyRoutes: StrategyRouteDeps | null = null;
let liveStore: LiveStore | null = null;
let orders: OrderQueue | null = null;
let redeemer: Redeemer | null = null;
const binance = createBinanceMarket({ apiBase: config.binanceApiBase });

if (config.strategy.enabled) {
  const judge: Judge =
    config.strategy.judge === 'jev'
      ? createJevJudge({ apiKey: config.jev.apiKey, baseUrl: config.jev.baseUrl, model: config.jev.model })
      : config.strategy.judge === 'claude'
        ? createClaudeJudge({ model: config.claude.model, effort: config.claude.effort })
        : createMathJudge(config.strategy.mathMinEdge);

  let broker: Broker;
  let liveBroker: LiveBroker | null = null;
  let decisions;
  let redeemDisabledReason: string | null = null;
  let ordersDb = db;
  const geo = createGeoGuard();
  if (config.strategy.broker === 'live') {
    ensureDir(config.live.dbPath);
    liveStore = openLiveStore(config.live.dbPath);
    const clob = await createClob({
      privateKey: config.live.privateKey,
      funderAddress: config.live.funderAddress,
      signatureType: config.live.signatureType,
      apiCreds: config.live.apiCreds,
    });
    liveBroker = createLiveBroker({
      clob,
      store: liveStore,
      geo,
      tokens: (ws) => feed.tokens(ws),
      risk: {
        maxStakeUsd: config.live.maxStakeUsd,
        maxOpenCostUsd: config.live.maxOpenCostUsd,
        maxDailyLossUsd: config.live.maxDailyLossUsd,
      },
      dryRun: config.live.dryRun,
    });
    broker = liveBroker;
    // 实盘决策日志、下单队列与实盘账本同库，和模拟盘彻底分开
    decisions = createDecisionRepo(liveStore.db);
    ordersDb = liveStore.db;
    if (config.live.dryRun) {
      redeemDisabledReason = 'dry-run 没有链上份额，不领奖';
    } else if (!config.live.autoRedeem) {
      redeemDisabledReason = 'LIVE_AUTO_REDEEM=false，请到 Polymarket 网页手动领取';
    } else {
      try {
        const chain = createRedeemChain({
          privateKey: config.live.privateKey,
          signatureType: config.live.signatureType,
          rpcUrl: config.live.polygonRpcUrl,
          relayerUrl: config.live.relayerUrl,
          builderCreds: config.live.builderCreds,
        });
        redeemer = createRedeemer({ store: liveStore, chain, log: (m, meta) => logWarn(m, meta) });
      } catch (e) {
        if (!(e instanceof RedeemUnavailableError)) throw e;
        redeemDisabledReason = e.message;
        console.warn(`自动领奖未启用：${e.message}`);
      }
    }
    const g = await geo.ensure();
    if (!g.allowed) console.warn(`实盘地域检查未通过，实盘下单将被拒绝：${g.reason}`);
  } else {
    broker = createPaperBroker({ service, quotes });
    decisions = createDecisionRepo(db);
  }

  if (config.binanceLiquidations) binance.startLiquidations();
  const decisionLog = decisions;
  const marketData = createStrategyMarketData({
    feed,
    quotes,
    chainlink,
    binance,
    service,
    clock,
    liquidationsEnabled: config.binanceLiquidations,
  });
  orders = createOrderQueue({
    db: ordersDb,
    broker,
    book: () => marketData.book(),
    bookMaxAgeMs: config.strategy.runner.bookMaxAgeMs,
    fillDelayMs: config.strategy.runner.fillDelayMs,
    onSettled: (intent, patch) => decisionLog.applyExecution(intent.broker, intent.windowStart, intent.checkpoint, patch),
    log: (message, meta) => logWarn(message, meta),
  });
  const recovered = orders.recover();
  if (recovered.unknown > 0) console.warn(`有 ${recovered.unknown} 张单在上次退出时正在执行，状态记为 UNKNOWN，请到交易所对账`);
  runner = createStrategyRunner({
    judge,
    broker,
    orders,
    decisions,
    market: marketData,
    config: config.strategy.runner,
    enabled: config.strategy.autostart,
    onWindowOutcome: liveBroker ? (ws, outcome) => liveBroker.resolveWindow(ws, outcome) : undefined,
    log: (message, meta) => logWarn(message, meta),
  });
  strategyRoutes = {
    runner,
    decisions,
    orders,
    adminToken: config.strategy.adminToken,
    live: liveBroker && liveStore ? { broker: liveBroker, store: liveStore, geo, redeemer, redeemDisabledReason } : null,
  };
}

const app = buildApp({ service, quotes, prices, events, clock, logger: true, strategy: strategyRoutes });
logWarn = (message, meta) => app.log.warn({ ...meta }, message);

if (needLivePrices) chainlink.start();
feed.start();
scheduler.start();
runner?.start();
redeemer?.start();

await app.listen({ port: config.port, host: config.host });
app.log.info(
  {
    db: config.dbPath,
    feedMode: config.feedMode,
    strategy: config.strategy.enabled
      ? { judge: config.strategy.judge, broker: config.strategy.broker, autostart: config.strategy.autostart }
      : 'off',
    live:
      config.strategy.enabled && config.strategy.broker === 'live'
        ? { dryRun: config.live.dryRun, db: config.live.dbPath, autoRedeem: redeemer?.status().mode ?? 'off' }
        : 'off',
  },
  'polymarket-predict backend 已启动',
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    runner?.stop();
    redeemer?.stop();
    scheduler.stop();
    feed.stop();
    chainlink.stop();
    binance.stop();
    // 等手上的单执行完再关库，免得把 EXECUTING 的单留成 UNKNOWN
    void (orders?.drain() ?? Promise.resolve())
      .then(() => app.close())
      .then(() => {
        db.close();
        liveStore?.close();
        process.exit(0);
      });
  });
}
