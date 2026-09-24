import type { Side } from '../domain/types.ts';

/**
 * 下单通道。策略回路只认这个接口，不关心背后是模拟盘还是实盘：
 * - `paper`：本仓库原有的虚拟资金预测游戏（PredictionService），用一个专属机器人账户下注；
 * - `live`：Polymarket CLOB 真金白银，见 `src/live/`，独立库、独立风控、独立开关。
 * 两者不共享余额、持仓和成交记录。
 */

export type BrokerKind = 'paper' | 'live';

export interface BrokerPosition {
  /** 通道内的持仓标识：模拟盘是注单 id，实盘是 live_position 主键 */
  id: string;
  windowStart: number;
  side: Side;
  contracts: number;
  avgPrice: number;
  cost: number;
}

export interface Fill {
  id: string;
  side: Side;
  contracts: number;
  avgPrice: number;
  /** 买入花掉 / 卖出拿回的金额（不含费） */
  amount: number;
  dryRun?: boolean;
}

export interface BuyRequest {
  windowStart: number;
  side: Side;
  /** 本金（USDC / 游戏币） */
  stake: number;
  /** 最差成交价：卖一高过它就不买（跟挂限价单一样） */
  maxPrice: number;
}

export interface SellRequest {
  position: BrokerPosition;
  /** 最差成交价：买一低于它就不卖 */
  minPrice: number;
}

export class OrderRejectedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Broker {
  readonly kind: BrokerKind;
  balance(): Promise<number>;
  /** 该窗口在持的仓位，没有为 null */
  position(windowStart: number): Promise<BrokerPosition | null>;
  /** 是否还有等结算的仓位（本金押着，结了可能回钱） */
  hasUnsettled(): Promise<boolean>;
  buy(req: BuyRequest): Promise<Fill>;
  sell(req: SellRequest): Promise<Fill>;
  /** 买入那笔到终态后的盈亏；未到终态回 null */
  realizedPnl(fillId: string): Promise<number | null>;
}
