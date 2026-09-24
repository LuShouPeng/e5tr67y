import { perShareFee } from '../domain/fee.ts';
import { WINDOW_SECONDS, type Side } from '../domain/types.ts';
import type { FlowMetrics, Liquidation } from '../market/binance.ts';
import {
  SETTLE_LAG_SECONDS,
  TWAP_SECONDS,
  absReturnsPct,
  modelZ,
  normCdf,
  pct,
  priceAt,
  recentSigma1mPct,
  sigma1mPct,
  twap,
  type Kline,
  type Tick,
} from './model.ts';
import { bidOf, impliedUp, type Book } from './rules.ts';

/**
 * 判官的眼睛（移植自上游 `PredictionStateWriter`）：把这一刻能看到的事实写成英文短句，
 * 要比的数（价差、秒数、¢ 价、含费成本）由代码算好写进句子；数学估计只当一项事实写进 estimate，不写「便宜 / 贵」这类结论。
 *
 * - market：怎么赢、怎么买卖、多久问一次
 * - clock：早段 / 中段 / 最后一分钟锁了多少，离结算均价截止还有几秒
 * - btc：Chainlink 现价相对开盘均价、领先多少个「正常波动」、末分钟已锁定部分、路径、形状、最近一分钟、速度、数据新鲜度
 * - binance_flow：最近 60 秒主动买卖与大单、开盘以来强平方向
 * - odds：谁是热门、两边卖价买价与含费成本、最近 30 秒赔率怎么动
 * - estimate：随机游走估计与两边含费成本的差
 * - position：持仓才有
 */

const FLAT_RATIO = 0.3;
const AT_OPEN_RATIO = 0.05;
const JUMP_SPAN_MS = 10_000;
const JUMP_RATIO = 0.6;
const SWING_RATIO = 2.5;
const RECENT_VOL_SPAN_MS = 180_000;
const FLOW_MIN_TRADES = 10;
const ODDS_LOOKBACK_MS = 30_000;

export const GAME =
  "Polymarket 5-minute BTC market. UP pays 100¢ a share if BTC's average price over the final minute " +
  'is at or above its average at the open; otherwise DOWN pays 100¢. You buy at the ask; a bet can also be sold ' +
  'before the close at the bid. Every buy and every sell pays a fee. You hold at most one bet at a time and are asked ' +
  'again every 15 seconds.';

export const ESTIMATE_METHOD =
  "A zero-drift random-walk estimate of each side's chance of winning, using only BTC's gap to the " +
  'opening average, the seconds left and recent volatility, plus in the final minute the part of the settlement average already set; ' +
  "it ignores order flow, liquidations and the market's prices.";

export interface Position {
  side: Side;
  contracts: number;
  avgPrice: number;
}

export interface MarketContext {
  windowStart: number;
  nowMs: number;
  /** 开盘 60 秒 Chainlink 均价（目标价） */
  openPrice: number | null;
  /** Chainlink 现货 tick，至少覆盖 [min(开盘, now−3 分钟), now] */
  ticks: readonly Tick[];
  /** 近一小时 1m K 线，最后一根在走 */
  klines: readonly Kline[];
  /** Binance 最近 60 秒逐笔统计；拿不到或不新鲜为 null */
  flow: FlowMetrics | null;
  /** 开盘以来强平；没开强平流为 null */
  liquidations: readonly Liquidation[] | null;
  book: Book;
  /** 本回合 UP 中间价采样（赔率怎么动） */
  upMids: readonly Tick[];
  position: Position | null;
}

export interface Raw {
  /** 纯数学的 z，正 = 偏 UP */
  zModel: number;
  /** 纯数学的上涨概率 */
  pModel: number;
  sigma1m: number;
  chainlinkAgeMs: number;
  book: Book;
}

export interface Snapshot {
  state: Record<string, unknown>;
  raw: Raw;
}

export class StateUnavailableError extends Error {}

