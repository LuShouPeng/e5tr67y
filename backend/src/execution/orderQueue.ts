import type { DatabaseSync } from 'node:sqlite';

import type { Side } from '../domain/types.ts';
import * as rules from '../strategy/rules.ts';
import { OrderRejectedError, type Broker, type BrokerPosition, type Fill } from './broker.ts';

/**
 * 异步下单队列：策略回路拍板后只「挂一张单据」就返回，真正的下单由执行器在后台按顺序完成。
 *
 * - 判官调用（可能几秒）与下单（等 fill-delay、复核价格、提交、等回包）互不阻塞；
 * - 单据落库（order_intent），状态机 QUEUED → EXECUTING → FILLED / MISSED / REJECTED / EXPIRED / FAILED；
 * - 同一通道串行执行，不会两张单同时花同一笔钱；
 * - 过了窗口的最后检查点（默认开盘后 285 秒）还没执行的单作废（EXPIRED），不追着锁盘下单；
 * - 进程重启时，残留的 QUEUED 一律作废；残留的 EXECUTING 记 UNKNOWN——可能已经提交到交易所，需要人工对账。
 */

export type IntentKind = 'BUY' | 'SELL';
export type IntentStatus = 'QUEUED' | 'EXECUTING' | 'FILLED' | 'MISSED' | 'REJECTED' | 'EXPIRED' | 'FAILED' | 'UNKNOWN';

