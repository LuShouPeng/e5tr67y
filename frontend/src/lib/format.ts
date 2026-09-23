/** 千分位 + 固定小数位；负数保留符号，等宽渲染时小数点仍对齐 */
export function fmtNum(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '--';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 带符号的数字，盈亏列用 */
export function fmtSigned(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '--';
  const sign = value > 0 ? '+' : '';
  return `${sign}${fmtNum(value, digits)}`;
}

/** 概率价 → 美分。0.61 → 61¢，0.005 → 0.5¢ */
export function toCents(price: number | null | undefined, digits = 1): string {
  if (price == null || !Number.isFinite(price)) return '--';
  const cents = price * 100;
  const rounded = Number(cents.toFixed(digits));
  return `${rounded}¢`;
}

export function fmtMoney(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '--';
  const sign = value < 0 ? '-' : '';
  return `${sign}$${fmtNum(Math.abs(value), digits)}`;
}

/** 倒计时：264 → 04:24 */
export function fmtCountdown(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 秒级时间戳 → 本地 HH:MM */
export function fmtTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--';
  const d = new Date(seconds * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 回合时间段：17:05–17:10 */
export function fmtWindow(windowStart: number, windowSeconds = 300): string {
  return `${fmtTime(windowStart)}–${fmtTime(windowStart + windowSeconds)}`;
}

/** 后端返回的 UTC 字符串（"2026-09-23 12:25:42"）→ 本地 HH:MM:SS */
export function fmtCreatedAt(value: string | null | undefined): string {
  if (value == null || value === '') return '--';
  const ms = Date.parse(`${value.replace(' ', 'T')}Z`);
  if (!Number.isFinite(ms)) return value;
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

/** 相对时间：12 秒前 / 3 分钟前 */
export function fmtAgo(ts: number, nowMs: number): string {
  const diff = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diff < 5) return '刚刚';
  if (diff < 60) return `${diff} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86_400)} 天前`;
}

/** 涨跌方向 → class 名 */
export function trendClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return 'muted';
  return value > 0 ? 'up' : 'down';
}

export function sideLabel(side: 'UP' | 'DOWN'): string {
  return side === 'UP' ? '看涨' : '看跌';
}

export function betStatusLabel(status: string): string {
  const map: Record<string, string> = {
    ACTIVE: '持仓中',
    WON: '猜对',
    LOST: '猜错',
    SOLD: '已卖出',
    DRAW: '已作废',
  };
  return map[status] ?? status;
}

export function roundStatusLabel(status: string): string {
  const map: Record<string, string> = { OPEN: '可交易', LOCKED: '已封盘', SETTLED: '已结算' };
  return map[status] ?? status;
}

export function outcomeLabel(outcome: string | null): string {
  if (outcome == null) return '待定';
  const map: Record<string, string> = { UP: '涨', DOWN: '跌', VOID: '作废' };
  return map[outcome] ?? outcome;
}
