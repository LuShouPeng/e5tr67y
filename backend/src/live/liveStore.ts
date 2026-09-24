import { DatabaseSync } from 'node:sqlite';

import type { Side } from '../domain/types.ts';

/**
 * 实盘账本：**独立的 SQLite 文件**（默认 data/live.sqlite），与模拟盘的游戏库物理分离。
 * - live_order：每一次向 Polymarket 提交（或 dry-run 签名）的订单与回包；
 * - live_position：按窗口 + 方向聚合的真实持仓，结算后记输赢（赢的份额需要到 Polymarket 领取 / redeem）。
 * 策略决策日志 strategy_decision 也建在这个库里，实盘和模拟盘的决策各记各的。
 */

export const LIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS live_order (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  window_start INTEGER NOT NULL,
  side         TEXT    NOT NULL,
  token_id     TEXT    NOT NULL,
  action       TEXT    NOT NULL,
  amount       REAL    NOT NULL,
  price_limit  REAL    NOT NULL,
  shares       REAL    NOT NULL DEFAULT 0,
  usdc         REAL    NOT NULL DEFAULT 0,
  order_id     TEXT,
  status       TEXT    NOT NULL,
  dry_run      INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS live_position (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  window_start INTEGER NOT NULL,
  side         TEXT    NOT NULL,
  token_id     TEXT    NOT NULL,
  shares       REAL    NOT NULL,
  cost         REAL    NOT NULL,
  proceeds     REAL    NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'OPEN',
  payout       REAL,
  dry_run      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_live_order_ws ON live_order(window_start);
CREATE INDEX IF NOT EXISTS idx_live_pos_status ON live_position(status, window_start);
`;

export type LivePositionStatus = 'OPEN' | 'SOLD' | 'WON' | 'LOST';

export interface LiveOrderRow {
  id: number;
  windowStart: number;
  side: Side;
  tokenId: string;
  action: 'BUY' | 'SELL';
  amount: number;
  priceLimit: number;
  shares: number;
  usdc: number;
  orderId: string | null;
  status: string;
  dryRun: boolean;
  error: string | null;
  createdAt: number;
}

export interface LivePositionRow {
  id: number;
  windowStart: number;
  side: Side;
  tokenId: string;
  shares: number;
  cost: number;
  proceeds: number;
  status: LivePositionStatus;
  payout: number | null;
  dryRun: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LiveStore {
  readonly db: DatabaseSync;
  recordOrder(o: Omit<LiveOrderRow, 'id'>): LiveOrderRow;
  openPosition(p: { windowStart: number; side: Side; tokenId: string; shares: number; cost: number; dryRun: boolean; nowMs: number }): LivePositionRow;
  closePosition(id: number, proceeds: number, nowMs: number): void;
  /** 部分卖出：份额减少、所得累加，仓位仍 OPEN；最终盈亏 = 累计所得 + 派彩 − 成本 */
  partialSell(id: number, soldShares: number, proceeds: number, nowMs: number): void;
  resolvePosition(id: number, won: boolean, nowMs: number): void;
  position(id: number): LivePositionRow | null;
  openPositionFor(windowStart: number): LivePositionRow | null;
  openPositions(): LivePositionRow[];
  recentOrders(limit: number): LiveOrderRow[];
  recentPositions(limit: number): LivePositionRow[];
  /** fromMs 以来已了结仓位的净盈亏（卖出所得 / 派彩 − 成本），用于日内止损 */
  realizedSince(fromMs: number, includeDryRun: boolean): number;
  /** 未了结仓位的成本合计 */
  openCost(includeDryRun: boolean): number;
  close(): void;
}

function toOrder(r: Record<string, unknown>): LiveOrderRow {
  return {
    id: Number(r.id),
    windowStart: Number(r.window_start),
    side: r.side as Side,
    tokenId: String(r.token_id),
    action: r.action as 'BUY' | 'SELL',
    amount: Number(r.amount),
    priceLimit: Number(r.price_limit),
    shares: Number(r.shares),
    usdc: Number(r.usdc),
    orderId: r.order_id == null ? null : String(r.order_id),
    status: String(r.status),
    dryRun: Number(r.dry_run) === 1,
    error: r.error == null ? null : String(r.error),
    createdAt: Number(r.created_at),
  };
}

function toPosition(r: Record<string, unknown>): LivePositionRow {
  return {
    id: Number(r.id),
    windowStart: Number(r.window_start),
    side: r.side as Side,
    tokenId: String(r.token_id),
    shares: Number(r.shares),
    cost: Number(r.cost),
    proceeds: Number(r.proceeds),
    status: r.status as LivePositionStatus,
    payout: r.payout == null ? null : Number(r.payout),
    dryRun: Number(r.dry_run) === 1,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export function openLiveStore(location = ':memory:', extraSchema = ''): LiveStore {
  const db = new DatabaseSync(location);
  if (location !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(LIVE_SCHEMA);
  if (extraSchema) db.exec(extraSchema);

  const insertOrder = db.prepare(
    `INSERT INTO live_order (window_start, side, token_id, action, amount, price_limit, shares, usdc, order_id, status, dry_run, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertPos = db.prepare(
    `INSERT INTO live_position (window_start, side, token_id, shares, cost, dry_run, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.prepare('SELECT * FROM live_position WHERE id = ?');
  const openFor = db.prepare("SELECT * FROM live_position WHERE window_start = ? AND status = 'OPEN' ORDER BY id DESC LIMIT 1");
  const allOpen = db.prepare("SELECT * FROM live_position WHERE status = 'OPEN' ORDER BY window_start ASC");

  return {
    db,
    recordOrder(o) {
      const info = insertOrder.run(
        o.windowStart, o.side, o.tokenId, o.action, o.amount, o.priceLimit, o.shares, o.usdc,
        o.orderId, o.status, o.dryRun ? 1 : 0, o.error, o.createdAt,
      );
      return { ...o, id: Number(info.lastInsertRowid) };
    },
    openPosition(p) {
      const info = insertPos.run(p.windowStart, p.side, p.tokenId, p.shares, p.cost, p.dryRun ? 1 : 0, p.nowMs, p.nowMs);
      return toPosition(byId.get(Number(info.lastInsertRowid)) as Record<string, unknown>);
    },
    closePosition(id, proceeds, nowMs) {
      db.prepare("UPDATE live_position SET status = 'SOLD', proceeds = proceeds + ?, updated_at = ? WHERE id = ? AND status = 'OPEN'").run(proceeds, nowMs, id);
    },
    partialSell(id, soldShares, proceeds, nowMs) {
      db.prepare(
        "UPDATE live_position SET shares = shares - ?, proceeds = proceeds + ?, updated_at = ? WHERE id = ? AND status = 'OPEN'",
      ).run(soldShares, proceeds, nowMs, id);
    },
    resolvePosition(id, won, nowMs) {
      db.prepare(
        "UPDATE live_position SET status = ?, payout = CASE WHEN ? = 1 THEN shares ELSE 0 END, updated_at = ? WHERE id = ? AND status = 'OPEN'",
      ).run(won ? 'WON' : 'LOST', won ? 1 : 0, nowMs, id);
    },
    position(id) {
      const r = byId.get(id) as Record<string, unknown> | undefined;
      return r ? toPosition(r) : null;
    },
    openPositionFor(windowStart) {
      const r = openFor.get(windowStart) as Record<string, unknown> | undefined;
      return r ? toPosition(r) : null;
    },
    openPositions() {
      return (allOpen.all() as Record<string, unknown>[]).map(toPosition);
    },
    recentOrders(limit) {
      return (db.prepare('SELECT * FROM live_order ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map(toOrder);
    },
    recentPositions(limit) {
      return (db.prepare('SELECT * FROM live_position ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map(toPosition);
    },
    realizedSince(fromMs, includeDryRun) {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(proceeds + COALESCE(payout, 0) - cost), 0) AS pnl FROM live_position
           WHERE status != 'OPEN' AND updated_at >= ? AND (? = 1 OR dry_run = 0)`,
        )
        .get(fromMs, includeDryRun ? 1 : 0) as Record<string, unknown>;
      return Number(row.pnl);
    },
    openCost(includeDryRun) {
      const row = db
        .prepare("SELECT COALESCE(SUM(cost), 0) AS c FROM live_position WHERE status = 'OPEN' AND (? = 1 OR dry_run = 0)")
        .get(includeDryRun ? 1 : 0) as Record<string, unknown>;
      return Number(row.c);
    },
    close() {
      db.close();
    },
  };
}
