export type Side = 'UP' | 'DOWN';
export type RoundStatus = 'OPEN' | 'LOCKED' | 'SETTLED';
export type RoundOutcome = 'UP' | 'DOWN' | 'VOID';
export type BetStatus = 'ACTIVE' | 'WON' | 'LOST' | 'SOLD' | 'DRAW';

export interface RoundView {
  id: number;
  windowStart: number;
  startPrice: number | null;
  endPrice: number | null;
  outcome: RoundOutcome | null;
  status: RoundStatus;
  remainingSeconds: number;
  serverTimeMs: number;
}

export interface QuoteLevel {
  bid: number | null;
  ask: number | null;
}

export interface QuoteBook {
  up: QuoteLevel;
  down: QuoteLevel;
  ts: number;
}

/** 行情推送：扁平字段，与 SSE 首帧同形状 */
export interface MarketEvent {
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
  ts: number;
  degraded?: boolean;
}

export interface BetView {
  id: number;
  roundId: number;
  windowStart: number;
  side: Side;
  contracts: number;
  cost: number;
  avgPrice: number;
  payout: number | null;
  status: BetStatus;
  createdAt: string;
  currentValue: number | null;
}

export interface PnlView {
  totalBets: number;
  activeBets: number;
  wonBets: number;
  lostBets: number;
  soldBets: number;
  voidBets: number;
  settledBets: number;
  winRate: number;
  totalCost: number;
  realizedPnl: number;
  activeCost: number;
  activeValue: number;
  unrealizedPnl: number;
  totalPnl: number;
  gameBalance: number;
  equity: number;
}

export interface PageView<T> {
  rows: T[];
  total: number;
  pageNum: number;
  pageSize: number;
}

export interface LiveBetView {
  username: string;
  side: Side;
  amount: number;
  ts: number;
  createdAt: string;
}

export interface PricePoint {
  time: number;
  price: number;
}

export interface CurrentResponse {
  round: RoundView;
  quote: QuoteBook | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** 领域错误码 → 中文提示（后端已给消息，这里只兜底未知码） */
export const ERROR_HINT: Record<string, string> = {
  SIDE_INVALID: '方向不合法',
  AMOUNT_INVALID: '金额需在 1 ~ 10000 之间',
  CONTRACTS_INVALID: '份数不合法',
  ROUND_NOT_FOUND: '当前回合尚未开盘',
  ROUND_LOCKED: '回合已封盘，等结算',
  BET_NOT_FOUND: '找不到这笔注单',
  BET_NOT_ACTIVE: '注单已了结，不能卖出',
  PRICE_UNAVAILABLE: '盘口不可用，稍后重试',
  INSUFFICIENT_BALANCE: '游戏钱包余额不足',
  INTERNAL_ERROR: '服务内部错误',
  NOT_FOUND: '接口不存在',
};
