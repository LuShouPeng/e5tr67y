import type { DatabaseSync } from 'node:sqlite';

import { roundTo } from '../../domain/money.ts';

/** 新用户开户时的游戏钱包初始额度（虚拟资金） */
export const DEFAULT_GAME_BALANCE = 100_000;

export interface Account {
  userId: number;
  username: string;
  gameBalance: number;
  balance: number;
}

export interface AccountRepo {
  /** 幂等开户：不存在才建，带初始虚拟资金 */
  ensure(userId: number, username?: string, initialGameBalance?: number): void;
  find(userId: number): Account | null;
  gameBalanceOf(userId: number): number;
  /**
   * 增减游戏钱包余额，返回受影响行数。
   * 扣款时带 `game_balance + delta >= 0` 条件：余额不足时 0 行受影响，
   * 于是「检查余额」和「扣款」是同一个原子动作，不存在先查后扣的竞态。
   */
  addGameBalance(userId: number, delta: number): number;
}

function toAccount(row: Record<string, unknown>): Account {
  return {
    userId: Number(row.user_id),
    username: String(row.username ?? ''),
    gameBalance: Number(row.game_balance),
    balance: Number(row.balance),
  };
}

export function createAccountRepo(db: DatabaseSync): AccountRepo {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO account (user_id, username, game_balance) VALUES (?, ?, ?)',
  );
  const selectOne = db.prepare('SELECT * FROM account WHERE user_id = ?');
  const selectBalance = db.prepare('SELECT game_balance FROM account WHERE user_id = ?');
  const update = db.prepare(
    `UPDATE account
        SET game_balance = game_balance + ?,
            updated_at = datetime('now')
      WHERE user_id = ?
        AND game_balance + ? >= 0`,
  );

  return {
    ensure(userId, username = '', initialGameBalance = DEFAULT_GAME_BALANCE) {
      insert.run(userId, username, roundTo(initialGameBalance));
    },

    find(userId) {
      const row = selectOne.get(userId) as Record<string, unknown> | undefined;
      return row ? toAccount(row) : null;
    },

    gameBalanceOf(userId) {
      const row = selectBalance.get(userId) as Record<string, unknown> | undefined;
      return row ? roundTo(Number(row.game_balance)) : 0;
    },

    addGameBalance(userId, delta) {
      const rounded = roundTo(delta);
      return Number(update.run(rounded, userId, rounded).changes);
    },
  };
}