export function buildState(ctx: MarketContext): Snapshot {
  const { windowStart, nowMs: now, openPrice: open, book } = ctx;
  if (open == null || !(open > 0)) throw new StateUnavailableError(`开盘价未到 windowStart=${windowStart}`);
  const windowStartMs = windowStart * 1000;
  const settleEndMs = windowStartMs + (WINDOW_SECONDS - SETTLE_LAG_SECONDS) * 1000;
  const untilSettleEnd = (settleEndMs - now) / 1000;

  const ticks = ctx.ticks.filter((p) => p.timeMs <= now);
  const inWindow = ticks.filter((p) => p.timeMs >= windowStartMs);
  if (inWindow.length === 0) throw new StateUnavailableError(`本回合还没有 Chainlink tick windowStart=${windowStart}`);
  if (ctx.klines.length < 8) throw new StateUnavailableError('1m K 线不足');
  const last = inWindow[inWindow.length - 1]!;
  const chainlinkAgeMs = now - last.timeMs;

  const sigma1h = sigma1mPct(ctx.klines);
  // 刚起波的时候一小时典型值偏小，取大的那个，公平价才不会过于自信
  const sigmaEff = Math.max(sigma1h, recentSigma1mPct(ticks, now, RECENT_VOL_SPAN_MS));
  const twapStartMs = settleEndMs - TWAP_SECONDS * 1000;
  const twapSoFar = now > twapStartMs ? twap(inWindow, twapStartMs, now) : null;
  const z = modelZ(pct(open, last.price), twapSoFar == null ? null : pct(open, twapSoFar), sigmaEff, untilSettleEnd);
  const pModel = normCdf(z);
  const pMkt = impliedUp(book);

  const state: Record<string, unknown> = {
    market: GAME,
    clock: `${clockPhrase(untilSettleEnd)}; ${Math.round(untilSettleEnd)} seconds until the settlement average is fixed`,
  };

  const btc: Record<string, string> = {
    vs_open: gapPhrase(open, last.price, sigma1h),
    lead: leadPhrase(z),
  };
  if (twapSoFar != null) {
    btc.settlement_so_far = `the part of the settlement average already set is ${gapPhrase(open, twapSoFar, sigma1h)}`;
  }
  btc.since_open = sinceOpenSentence(inWindow, open, sigma1h, windowStartMs, now);
  const shape = shapeWord(inWindow, open, sigma1h);
  if (shape != null) btc.shape = shape;
  btc.last_minute = lastMinutePhrase(inWindow, now, sigma1h);
  btc.pace = speedSentence(ctx.klines, sigma1h);
  btc.latest = latestPhrase(chainlinkAgeMs, ctx.flow);
  state.btc = btc;

  const flow: Record<string, string> = {};
  if (ctx.flow != null && ctx.flow.tradeCount >= FLOW_MIN_TRADES) {
    flow.takers = takersPhrase(ctx.flow.tradeDelta);
    flow.large_trades = largeTradesPhrase(ctx.flow.largeTradeBias);
  }
  if (ctx.liquidations != null) {
    let longs = 0;
    let shorts = 0;
    for (const l of ctx.liquidations) {
      if (l.timeMs < windowStartMs) continue;
      if (l.side === 'SELL') longs += l.usdt;
      else shorts += l.usdt;
    }
    flow.liquidations = liquidationWord(longs, shorts);
  }
  state.binance_flow = flow;

  const odds: Record<string, string> = {
    standing: standingPhrase(pMkt),
    up: quotePhrase('UP', book.upAsk, book.upBid),
    down: quotePhrase('DOWN', book.downAsk, book.downBid),
  };
  const move = oddsMovePhrase(ctx.upMids, now);
  if (move != null) odds.odds_move = move;
  state.odds = odds;
  state.estimate = estimateSection(pModel, book);
  if (ctx.position != null) state.position = positionSection(ctx.position, pModel, book);

  return { state, raw: { zModel: z, pModel, sigma1m: sigmaEff, chainlinkAgeMs, book } };
}

// ==================== 词 ====================

export function clockPhrase(untilSettleEnd: number): string {
  if (untilSettleEnd > 180) return 'early: more than three minutes left';
  if (untilSettleEnd >= TWAP_SECONDS) return 'middle: one to three minutes left';
  const locked = (TWAP_SECONDS - untilSettleEnd) / TWAP_SECONDS;
  if (locked < 0.2) return 'final minute: little of the settlement average is set yet';
  if (locked < 0.4) return 'final minute: about a third of the settlement average is already set';
  if (locked < 0.7) return 'final minute: about half of the settlement average is already set';
  return 'final minute: most of the settlement average is already set';
}

export function gapPhrase(open: number, price: number, sigma1m: number): string {
  const gap = pct(open, price);
  if (Math.abs(gap) < AT_OPEN_RATIO * sigma1m) return 'at the opening average';
  return `${gap > 0 ? 'above' : 'below'} the opening average by ${usd(Math.abs(price - open))} (${Math.abs(gap).toFixed(3)}%)`;
}

export function leadPhrase(z: number): string {
  const r = Math.abs(z);
  if (r < 0.5) return 'neither side clearly ahead: the gap is well inside normal noise for the time left';
  const side = z > 0 ? 'UP' : 'DOWN';
  if (r < 1.5) return `${side} ahead by about one normal move for the time left`;
  if (r < 3) return `${side} ahead by a couple of normal moves for the time left`;
  return `${side} ahead by several normal moves for the time left`;
}

export function direction(changePct: number, sigma1m: number): number {
  if (Math.abs(changePct) < FLAT_RATIO * sigma1m) return 0;
  return changePct > 0 ? 1 : -1;
}

