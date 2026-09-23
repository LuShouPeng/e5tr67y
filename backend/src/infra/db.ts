import { DatabaseSync } from 'node:sqlite';

/**
 * 建表语句。
 *
 * 金额列用 REAL 存：写入前一律经过 `roundTo(..., 4)` 落到 4 位小数网格，
 * double 在这个量级（<= 1e4，8 位有效数字）的往返是无损的，读取时再舍一次即可。
 * 唯一约束 `prediction_round.window_start` 是回合的天然幂等键——重复开回合插不进去。
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS account (
  user_id      INTEGER PRIMARY KEY,
  username     TEXT    NOT NULL DEFAULT '',
  game_balance REAL    NOT NULL DEFAULT 0,
  balance      REAL    NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prediction_round (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  window_start INTEGER NOT NULL UNIQUE,
  start_price  REAL,
  end_price    REAL,
  outcome      TEXT,
  status       TEXT    NOT NULL DEFAULT 'OPEN',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prediction_bet (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  round_id     INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  side         TEXT    NOT NULL,
  contracts    REAL    NOT NULL,
  cost         REAL    NOT NULL,
  avg_price    REAL    NOT NULL,
  payout       REAL,
  status       TEXT    NOT NULL DEFAULT 'ACTIVE',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pred_bet_round ON prediction_bet(round_id, status);
CREATE INDEX IF NOT EXISTS idx_pred_bet_user  ON prediction_bet(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pred_round_status ON prediction_round(status, window_start DESC);
`;

export function openDatabase(location = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(location);
  db.exec('PRAGMA foreign_keys = ON');
  if (location !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec(SCHEMA);
  return db;
}

/**
 * 单层事务：整段要么全成要么全滚。
 * 刻意不做嵌套保存点——钱的用例都应该是「一件事一个事务」，嵌套只会掩盖设计问题。
 */
export function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
