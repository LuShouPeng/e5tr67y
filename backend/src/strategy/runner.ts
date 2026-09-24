import { WINDOW_SECONDS, type Side } from '../domain/types.ts';
import type { Broker, BrokerPosition } from '../execution/broker.ts';
import type { NewIntent, OrderQueue } from '../execution/orderQueue.ts';
import type { FlowMetrics, Liquidation } from '../market/binance.ts';
import type { DecisionRepo, DecisionRow } from './decisionRepo.ts';
import type { Judge, Judgment } from './judges/types.ts';
import type { Kline, Tick } from './model.ts';
import * as rules from './rules.ts';
import { buildState, StateUnavailableError, type Position, type Snapshot } from './state.ts';

/**
 * 预测员回路（移植自上游 `JevPredictionRunner`）：每秒一跳对齐 5 分钟窗口，开盘后到了每个检查点秒数
 * （默认 30,45,…,270）就问一次判官，每次一行落库；另一条每分钟的回填把结算结果、盈亏补进去。
 *
 * 一次检查点：查本回合持仓 → 写 state → 盘口太旧、Chainlink 停了就不问不动 → 问判官 →
 * 要成交的**挂一张单据进异步下单队列就返回**（见 execution/orderQueue.ts）：执行器等 fill-delay 再看盘口，
 * 价没比判官看到的差才成交（跟真挂限价单一样），变差了算没抢到，结果回写到这一行决策。
 * 该窗口还有没执行完的单时，检查点不问判官，记 ORDER_PENDING。
 * 钱包付不起一注、也没有等结算的仓位就自动关掉开关。
 */

export interface StrategyMarketData {
  /** 开盘 60 秒 Chainlink 均价（目标价） */
  openPrice(windowStart: number): number | null;
  ticksSince(fromMs: number): Tick[];
  klines(): Promise<Kline[]>;
  flow(nowMs: number): Promise<FlowMetrics | null>;
  /** 没开强平流回 null */
  liquidationsSince(fromMs: number): Liquidation[] | null;
  book(): { book: rules.Book; ts: number } | null;
  /** 行情是不是真盘且正常（降级到模拟行情时不交易） */
  healthy(): boolean;
  /** 已定盘窗口的结果 */
  outcome(windowStart: number): Side | 'VOID' | null;
}

export interface RunnerConfig {
  checkpointSeconds: number[];
  baseStake: number;
  actThreshold: number;
  /** 下单队列用：挂单后等多久再看盘口 */
  fillDelayMs: number;
  bookMaxAgeMs: number;
  chainlinkMaxAgeMs: number;
  /** 这之后不开检查点：离收盘太近，下单可能撞上锁盘 */
  lastCheckpointSeconds: number;
}

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  checkpointSeconds: [30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 195, 210, 225, 240, 255, 270],
  baseStake: 5,
  actThreshold: 0.5,
  fillDelayMs: 1000,
  bookMaxAgeMs: 7000,
  chainlinkMaxAgeMs: 5000,
  lastCheckpointSeconds: 285,
};

export interface RunnerOptions {
  judge: Judge;
  broker: Broker;
  /** 异步下单队列；其 onSettled 应回写 decisions.applyExecution */
  orders: OrderQueue;
  decisions: DecisionRepo;
  market: StrategyMarketData;
  now?: () => number;
  config?: Partial<RunnerConfig>;
  enabled?: boolean;
  /** 窗口结果已知时通知（实盘用来给持仓记输赢） */
  onWindowOutcome?: (windowStart: number, outcome: Side) => void;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface RunnerStatus {
  enabled: boolean;
  broker: string;
  judge: string;
  busy: boolean;
  lastDecisionAt: number | null;
  lastError: string | null;
  config: RunnerConfig;
}

export interface StrategyRunner {
  start(): void;
  stop(): void;
  tick(): void;
  runCheckpoint(windowStart: number, checkpoint: string): Promise<DecisionRow | null>;
  settleSweep(): Promise<void>;
  setEnabled(on: boolean): void;
  status(): RunnerStatus;
}

export function windowStartOf(nowMs: number): number {
  const sec = Math.floor(nowMs / 1000);
  return sec - (sec % WINDOW_SECONDS);
}

/** 开盘后第几秒该跑哪个检查点：落在 [s_i, s_{i+1}) 就是 T{s_i}；不在任何区间回 null */
export function checkpointFor(elapsedSeconds: number, cfg: RunnerConfig): string | null {
  if (elapsedSeconds >= cfg.lastCheckpointSeconds) return null;
  let cp: string | null = null;
  for (const s of cfg.checkpointSeconds) {
    if (elapsedSeconds < s) break;
    cp = `T${s}`;
  }
  return cp;
}

const round4 = (v: number | null | undefined): number | null => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);

