export type RoundingMode = 'HALF_UP' | 'DOWN';

const DEFAULT_DP = 4;
/** Number 能精确表示的最大整数；超过则定点放大后无法无损转回 */
const MAX_SAFE_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

function assertFinite(value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`资金计算不接受非有限数值：${value}`);
  }
}

/**
 * 绝对值的最短往返十进制串（不含指数）。
 * `toString()` 只在 `< 1e-6` 或 `>= 1e21` 时用科学计数法：前者在 4 位小数下必然舍入为 0，
 * 后者远超本域量级（单笔上限 1 万），所以这两种情况交给调用方兜底。
 */
function plainAbsString(absValue: number): string | null {
  const s = absValue.toString();
  return s.includes('e') || s.includes('E') ? null : s;
}

/**
 * 定点舍入。走字符串而不是 `x * 10**dp`：后者会把 `0.1+0.2` 这类浮点尾差带进资金结果，
 * 而最短往返串已经是这个 double 最精确的十进制表示，不会多舍入一次。
 */
function shiftRound(value: number, dp: number, mode: RoundingMode): number {
  assertFinite(value);
  if (value === 0) return 0;

  const abs = Math.abs(value);
  const plain = plainAbsString(abs);
  if (plain === null) {
    // 科学计数法：要么是极小值（< 1e-6，4 位小数下就是 0），要么大到超出本域量级
    if (abs < 1) return 0;
    throw new RangeError(`数值超出定点范围：${value}`);
  }

  const [intPart = '0', fracPart = ''] = plain.split('.');
  const kept = fracPart.slice(0, dp).padEnd(dp, '0');
  const dropped = fracPart.slice(dp);

  let units = BigInt(intPart + kept);
  // BigDecimal HALF_UP：丢弃部分 >= 一半就向远离零方向进位
  if (mode === 'HALF_UP' && dropped.length > 0 && dropped.charCodeAt(0) - 48 >= 5) {
    units += 1n;
  }
  if (units > MAX_SAFE_UNITS) {
    throw new RangeError(`数值超出安全定点范围：${value}`);
  }

  const result = Number(units) / 10 ** dp;
  // 归零：-0 会在 Object.is 比较与 JSON 序列化里表现异常，资金值只保留 +0
  if (result === 0) return 0;
  return value < 0 ? -result : result;
}

/**
 * 四舍五入到 `dp` 位小数（HALF_UP，与 Java `BigDecimal.setScale(HALF_UP)` 同口径）。
 * 所有成本、费用、派彩落地前都过这里，保证金额始终落在 4 位小数的网格上。
 */
export function roundTo(value: number, dp: number = DEFAULT_DP, mode: RoundingMode = 'HALF_UP'): number {
  return shiftRound(value, dp, mode);
}

/** 向零取整到 `dp` 位小数（HALF_UP 之外，与 `BigDecimal RoundingMode.DOWN` 同口径） */
export function truncateTo(value: number, dp: number = DEFAULT_DP): number {
  return shiftRound(value, dp, 'DOWN');
}
