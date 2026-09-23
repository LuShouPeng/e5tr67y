import { DomainError } from './errors.ts';
import { roundTo, truncateTo } from './money.ts';
import { takerFee } from './fee.ts';
import { MAX_AMOUNT, MIN_AMOUNT, type Side } from './types.ts';

/** 一张合约在预测正确时的兑付额（USDT） */
export const CONTRACT_PAYOUT = 1;

export function assertSide(side: unknown): asserts side is Side {
  if (side !== 'UP' && side !== 'DOWN') {
    throw new DomainError('SIDE_INVALID', `方向只能是 UP 或 DOWN，收到：${String(side)}`);
  }
}

export function assertAmount(amount: unknown): asserts amount is number {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new DomainError('AMOUNT_INVALID', '金额必须是有限数值');
  }
  if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    throw new DomainError('AMOUNT_INVALID', `单笔金额需在 [${MIN_AMOUNT}, ${MAX_AMOUNT}] 内，收到：${amount}`);
  }
}

export interface BuyPlan {
  /** 成交价（取卖一） */
  price: number;
  /** 份数：金额 ÷ 价，4 位小数向零取整（不足一份的零头不送） */
  contracts: number;
  /** 合约成本 = 份数 × 价 */
  cost: number;
  /** 吃单费 */
  fee: number;
  /** 实际扣款 = 成本 + 吃单费 */
  total: number;
  /** 预测正确时可拿回 = 份数 × $1 */
  payout: number;
}

/**
 * 买入试算。份数向零取整保证 `成本 ≤ 金额`，手续费在金额之外另扣，
 * 因此**预留额度应是 `金额 + 手续费`**，而不是金额本身。
 */
export function planBuy(amount: number, ask: number): BuyPlan {
  assertAmount(amount);
  if (!(ask > 0 && ask < 1)) {
    throw new DomainError('PRICE_UNAVAILABLE', `卖一价不可用：${ask}`);
  }

  // 金额 >= 1 且卖一价 < 1，份数必然 >= 1，无需再判零
  const contracts = truncateTo(amount / ask);
  const cost = roundTo(contracts * ask);
  const fee = takerFee(contracts, ask);
  return {
    price: ask,
    contracts,
    cost,
    fee,
    total: roundTo(cost + fee),
    payout: roundTo(contracts * CONTRACT_PAYOUT),
  };
}

export interface SellPlan {
  /** 成交价（取买一） */
  price: number;
  contracts: number;
  /** 成交额（未扣费） */
  gross: number;
  fee: number;
  /** 到手 = 成交额 − 吃单费 */
  net: number;
}

export function planSell(contracts: number, bid: number): SellPlan {
  if (!Number.isFinite(contracts) || contracts <= 0) {
    throw new DomainError('CONTRACTS_INVALID', `份数必须为正：${contracts}`);
  }
  if (!(bid > 0 && bid <= 1)) {
    throw new DomainError('PRICE_UNAVAILABLE', `买一价不可用：${bid}`);
  }

  const gross = roundTo(contracts * bid);
  const fee = takerFee(contracts, bid);
  return { price: bid, contracts, gross, fee, net: roundTo(gross - fee) };
}

/**
 * 预估收益：`金额 ÷ 概率价格`（每份按 $1 结算，手续费另扣）。
 * 前端「预计收益」用的就是它，与 planBuy 的 contracts 同口径。
 */
export function estimateContracts(amount: number, price: number): number {
  if (!(price > 0 && price <= 1)) return 0;
  return truncateTo(amount / price);
}
