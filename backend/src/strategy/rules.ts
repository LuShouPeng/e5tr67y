import { perShareFee } from '../domain/fee.ts';
import { TAKER_FEE_RATE, type Side } from '../domain/types.ts';

/**
 * 预测员的执行规则（移植自上游 `PredictionRules`）：判官拍板，代码只拦机械问题——
 * 把握不够、那边没人卖、没人接盘、钱包付不起一注。每注固定 `baseStake`，不做加仓。
 *
 * reason 一律「代码 + 细节」：BUY / PASS / UNSURE / NO_QUOTE / NO_BALANCE /
 * HOLD / SELL / NO_BID / MISSED / STALE_BOOK / STALE_CHAINLINK / RISK。
 */

export const MIN_STAKE = 1;
export const NO_BALANCE = 'NO_BALANCE';

export type EntryChoice = 'BUY_UP' | 'BUY_DOWN' | 'PASS';
export type ExitChoice = 'HOLD' | 'SELL';
export type Action = 'BUY_UP' | 'BUY_DOWN' | 'STAY_OUT' | 'HOLD' | 'SELL' | 'ERROR';

export interface Book {
  upAsk: number | null;
  upBid: number | null;
  downAsk: number | null;
  downBid: number | null;
}

export function askOf(book: Book, side: Side): number | null {
  return side === 'UP' ? book.upAsk : book.downAsk;
}

export function bidOf(book: Book, side: Side): number | null {
  return side === 'UP' ? book.upBid : book.downBid;
}

/** 判官给出的一次决定：选了什么、各选项概率 */
export interface Decision {
  choice: EntryChoice | ExitChoice;
  probabilities: Record<string, number>;
}

export interface RuleConfig {
  baseStake: number;
  /** 判官选的那一项概率到这里才照做；0.5 = 不小于其余选项加起来 */
  actThreshold: number;
}

export interface Entry {
  action: 'BUY_UP' | 'BUY_DOWN' | 'STAY_OUT';
  side: Side | null;
  stake: number | null;
  reason: string;
}

export interface Review {
  action: 'HOLD' | 'SELL';
  reason: string;
}

const fmt = (v: number): string => v.toFixed(3);

export function choiceP(d: Decision): number {
  return d.probabilities[d.choice] ?? 0;
}

/** 空仓：判官选买且把握够、那边有人卖、付得起就买 */
export function entry(d: Decision, book: Book, balance: number, cfg: RuleConfig): Entry {
  const p = choiceP(d);
  if (d.choice === 'PASS') return { action: 'STAY_OUT', side: null, stake: null, reason: `PASS ${fmt(p)}` };
  if (d.choice !== 'BUY_UP' && d.choice !== 'BUY_DOWN') {
    return { action: 'STAY_OUT', side: null, stake: null, reason: `PASS invalid ${d.choice}` };
  }
  const side: Side = d.choice === 'BUY_UP' ? 'UP' : 'DOWN';
  if (p < cfg.actThreshold) return { action: 'STAY_OUT', side, stake: null, reason: `UNSURE ${side} ${fmt(p)}` };
  const ask = askOf(book, side);
  if (ask == null) return { action: 'STAY_OUT', side, stake: null, reason: `NO_QUOTE ${side}` };
  const s = stake(cfg.baseStake, balance, ask);
  if (s == null) return { action: 'STAY_OUT', side, stake: null, reason: NO_BALANCE };
  return { action: d.choice, side, stake: s, reason: `BUY ${side} ${fmt(p)} ask ${ask}` };
}

/** 持仓：判官选卖、卖的概率比拿着高且到阈值才卖，否则拿着 */
export function exit(d: Decision, side: Side, book: Book, cfg: RuleConfig): Review {
  const p = choiceP(d);
  if (d.choice !== 'SELL') return { action: 'HOLD', reason: `HOLD ${fmt(p)}` };
  const hold = d.probabilities.HOLD ?? 0;
  if (p <= hold || p < cfg.actThreshold) return { action: 'HOLD', reason: `UNSURE SELL ${fmt(p)}` };
  return { action: 'SELL', reason: `SELL ${fmt(p)} bid ${bidOf(book, side)}` };
}

/** 买入每份优势：胜率 − 卖价 − 吃单费 */
export function edge(pSide: number, ask: number): number {
  return pSide - ask - perShareFee(ask);
}

/** 卖出每份扣费后比胜率多拿多少 */
export function sellOver(pSide: number, bid: number): number {
  return bid - perShareFee(bid) - pSide;
}

/** 想下多少和付得起多少取小；余额要留足手续费，不足最小本金就不下 */
export function stake(want: number, balance: number, ask: number): number | null {
  // 买入扣 cost + fee，fee/cost = 0.07 × (1 − ask)
  const feePerCost = TAKER_FEE_RATE * (1 - ask);
  const affordable = Math.floor((balance / (1 + feePerCost)) * 100) / 100;
  const s = Math.min(want, affordable);
  return s < MIN_STAKE ? null : s;
}

/** 市场隐含上涨概率：双边 mid 归一；一边没价回 null */
export function impliedUp(book: Book): number | null {
  const upMid = mid(book.upAsk, book.upBid);
  const downMid = mid(book.downAsk, book.downBid);
  if (upMid == null || downMid == null || upMid + downMid <= 0) return null;
  return upMid / (upMid + downMid);
}

export function mid(ask: number | null, bid: number | null): number | null {
  if (ask == null && bid == null) return null;
  if (ask == null) return bid;
  if (bid == null) return ask;
  return (ask + bid) / 2;
}

/** 这一边的数学胜率 */
export function sideP(pUp: number, side: Side): number {
  return side === 'UP' ? pUp : 1 - pUp;
}