export function sinceOpenSentence(inWindow: readonly Tick[], open: number, sigma1m: number, windowStartMs: number, now: number): string {
  const midPrice = priceAt(inWindow, (windowStartMs + now) / 2);
  const last = inWindow[inWindow.length - 1]!.price;
  const a = direction(pct(open, midPrice), sigma1m);
  const b = direction(pct(midPrice, last), sigma1m);
  const aboveOpen = last >= open;
  if (a > 0 && b > 0) return 'rose steadily since the open';
  if (a > 0 && b === 0) return 'rose early, flat since';
  if (a > 0) return aboveOpen ? 'rose early, then gave back part of it' : 'rose early, then reversed below the open';
  if (a < 0 && b < 0) return 'fell steadily since the open';
  if (a < 0 && b === 0) return 'fell early, flat since';
  if (a < 0) return aboveOpen ? 'fell early, then reversed above the open' : 'fell early, then recovered part of it';
  if (b > 0) return 'flat early, rising lately';
  if (b < 0) return 'flat early, falling lately';
  return 'flat since the open';
}

export function biggestMovePct(pts: readonly Tick[], spanMs: number): number {
  let best = 0;
  let i = 0;
  for (let j = 0; j < pts.length; j++) {
    const from = pts[j]!.timeMs - spanMs;
    while (i < j && pts[i + 1]!.timeMs <= from) i++;
    best = Math.max(best, Math.abs(pct(pts[i]!.price, pts[j]!.price)));
  }
  return best;
}

export function shapeWord(inWindow: readonly Tick[], open: number, sigma1m: number): string | null {
  let hi = open;
  let lo = open;
  for (const p of inWindow) {
    if (p.price > hi) hi = p.price;
    if (p.price < lo) lo = p.price;
  }
  const rangePct = pct(lo, hi);
  const netPct = Math.abs(pct(open, inWindow[inWindow.length - 1]!.price));
  if (rangePct >= sigma1m && rangePct >= SWING_RATIO * netPct) return 'back and forth';
  if (netPct < FLAT_RATIO * sigma1m) return null;
  return biggestMovePct(inWindow, JUMP_SPAN_MS) >= JUMP_RATIO * netPct ? 'one jump' : 'in steps';
}

export function lastMinutePhrase(inWindow: readonly Tick[], now: number, sigma1m: number): string {
  const from = priceAt(inWindow, now - 60_000);
  const last = inWindow[inWindow.length - 1]!.price;
  const d = direction(pct(from, last), sigma1m);
  return `${d > 0 ? 'rising' : d < 0 ? 'falling' : 'flat'} (${signedUsd(last - from)})`;
}

export function speedSentence(bars: readonly Kline[], sigma1m: number): string {
  const rets = absReturnsPct(bars);
  const recent = rets.slice(-5);
  if (recent.length === 0 || !(sigma1m > 0)) return 'about as active as usual';
  const r = recent.reduce((a, b) => a + b, 0) / recent.length / sigma1m;
  if (r < 0.5) return 'unusually quiet';
  if (r < 2) return 'about as active as usual';
  return 'unusually fast';
}

function latestPhrase(chainlinkAgeMs: number, flow: FlowMetrics | null): string {
  const chainlink = `Chainlink, which settles the market, last updated ${Math.round(chainlinkAgeMs / 1000)} seconds ago`;
  if (flow?.move10 == null || flow.move30 == null) return chainlink;
  return `${chainlink}; on Binance BTC moved ${signedUsd(flow.move10)} in the last 10 seconds and ${signedUsd(flow.move30)} in the last 30 seconds`;
}

export function takersPhrase(tradeDelta: number): string {
  const share = ` (taker buys ${Math.round(((1 + tradeDelta) / 2) * 100)}% of volume)`;
  if (tradeDelta >= 0.2) return `buyers ahead in the last minute${share}`;
  if (tradeDelta <= -0.2) return `sellers ahead in the last minute${share}`;
  return `balanced in the last minute${share}`;
}

export function largeTradesPhrase(bias: number): string {
  if (bias >= 0.3) return 'mostly buys in the last minute';
  if (bias <= -0.3) return 'mostly sells in the last minute';
  return 'mixed or none in the last minute';
}

export function liquidationWord(longs: number, shorts: number): string {
  const total = longs + shorts;
  if (total < 1) return 'none since the open';
  if (longs / total >= 0.7) return 'longs liquidated since the open';
  if (shorts / total >= 0.7) return 'shorts liquidated since the open';
  return 'both sides liquidated since the open';
}

