import type { DatabaseSync } from 'node:sqlite';

import type { PredictionRound, RoundOutcome, RoundStatus } from '../../domain/types.ts';
import { roundTo } from '../../domain/money.ts';

export interface RoundRepo {
  /** 幂等开回合：window_start 唯一，重复调用不会覆盖已有行 */
  insertIfAbsent(windowStart: number, startPrice: number | null): void;
  findByWindowStart(windowStart: number): PredictionRound | null;
  findById(id: number): PredictionRound | null;
  /** 回填目标价，只在 OPEN 期间有效 */
  updateStartPrice(windowStart: number, startPrice: number): number;
  /** 结算时补目标价：锁定后 updateStartPrice 已经够不着这行，另走一条只认空值的 CAS */
  fillStartPrice(id: number, startPrice: number): number;
  /** 封盘 OPEN → LOCKED */
  casLock(windowStart: number): number;
  /** 定盘 LOCKED → SETTLED，带上结果价与方向 */
  casSettle(id: number, endPrice: number, outcome: RoundOutcome): number;
  /** 作废 LOCKED → SETTLED(outcome=VOID) */
  casVoid(id: number): number;
  listSettled(limit: number, offset: number): { rows: PredictionRound[]; total: number };
  /** 找出窗口早已结束却还停在 OPEN / LOCKED 的回合，供巡检补结算 */
  listUnsettledBefore(windowStartExclusive: number, limit?: number): PredictionRound[];
}

function toRound(row: Record<string, unknown>): PredictionRound {
  return {
    id: Number(row.id),
    windowStart: Number(row.window_start),
    startPrice: row.start_price == null ? null : roundTo(Number(row.start_price), 8),
    endPrice: row.end_price == null ? null : roundTo(Number(row.end_price), 8),
    outcome: (row.outcome as RoundOutcome | null) ?? null,
    status: row.status as RoundStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createRoundRepo(db: DatabaseSync): RoundRepo {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO prediction_round (window_start, start_price) VALUES (?, ?)',
  );
  const byWindow = db.prepare('SELECT * FROM prediction_round WHERE window_start = ?');
  const byId = db.prepare('SELECT * FROM prediction_round WHERE id = ?');
  const updatePrice = db.prepare(
    `UPDATE prediction_round
        SET start_price = ?, updated_at = datetime('now')
      WHERE window_start = ? AND status = 'OPEN'`,
  );
  const fillStartPrice = db.prepare(
    `UPDATE prediction_round
        SET start_price = ?, updated_at = datetime('now')
      WHERE id = ? AND start_price IS NULL`,
  );
  const casLock = db.prepare(
    `UPDATE prediction_round
        SET status = 'LOCKED', updated_at = datetime('now')
      WHERE window_start = ? AND status = 'OPEN'`,
  );
  const casSettle = db.prepare(
    `UPDATE prediction_round
        SET status = 'SETTLED', end_price = ?, outcome = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'LOCKED'`,
  );
  const casVoid = db.prepare(
    `UPDATE prediction_round
        SET status = 'SETTLED', outcome = 'VOID', updated_at = datetime('now')
      WHERE id = ? AND status = 'LOCKED'`,
  );
  const countSettled = db.prepare(`SELECT COUNT(*) AS c FROM prediction_round WHERE status = 'SETTLED'`);
  const listSettledStmt = db.prepare(
    `SELECT * FROM prediction_round
      WHERE status = 'SETTLED'
      ORDER BY window_start DESC
      LIMIT ? OFFSET ?`,
  );
  const listUnsettled = db.prepare(
    `SELECT * FROM prediction_round
      WHERE status <> 'SETTLED' AND window_start < ?
      ORDER BY window_start ASC
      LIMIT ?`,
  );

  return {
    insertIfAbsent(windowStart, startPrice) {
      insert.run(windowStart, startPrice == null ? null : roundTo(startPrice, 8));
    },
    findByWindowStart(windowStart) {
      const row = byWindow.get(windowStart) as Record<string, unknown> | undefined;
      return row ? toRound(row) : null;
    },
    findById(id) {
      const row = byId.get(id) as Record<string, unknown> | undefined;
      return row ? toRound(row) : null;
    },
    updateStartPrice(windowStart, startPrice) {
      return Number(updatePrice.run(roundTo(startPrice, 8), windowStart).changes);
    },
    fillStartPrice(id, startPrice) {
      return Number(fillStartPrice.run(roundTo(startPrice, 8), id).changes);
    },
    casLock(windowStart) {
      return Number(casLock.run(windowStart).changes);
    },
    casSettle(id, endPrice, outcome) {
      return Number(casSettle.run(roundTo(endPrice, 8), outcome, id).changes);
    },
    casVoid(id) {
      return Number(casVoid.run(id).changes);
    },
    listSettled(limit, offset) {
      const rows = listSettledStmt.all(limit, offset) as Record<string, unknown>[];
      const total = Number((countSettled.get() as Record<string, unknown>).c);
      return { rows: rows.map(toRound), total };
    },
    listUnsettledBefore(windowStartExclusive, limit = 50) {
      const rows = listUnsettled.all(windowStartExclusive, limit) as Record<string, unknown>[];
      return rows.map(toRound);
    },
  };
}