export const INTENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS order_intent (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  broker       TEXT    NOT NULL,
  window_start INTEGER NOT NULL,
  checkpoint   TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  side         TEXT    NOT NULL,
  stake        REAL,
  limit_price  REAL    NOT NULL,
  position_id  TEXT,
  status       TEXT    NOT NULL,
  reason       TEXT,
  fill_id      TEXT,
  shares       REAL,
  avg_price    REAL,
  amount       REAL,
  created_at   INTEGER NOT NULL,
  not_before   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intent_status ON order_intent(broker, status, window_start);
`;

export interface OrderIntent {
  id: number;
  broker: string;
  windowStart: number;
  checkpoint: string;
  kind: IntentKind;
  side: Side;
  /** 买：本金；卖：null（整仓卖出） */
  stake: number | null;
  /** 买：最高价；卖：最低价 */
  limitPrice: number;
  positionId: string | null;
  status: IntentStatus;
  reason: string | null;
  fillId: string | null;
  shares: number | null;
  avgPrice: number | null;
  amount: number | null;
  createdAt: number;
  /** fill-delay：这之前不执行 */
  notBefore: number;
  expiresAt: number;
  updatedAt: number;
}

export type NewIntent = Pick<OrderIntent, 'windowStart' | 'checkpoint' | 'kind' | 'side' | 'stake' | 'limitPrice' | 'positionId' | 'expiresAt'>;

const ACTIVE: IntentStatus[] = ['QUEUED', 'EXECUTING'];

function toIntent(r: Record<string, unknown>): OrderIntent {
  const n = (v: unknown): number | null => (v == null ? null : Number(v));
  const s = (v: unknown): string | null => (v == null ? null : String(v));
  return {
    id: Number(r.id),
    broker: String(r.broker),
    windowStart: Number(r.window_start),
    checkpoint: String(r.checkpoint),
    kind: r.kind as IntentKind,
    side: r.side as Side,
    stake: n(r.stake),
    limitPrice: Number(r.limit_price),
    positionId: s(r.position_id),
    status: r.status as IntentStatus,
    reason: s(r.reason),
    fillId: s(r.fill_id),
    shares: n(r.shares),
    avgPrice: n(r.avg_price),
    amount: n(r.amount),
    createdAt: Number(r.created_at),
    notBefore: Number(r.not_before),
    expiresAt: Number(r.expires_at),
    updatedAt: Number(r.updated_at),
  };
}

/** 执行结果回写到决策日志用的补丁 */
export interface ExecutionPatch {
  action?: string;
  reason: string;
  /** 成交：保留判官原话，把执行结果接在后面 */
  keepReason?: boolean;
  fillId?: string | null;
  stake?: number | null;
  shares?: number | null;
  avgPrice?: number | null;
}

export interface OrderQueueOptions {
  db: DatabaseSync;
  broker: Broker;
  /** 当前盘口与时间戳（毫秒）；没有盘口回 null */
  book: () => { book: rules.Book; ts: number } | null;
  bookMaxAgeMs: number;
  fillDelayMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 单据有结果时通知（策略用来回写决策日志） */
  onSettled?: (intent: OrderIntent, patch: ExecutionPatch) => void;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface OrderQueue {
  enqueue(intent: NewIntent): OrderIntent;
  /** 该窗口还有没执行完的单 */
  pendingFor(windowStart: number): OrderIntent | null;
  recent(limit: number): OrderIntent[];
  /** 等队列清空（测试与优雅退出用） */
  drain(): Promise<void>;
  /** 启动时收拾上次进程残留的单据 */
  recover(): { expired: number; unknown: number };
  stats(): { queued: number; executing: boolean };
}

export function createOrderQueue(options: OrderQueueOptions): OrderQueue {
  const { db, broker } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = options.log ?? (() => {});
  db.exec(INTENT_SCHEMA);

  const insert = db.prepare(
    `INSERT INTO order_intent (broker, window_start, checkpoint, kind, side, stake, limit_price, position_id, status,
       created_at, not_before, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?)`,
  );
  const byId = db.prepare('SELECT * FROM order_intent WHERE id = ?');
  const setStatus = db.prepare('UPDATE order_intent SET status = ?, reason = ?, updated_at = ? WHERE id = ?');
  const setFill = db.prepare(
    `UPDATE order_intent SET status = 'FILLED', reason = ?, fill_id = ?, shares = ?, avg_price = ?, amount = ?, updated_at = ?
     WHERE id = ?`,
  );

  const pending: number[] = [];
  let worker: Promise<void> | null = null;
  let executing = false;

  function load(id: number): OrderIntent {
    return toIntent(byId.get(id) as Record<string, unknown>);
  }

  function finish(intent: OrderIntent, status: IntentStatus, patch: ExecutionPatch): void {
    setStatus.run(status, patch.reason, now(), intent.id);
    options.onSettled?.(load(intent.id), patch);
  }

  function filled(intent: OrderIntent, fill: Fill, reason: string, action: string): void {
    setFill.run(reason, fill.id, fill.contracts, fill.avgPrice, fill.amount, now(), intent.id);
    const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;
    options.onSettled?.(load(intent.id), {
      action,
      reason,
      keepReason: true,
      fillId: fill.id,
      stake: round4(fill.amount),
      shares: round4(fill.contracts),
      avgPrice: round4(fill.avgPrice),
    });
  }

  async function execute(intent: OrderIntent): Promise<void> {
    const wait = intent.notBefore - now();
    if (wait > 0) await sleep(wait);
    if (now() > intent.expiresAt) {
      finish(intent, 'EXPIRED', { reason: `EXPIRED 单据 #${intent.id} 过了最后下单时间` });
      return;
    }
    setStatus.run('EXECUTING', null, now(), intent.id);
    const b = options.book();
    if (b == null || now() - b.ts > options.bookMaxAgeMs) {
      finish(intent, 'MISSED', { reason: 'STALE_WHILE_ASKING' });
      return;
    }
    try {
      if (intent.kind === 'BUY') {
        const askNow = rules.askOf(b.book, intent.side);
        if (askNow == null || askNow > intent.limitPrice) {
          finish(intent, 'MISSED', { reason: `MISSED ${intent.side} ask ${intent.limitPrice}→${askNow ?? 'none'}` });
          return;
        }
        // 价低了手续费占比反而高，按执行时的价与余额再算一次付不付得起
        const stake = rules.stake(intent.stake ?? 0, await broker.balance(), askNow);
        if (stake == null) {
          finish(intent, 'REJECTED', { reason: rules.NO_BALANCE });
          return;
        }
        const fill = await broker.buy({ windowStart: intent.windowStart, side: intent.side, stake, maxPrice: intent.limitPrice });
        const action = intent.side === 'UP' ? 'BUY_UP' : 'BUY_DOWN';
        filled(intent, fill, `filled @${fill.avgPrice.toFixed(4)}${fill.dryRun ? ' DRY_RUN' : ''}`, action);
      } else {
        const bidNow = rules.bidOf(b.book, intent.side);
        if (bidNow == null || bidNow < intent.limitPrice) {
          finish(intent, 'MISSED', { reason: `MISSED SELL bid ${intent.limitPrice}→${bidNow ?? 'none'}` });
          return;
        }
        const position = await broker.position(intent.windowStart);
        if (position == null || position.id !== intent.positionId) {
          finish(intent, 'REJECTED', { reason: 'NO_POSITION 仓位已不在' });
          return;
        }
        const fill = await broker.sell({ position: position as BrokerPosition, minPrice: intent.limitPrice });
        filled(intent, fill, `filled @${fill.avgPrice.toFixed(4)}${fill.dryRun ? ' DRY_RUN' : ''}`, 'SELL');
      }
    } catch (e) {
      if (e instanceof OrderRejectedError) {
        finish(intent, e.code === 'MISSED' ? 'MISSED' : 'REJECTED', { reason: `${e.code} ${e.message}` });
        return;
      }
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      log('下单失败', { intent: intent.id, error: msg });
      finish(intent, 'FAILED', { action: 'ERROR', reason: `FAILED ${msg}` });
    }
  }

  async function run(): Promise<void> {
    while (pending.length > 0) {
      const id = pending.shift()!;
      executing = true;
      try {
        await execute(load(id));
      } finally {
        executing = false;
      }
    }
  }

  function kick(): void {
    if (worker == null) worker = run().finally(() => (worker = null));
  }

  return {
    enqueue(n) {
      const t = now();
      const info = insert.run(
        broker.kind, n.windowStart, n.checkpoint, n.kind, n.side, n.stake, n.limitPrice, n.positionId,
        t, t + options.fillDelayMs, n.expiresAt, t,
      );
      const id = Number(info.lastInsertRowid);
      pending.push(id);
      kick();
      return load(id);
    },
    pendingFor(windowStart) {
      const r = db
        .prepare(
          `SELECT * FROM order_intent WHERE broker = ? AND window_start = ? AND status IN (${ACTIVE.map(() => '?').join(',')})
           ORDER BY id DESC LIMIT 1`,
        )
        .get(broker.kind, windowStart, ...ACTIVE) as Record<string, unknown> | undefined;
      return r ? toIntent(r) : null;
    },
    recent(limit) {
      return (db.prepare('SELECT * FROM order_intent WHERE broker = ? ORDER BY id DESC LIMIT ?').all(broker.kind, limit) as Record<string, unknown>[]).map(toIntent);
    },
    async drain() {
      while (worker != null) await worker;
    },
    recover() {
      const t = now();
      const expired = db
        .prepare("UPDATE order_intent SET status = 'EXPIRED', reason = '进程重启，未执行的单作废', updated_at = ? WHERE broker = ? AND status = 'QUEUED'")
        .run(t, broker.kind).changes;
      const unknown = db
        .prepare("UPDATE order_intent SET status = 'UNKNOWN', reason = '进程重启时正在执行，可能已提交，需人工对账', updated_at = ? WHERE broker = ? AND status = 'EXECUTING'")
        .run(t, broker.kind).changes;
      return { expired: Number(expired), unknown: Number(unknown) };
    },
    stats: () => ({ queued: pending.length, executing }),
  };
}
