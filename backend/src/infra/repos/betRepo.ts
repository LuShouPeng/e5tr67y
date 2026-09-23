import type { DatabaseSync } from 'node:sqlite';

import { roundTo } from '../../domain/money.ts';
import type { BetStatus, PredictionBet, Side } from '../../domain/types.ts';

export interface NewBet {
  userId: number;
  roundId: number;
  windowStart: number;
  side: Side;
  contracts: number;
  cost: number;
  avgPrice: number;
}

export interface BetRepo {
  insert(bet: NewBet): PredictionBet;
  findById(id: number): PredictionBet | null;
  listActiveByUser(userId: number): PredictionBet[];
  listByUser(userId: number, limit: number, offset: number): { rows: PredictionBet[]; total: number };
  listByRoundAndStatus(roundId: number, status: BetStatus): PredictionBet[];
  listRecent(limit: number): PredictionBet[];
  countActiveByRound(roundId: number): number;
  /** 整单卖出：ACTIVE → SOLD，payout 记到账金额 */
  casSellFull(id: number, netRevenue: number): number;
  /** 部分卖出：扣减份数与成本，原单保持 ACTIVE */
  casPartialSell(id: number, sellContracts: number, soldCost: number): number;
  /** 批量置赢：方向正确且仍 ACTIVE 的注单，派彩 = 份数 × $1 */
  settleWon(roundId: number, outcome: Side): number;
  /** 批量置输：方向相反且仍 ACTIVE，派彩 0 */
  settleLost(roundId: number, losingSide: Side): number;
  /** 批量退款标记：ACTIVE → DRAW，payout 记回本金（作废回合走这条） */
  settleDraw(roundId: number): number;
}

function toBet(row: Record<string, unknown>): PredictionBet {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    roundId: Number(row.round_id),
    windowStart: Number(row.window_start),
    side: row.side as Side,
    contracts: roundTo(Number(row.contracts)),
    cost: roundTo(Number(row.cost)),
    avgPrice: roundTo(Number(row.avg_price)),
    payout: row.payout == null ? null : roundTo(Number(row.payout)),
    status: row.status as BetStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createBetRepo(db: DatabaseSync): BetRepo {
  const insert = db.prepare(
    `INSERT INTO prediction_bet
       (user_id, round_id, window_start, side, contracts, cost, avg_price, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
  );
  const byId = db.prepare('SELECT * FROM prediction_bet WHERE id = ?');
  const activeByUser = db.prepare(
    `SELECT * FROM prediction_bet WHERE user_id = ? AND status = 'ACTIVE' ORDER BY id DESC`,
  );
  const countByUser = db.prepare('SELECT COUNT(*) AS c FROM prediction_bet WHERE user_id = ?');
  const byUser = db.prepare(
    'SELECT * FROM prediction_bet WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
  );
  const byRoundStatus = db.prepare(
    'SELECT * FROM prediction_bet WHERE round_id = ? AND status = ? ORDER BY id ASC',
  );
  const recent = db.prepare('SELECT * FROM prediction_bet ORDER BY id DESC LIMIT ?');
  const countActive = db.prepare(
    `SELECT COUNT(*) AS c FROM prediction_bet WHERE round_id = ? AND status = 'ACTIVE'`,
  );
  const sellFull = db.prepare(
    `UPDATE prediction_bet
        SET status = 'SOLD', payout = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'ACTIVE'`,
  );
  const sellPartial = db.prepare(
    `UPDATE prediction_bet
        SET contracts = contracts - ?, cost = cost - ?,
            avg_price = ROUND((cost - ?) / (contracts - ?), 4), updated_at = datetime('now')
      WHERE id = ? AND status = 'ACTIVE' AND contracts >= ?`,
  );
  const settleWon = db.prepare(
    `UPDATE prediction_bet
        SET status = 'WON', payout = contracts, updated_at = datetime('now')
      WHERE round_id = ? AND status = 'ACTIVE' AND side = ?`,
  );
  const settleLost = db.prepare(
    `UPDATE prediction_bet
        SET status = 'LOST', payout = 0, updated_at = datetime('now')
      WHERE round_id = ? AND status = 'ACTIVE' AND side = ?`,
  );
  const settleDraw = db.prepare(
    `UPDATE prediction_bet
        SET status = 'DRAW', payout = cost, updated_at = datetime('now')
      WHERE round_id = ? AND status = 'ACTIVE'`,
  );

  return {
    insert(bet) {
      const info = insert.run(
        bet.userId,
        bet.roundId,
        bet.windowStart,
        bet.side,
        roundTo(bet.contracts),
        roundTo(bet.cost),
        roundTo(bet.avgPrice),
      );
      const created = byId.get(Number(info.lastInsertRowid)) as Record<string, unknown>;
      return toBet(created);
    },
    findById(id) {
      const row = byId.get(id) as Record<string, unknown> | undefined;
      return row ? toBet(row) : null;
    },
    listActiveByUser(userId) {
      return (activeByUser.all(userId) as Record<string, unknown>[]).map(toBet);
    },
    listByUser(userId, limit, offset) {
      const rows = byUser.all(userId, limit, offset) as Record<string, unknown>[];
      const total = Number((countByUser.get(userId) as Record<string, unknown>).c);
      return { rows: rows.map(toBet), total };
    },
    listByRoundAndStatus(roundId, status) {
      return (byRoundStatus.all(roundId, status) as Record<string, unknown>[]).map(toBet);
    },
    listRecent(limit) {
      return (recent.all(limit) as Record<string, unknown>[]).map(toBet);
    },
    countActiveByRound(roundId) {
      return Number((countActive.get(roundId) as Record<string, unknown>).c);
    },
    casSellFull(id, netRevenue) {
      return Number(sellFull.run(roundTo(netRevenue), id).changes);
    },
    casPartialSell(id, sellContracts, soldCost) {
      const contracts = roundTo(sellContracts);
      const cost = roundTo(soldCost);
      return Number(sellPartial.run(contracts, cost, cost, contracts, id, contracts).changes);
    },
    settleWon(roundId, outcome) {
      return Number(settleWon.run(roundId, outcome).changes);
    },
    settleLost(roundId, losingSide) {
      return Number(settleLost.run(roundId, losingSide).changes);
    },
    settleDraw(roundId) {
      return Number(settleDraw.run(roundId).changes);
    },
  };
}
