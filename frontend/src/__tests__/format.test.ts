import { describe, expect, it } from 'vitest';

import {
  betStatusLabel,
  fmtAgo,
  fmtCountdown,
  fmtCreatedAt,
  fmtMoney,
  fmtNum,
  fmtSigned,
  fmtTime,
  fmtWindow,
  outcomeLabel,
  roundStatusLabel,
  sideLabel,
  toCents,
  trendClass,
} from '../lib/format.ts';

describe('fmtNum / fmtSigned / fmtMoney', () => {
  it('千分位 + 固定小数位', () => {
    expect(fmtNum(1234.5)).toBe('1,234.50');
    expect(fmtNum(0)).toBe('0.00');
    expect(fmtNum(12.3456, 4)).toBe('12.3456');
  });

  it('空值与非法值统一显示 --（而不是 NaN）', () => {
    expect(fmtNum(null)).toBe('--');
    expect(fmtNum(undefined)).toBe('--');
    expect(fmtNum(Number.NaN)).toBe('--');
    expect(fmtMoney(Number.POSITIVE_INFINITY)).toBe('--');
  });

  it('盈亏带符号', () => {
    expect(fmtSigned(12.5)).toBe('+12.50');
    expect(fmtSigned(-3)).toBe('-3.00');
    expect(fmtSigned(0)).toBe('0.00');
  });

  it('金额带 $，负数符号在 $ 之外', () => {
    expect(fmtMoney(1234.5)).toBe('$1,234.50');
    expect(fmtMoney(-8.25)).toBe('-$8.25');
    expect(fmtMoney(85990.819, 2)).toBe('$85,990.82');
  });
});

describe('toCents：概率价 → 美分', () => {
  it('0.61 → 61¢，0.5 → 50¢', () => {
    expect(toCents(0.61)).toBe('61¢');
    expect(toCents(0.5)).toBe('50¢');
  });

  it('保留一位小数，小数尾零去掉', () => {
    expect(toCents(0.005)).toBe('0.5¢');
    expect(toCents(0.012)).toBe('1.2¢');
    expect(toCents(0.0175)).toBe('1.8¢');
  });

  it('两端与空值', () => {
    expect(toCents(0)).toBe('0¢');
    expect(toCents(1)).toBe('100¢');
    expect(toCents(null)).toBe('--');
  });
});

describe('fmtCountdown：倒计时', () => {
  it('264 → 04:24', () => {
    expect(fmtCountdown(264)).toBe('04:24');
  });

  it('边界：0 与 300', () => {
    expect(fmtCountdown(0)).toBe('00:00');
    expect(fmtCountdown(300)).toBe('05:00');
    expect(fmtCountdown(59)).toBe('00:59');
  });

  it('负数夹到 0，不出现 -01:00', () => {
    expect(fmtCountdown(-5)).toBe('00:00');
  });

  it('小数向下取整，空值占位', () => {
    expect(fmtCountdown(59.9)).toBe('00:59');
    expect(fmtCountdown(null)).toBe('--:--');
  });
});

describe('时间格式化', () => {
  it('fmtWindow 给出回合区间', () => {
    const start = new Date(2026, 8, 23, 17, 5, 0).getTime() / 1000;
    expect(fmtWindow(start)).toBe('17:05–17:10');
  });

  it('fmtTime 补零', () => {
    const t = new Date(2026, 8, 23, 9, 5, 0).getTime() / 1000;
    expect(fmtTime(t)).toBe('09:05');
  });

  it('后端 UTC 时间串按本地时区显示', () => {
    // 后端返回的是 UTC，前端要换成本地展示，不能直接把字符串切出来用
    const formatted = fmtCreatedAt('2026-09-23 12:25:42');
    const expected = new Date(Date.UTC(2026, 8, 23, 12, 25, 42));
    expect(formatted).toBe(
      [expected.getHours(), expected.getMinutes(), expected.getSeconds()]
        .map((n) => String(n).padStart(2, '0'))
        .join(':'),
    );
  });

  it('无法解析的时间串原样返回，不崩', () => {
    expect(fmtCreatedAt('随便什么')).toBe('随便什么');
    expect(fmtCreatedAt(null)).toBe('--');
  });

  it('fmtAgo 分级', () => {
    const now = 1_700_000_000_000;
    expect(fmtAgo(now - 1000, now)).toBe('刚刚');
    expect(fmtAgo(now - 12_000, now)).toBe('12 秒前');
    expect(fmtAgo(now - 180_000, now)).toBe('3 分钟前');
    expect(fmtAgo(now - 7_200_000, now)).toBe('2 小时前');
    expect(fmtAgo(now - 172_800_000, now)).toBe('2 天前');
  });
});

describe('trendClass：涨绿跌红中立灰', () => {
  it('正负零与空值', () => {
    expect(trendClass(1)).toBe('up');
    expect(trendClass(-1)).toBe('down');
    expect(trendClass(0)).toBe('muted');
    expect(trendClass(null)).toBe('muted');
  });
});

describe('文案映射', () => {
  it('中文标签', () => {
    expect(sideLabel('UP')).toBe('看涨');
    expect(sideLabel('DOWN')).toBe('看跌');
    expect(betStatusLabel('WON')).toBe('猜对');
    expect(betStatusLabel('DRAW')).toBe('已作废');
    expect(roundStatusLabel('LOCKED')).toBe('已封盘');
    expect(outcomeLabel('UP')).toBe('涨');
    expect(outcomeLabel('VOID')).toBe('作废');
    expect(outcomeLabel(null)).toBe('待定');
  });

  it('未知状态原样返回，不会显示 undefined', () => {
    expect(betStatusLabel('SOMETHING')).toBe('SOMETHING');
    expect(roundStatusLabel('X')).toBe('X');
  });
});
