/** 5 分钟回合的窗口长度（秒），与 Polymarket btc-updown-5m 口径一致 */
export const WINDOW_SECONDS = 300;

/** 单笔下单金额区间（USDT） */
export const MIN_AMOUNT = 1;
export const MAX_AMOUNT = 10_000;

/** Polymarket 吃单费费率（crypto_fees_v2） */
export const TAKER_FEE_RATE = 0.07;

/** 合约 / 成本 / 派彩统一精度：4 位小数 */
export const SCALE = 4;

/** 取不到价时，有持仓的回合最多等这么久才作废退本金（秒） */
export const VOID_AFTER_SECONDS = 3600;

/** 无持仓的回合，窗口结束两个周期后仍无价即作废 */
export const VOID_IDLE_WINDOWS = 2;

export type Side = 'UP' | 'DOWN';

export type RoundStatus = 'OPEN' | 'LOCKED' | 'SETTLED';

/** VOID 只在取不到开/收盘价时出现，注单退本金 */
export type RoundOutcome = 'UP' | 'DOWN' | 'VOID';

export type BetStatus = 'ACTIVE' | 'WON' | 'LOST' | 'SOLD' | 'DRAW';

export interface PredictionRound {
  id: number;
  windowStart: number;
  startPrice: number | null;
  endPrice: number | null;
  outcome: RoundOutcome | null;
  status: RoundStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PredictionBet {
  id: number;
  userId: number;
  roundId: number;
  windowStart: number;
  side: Side;
  contracts: number;
  cost: number;
  avgPrice: number;
  payout: number | null;
  status: BetStatus;
  createdAt: string;
  updatedAt: string;
}