export function createStrategyRunner(options: RunnerOptions): StrategyRunner {
  const { judge, broker, decisions, market, orders } = options;
  const now = options.now ?? Date.now;
  const cfg: RunnerConfig = {
    ...DEFAULT_RUNNER_CONFIG,
    ...options.config,
    checkpointSeconds: [...new Set(options.config?.checkpointSeconds ?? DEFAULT_RUNNER_CONFIG.checkpointSeconds)].sort((a, b) => a - b),
  };
  const log = options.log ?? (() => {});

  let enabled = options.enabled ?? false;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let lastDecisionAt: number | null = null;
  let lastError: string | null = null;
  const lastRun = new Map<string, number>();
  /** 本回合 UP 中间价采样，每秒一次 */
  let upMids: Tick[] = [];
  let klineCache: { atMs: number; bars: Kline[] } | null = null;

  function sampleOdds(nowMs: number): void {
    const ws = windowStartOf(nowMs) * 1000;
    upMids = upMids.filter((p) => p.timeMs >= ws);
    const b = market.book();
    const m = b ? rules.mid(b.book.upAsk, b.book.upBid) : null;
    if (m != null) upMids.push({ timeMs: nowMs, price: m });
  }

  async function klines(nowMs: number): Promise<Kline[]> {
    if (klineCache != null && nowMs - klineCache.atMs < 30_000) return klineCache.bars;
    const bars = await market.klines();
    klineCache = { atMs: nowMs, bars };
    return bars;
  }

  function baseRow(ws: number, cp: string, t: number): DecisionRow {
    return {
      broker: broker.kind, judge: judge.name, windowStart: ws, checkpoint: cp, decidedAt: t, action: 'ERROR', reason: null,
      pModel: null, pJudge: null, pMkt: null, judgeChoice: null, judgeChoiceP: null, edge: null, upAsk: null, upBid: null,
      downAsk: null, downBid: null, fillId: null, stake: null, shares: null, avgPrice: null, model: null, latencyMs: null,
      inputTokens: null, rationale: null, stateJson: '{}', error: null, outcome: null, pnl: null,
    };
  }

  function fillBook(d: DecisionRow, book: rules.Book): void {
    d.upAsk = book.upAsk;
    d.upBid = book.upBid;
    d.downAsk = book.downAsk;
    d.downBid = book.downBid;
    d.pMkt = round4(rules.impliedUp(book));
  }

  function fillJudgment(d: DecisionRow, j: Judgment): void {
    d.pJudge = round4(j.pUp);
    d.judgeChoice = j.decision.choice;
    d.judgeChoiceP = round4(rules.choiceP(j.decision));
    d.model = j.model;
    d.latencyMs = j.latencyMs;
    d.inputTokens = j.inputTokens;
    d.rationale = j.rationale ?? null;
  }

  /** 单据最晚执行时间：过了最后检查点就可能撞上锁盘 */
  function expiresAt(ws: number): number {
    return (ws + cfg.lastCheckpointSeconds) * 1000;
  }

  async function entry(d: DecisionRow, ws: number, j: Judgment, seen: rules.Book, pModel: number): Promise<NewIntent | null> {
    const balance = await broker.balance();
    const e = rules.entry(j.decision, seen, balance, cfg);
    d.action = 'STAY_OUT';
    d.reason = e.reason;
    const askSeen = e.side == null ? null : rules.askOf(seen, e.side);
    if (e.side != null && askSeen != null) d.edge = round4(rules.edge(rules.sideP(pModel, e.side), askSeen));
    if (e.reason === rules.NO_BALANCE) {
      if (!(await broker.hasUnsettled())) {
        enabled = false;
        log('钱包付不起一注，自动关闭策略');
      }
      return null;
    }
    if (e.action === 'STAY_OUT' || e.side == null || askSeen == null || e.stake == null) return null;
    d.reason = `QUEUED ${e.reason}`;
    return {
      windowStart: ws, checkpoint: d.checkpoint, kind: 'BUY', side: e.side, stake: e.stake, limitPrice: askSeen,
      positionId: null, expiresAt: expiresAt(ws),
    };
  }

  function exit(d: DecisionRow, ws: number, j: Judgment, seen: rules.Book, active: BrokerPosition, pModel: number): NewIntent | null {
    const side = active.side;
    const r = rules.exit(j.decision, side, seen, cfg);
    d.action = 'HOLD';
    d.reason = r.reason;
    const bidSeen = rules.bidOf(seen, side);
    if (bidSeen != null) d.edge = round4(rules.sellOver(rules.sideP(pModel, side), bidSeen));
    if (r.action !== 'SELL' || bidSeen == null) return null;
    d.reason = `QUEUED ${r.reason}`;
    return {
      windowStart: ws, checkpoint: d.checkpoint, kind: 'SELL', side, stake: null, limitPrice: bidSeen,
      positionId: active.id, expiresAt: expiresAt(ws),
    };
  }

  async function runCheckpoint(ws: number, cp: string): Promise<DecisionRow | null> {
    if (decisions.exists(broker.kind, ws, cp)) return null;
    const t = now();
    const d = baseRow(ws, cp, t);
    let intent: NewIntent | null = null;
    try {
      const pendingOrder = orders.pendingFor(ws);
      if (pendingOrder != null) {
        d.action = 'STAY_OUT';
        d.reason = `ORDER_PENDING #${pendingOrder.id} ${pendingOrder.kind} ${pendingOrder.status}`;
        return d;
      }
      if (!market.healthy()) {
        d.action = 'STAY_OUT';
        d.reason = 'FEED_DEGRADED';
        return d;
      }
      const active = await broker.position(ws);
      if (active != null) {
        d.fillId = active.id;
        d.stake = round4(active.cost);
        d.shares = round4(active.contracts);
        d.avgPrice = round4(active.avgPrice);
      }
      const position: Position | null = active ? { side: active.side, contracts: active.contracts, avgPrice: active.avgPrice } : null;
      const b = market.book();
      if (b == null) {
        d.action = active ? 'HOLD' : 'STAY_OUT';
        d.reason = 'STALE_BOOK none';
        return d;
      }
      const wsMs = ws * 1000;
      let snap: Snapshot;
      try {
        snap = buildState({
          windowStart: ws,
          nowMs: t,
          openPrice: market.openPrice(ws),
          ticks: market.ticksSince(Math.min(wsMs, t - 180_000)),
          klines: await klines(t),
          flow: await market.flow(t).catch(() => null),
          liquidations: market.liquidationsSince(wsMs),
          book: b.book,
          upMids,
          position,
        });
      } catch (e) {
        if (e instanceof StateUnavailableError) {
          d.action = active ? 'HOLD' : 'STAY_OUT';
          d.reason = `NO_STATE ${e.message}`;
          return d;
        }
        throw e;
      }
      d.stateJson = JSON.stringify(snap.state);
      d.pModel = round4(snap.raw.pModel);
      fillBook(d, b.book);

      const idle = active ? 'HOLD' : 'STAY_OUT';
      const bookAge = t - b.ts;
      if (bookAge > cfg.bookMaxAgeMs) {
        d.action = idle;
        d.reason = `STALE_BOOK ${bookAge}`;
        return d;
      }
      if (snap.raw.chainlinkAgeMs > cfg.chainlinkMaxAgeMs) {
        d.action = idle;
        d.reason = `STALE_CHAINLINK ${snap.raw.chainlinkAgeMs}`;
        return d;
      }
      if (active && rules.bidOf(b.book, active.side) == null) {
        d.action = 'HOLD';
        d.reason = 'NO_BID';
        return d;
      }
      const j = await judge.judge(snap, position);
      fillJudgment(d, j);
      intent = active ? exit(d, ws, j, b.book, active, snap.raw.pModel) : await entry(d, ws, j, b.book, snap.raw.pModel);
      return d;
    } catch (e) {
      intent = null;
      const msg = e instanceof Error ? e.message : String(e);
      d.action = 'ERROR';
      d.error = msg.slice(0, 500);
      lastError = d.error;
      log('检查点失败', { windowStart: ws, checkpoint: cp, error: d.error });
      return d;
    } finally {
      // 先落决策再挂单：执行器的回写一定能找到这一行
      decisions.insert(d);
      lastDecisionAt = t;
      if (intent != null) {
        const queued = orders.enqueue(intent);
        log('已挂单', { intent: queued.id, kind: queued.kind, side: queued.side, limit: queued.limitPrice });
      }
    }
  }

  function tick(): void {
    const t = now();
    sampleOdds(t);
    if (!enabled || busy) return;
    const ws = windowStartOf(t);
    const cp = checkpointFor(Math.floor(t / 1000) - ws, cfg);
    if (cp == null || lastRun.get(cp) === ws) return;
    lastRun.set(cp, ws);
    busy = true;
    void runCheckpoint(ws, cp).finally(() => {
      busy = false;
    });
  }

  async function settleSweep(): Promise<void> {
    const currentWs = windowStartOf(now());
    const pending = decisions.pendingSettle(broker.kind, currentWs, currentWs - 24 * 3600);
    const notified = new Set<number>();
    for (const d of pending) {
      const outcome = market.outcome(d.windowStart);
      if (outcome == null) continue;
      if (outcome !== 'VOID' && !notified.has(d.windowStart)) {
        notified.add(d.windowStart);
        options.onWindowOutcome?.(d.windowStart, outcome);
      }
      let pnl: number | null = null;
      if (d.fillId != null && (d.action === 'BUY_UP' || d.action === 'BUY_DOWN')) {
        pnl = await broker.realizedPnl(d.fillId).catch(() => null);
      }
      decisions.fill(d.id!, outcome, round4(pnl));
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, 1000);
      timer.unref?.();
      sweepTimer = setInterval(() => void settleSweep().catch((e) => log('回填失败', { error: String(e) })), 60_000);
      sweepTimer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      if (sweepTimer) clearInterval(sweepTimer);
      timer = null;
      sweepTimer = null;
    },
    tick,
    runCheckpoint,
    settleSweep,
    setEnabled(on) {
      enabled = on;
    },
    status: () => ({ enabled, broker: broker.kind, judge: judge.name, busy, lastDecisionAt, lastError, config: cfg }),
  };
}
