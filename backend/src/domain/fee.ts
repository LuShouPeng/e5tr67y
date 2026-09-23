import { roundTo } from './money.ts';
import { TAKER_FEE_RATE } from './types.ts';

/**
 * 每份合约的吃单费（USDT），即 `0.07 × p × (1 − p)`。
 *
 * 刻意不在这一步舍入：上游是把 `份数 × 每份费` 整体一次舍入到 4 位，
 * 先舍再乘会放大误差，所以分段结果只作为展示用（前端「手续费」提示）。
 */
export function perShareFee(price: number): number {
  if (price < 0 || price > 1) {
    throw new RangeError(`概率价格必须在 [0,1] 内：${price}`);
  }
  return TAKER_FEE_RATE * price * (1 - price);
}

/**
 * 一笔成交的吃单费：`份数 × 0.07 × p × (1 − p)`，4 位小数 HALF_UP。
 * 买卖双向都按吃单收取（两边都按盘口最优价成交）。
 * 费用在 50¢ 时最贵（每份 1.75¢），越靠近 0/1 越便宜，两端为 0。
 */
export function takerFee(contracts: number, price: number): number {
  return roundTo(contracts * perShareFee(price));
}