export function standingPhrase(pMkt: number | null): string {
  if (pMkt == null) return 'no quotes on one side right now';
  const side = pMkt >= 0.5 ? 'UP' : 'DOWN';
  const q = Math.max(pMkt, 1 - pMkt);
  let word: string;
  if (q >= 0.93) word = `${side} is a near-certain favourite`;
  else if (q >= 0.8) word = `${side} is a strong favourite`;
  else if (q >= 0.65) word = `${side} is a clear favourite`;
  else if (q >= 0.55) word = `${side} is a slight favourite`;
  else word = 'neither side is favoured';
  return `${word}; the market prices UP at about ${Math.round(pMkt * 100)}%`;
}

export function quotePhrase(side: Side, ask: number | null, bid: number | null): string {
  const bidText = bid == null ? 'no bid' : `bid ${cents(bid)}`;
  if (ask == null) return `nobody is selling ${side} right now; ${bidText}`;
  const cost = ask + perShareFee(ask);
  return `ask ${cents(ask)}, ${bidText}; buying costs ${(cost * 100).toFixed(1)}¢ a share with the fee and pays 100¢ if ${side} wins`;
}

export function oddsMovePhrase(upMids: readonly Tick[], now: number): string | null {
  if (upMids.length === 0 || upMids[0]!.timeMs > now - ODDS_LOOKBACK_MS + 5_000) return null;
  const then = priceAt(upMids, now - ODDS_LOOKBACK_MS);
  const d = upMids[upMids.length - 1]!.price - then;
  let word: string;
  if (d >= 0.08) word = "UP's price rose sharply over the last 30 seconds";
  else if (d >= 0.03) word = "UP's price rose a little over the last 30 seconds";
  else if (d <= -0.08) word = "UP's price fell sharply over the last 30 seconds";
  else if (d <= -0.03) word = "UP's price fell a little over the last 30 seconds";
  else word = 'prices barely moved over the last 30 seconds';
  const c = Math.round(d * 100);
  return `${word} (${c >= 0 ? '+' : ''}${c}¢)`;
}

interface Chance {
  pct: string;
  worth: string;
  value: number;
  rounded: boolean;
}

export function chance(pModel: number, side: Side): Chance {
  const up = side === 'UP';
  const value = (up ? pModel : 1 - pModel) * 100;
  if (pModel >= 0.995 || pModel <= 0.005) {
    return (pModel >= 0.995) === up
      ? { pct: 'more than 99%', worth: 'more than 99¢', value, rounded: false }
      : { pct: 'less than 1%', worth: 'less than 1¢', value, rounded: false };
  }
  const upPct = Math.round(pModel * 100);
  const n = up ? upPct : 100 - upPct;
  return { pct: `${n}%`, worth: `${n}¢`, value: n, rounded: true };
}

function estimateSection(pModel: number, book: Book): Record<string, string> {
  return {
    method: ESTIMATE_METHOD,
    up: estimateLine('UP', chance(pModel, 'UP'), book.upAsk),
    down: estimateLine('DOWN', chance(pModel, 'DOWN'), book.downAsk),
  };
}

function estimateLine(side: Side, c: Chance, ask: number | null): string {
  const head = `${side}: estimated chance of winning ${c.pct}, worth ${c.worth} a share; `;
  if (ask == null) return `${head}nobody is selling ${side} right now`;
  const cost = (ask + perShareFee(ask)) * 100;
  return `${head}buying ${side} costs ${cost.toFixed(1)}¢ with the fee, ${diffPhrase(cost, c.value, 'that')}`;
}

function positionSection(pos: Position, pModel: number, book: Book): Record<string, string> {
  const out: Record<string, string> = {
    held: `holding ${pos.contracts.toFixed(1)} ${pos.side} shares bought at an average of ${cents(pos.avgPrice)}`,
  };
  const bid = bidOf(book, pos.side);
  if (bid == null) {
    out.sell_now = `nobody is bidding for ${pos.side} right now`;
    return out;
  }
  const net = (bid - perShareFee(bid)) * 100;
  out.sell_now = `the bid is ${cents(bid)}; selling now returns ${net.toFixed(1)}¢ a share after the fee`;
  const c = chance(pModel, pos.side);
  out.vs_estimate =
    `the estimate gives ${pos.side} a ${c.pct} chance of winning; selling now returns ` +
    diffPhrase(net, c.value, c.rounded ? `${c.worth} a share` : 'its estimated worth');
  return out;
}

export function diffPhrase(a: number, b: number, than: string): string {
  const d = a - b;
  if (Math.abs(d) < 0.05) return `the same as ${than}`;
  return `${Math.abs(d).toFixed(1)}¢ ${d > 0 ? 'more' : 'less'} than ${than}`;
}

export function cents(price: number): string {
  return `${Number((price * 100).toFixed(4))}¢`;
}

function usd(amount: number): string {
  return `$${Math.round(amount)}`;
}

export function signedUsd(amount: number): string {
  const n = Math.round(amount);
  return `${n < 0 ? '-$' : '+$'}${Math.abs(n)}`;
}
