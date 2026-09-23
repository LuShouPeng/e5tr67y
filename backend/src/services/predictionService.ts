import type { DatabaseSync } from 'node:sqlite';

import { DomainError } from '../domain/errors.ts';
import { isRoundSellable, isRoundTradable } from '../domain/lifecycle.ts';
import { roundTo } from '../domain/money.ts';
import { assertAmount, assertSide, planBuy, planSell, type BuyPlan } from '../domain/order.ts';
import { isQuoteFresh, normalizeAsk, normalizeBid, opposite, quoteFor } from '../domain/pricing.ts';
import { isVoidDue, resolveOutcome } from '../domain/settlement.ts';
import { computePnl, type PnlStats } from './pnl.ts';
import type { EventBus } from './eventBus.ts';
import type {
  BetStatus,
  PredictionBet,
  PredictionRound,
  RoundOutcome,
  RoundStatus,
  Side,
} from '../domain/types.ts';
import { previousWindowStart, remainingSeconds, windowStartFor } from '../domain/window.ts';
import { withTx } from '../infra/db.ts';
import type { AccountRepo } from '../infra/repos/accountRepo.ts';
import type { BetRepo } from '../infra/repos/betRepo.ts';
import type { RoundRepo } from '../infra/repos/roundRepo.ts';
import type { QuoteStore } from '../market/quoteStore.ts';
import type { Clock } from './clock.ts';

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
  /** 此刻按买一价卖掉能拿多少；只有本回合的 ACTIVE 注单有值 */
  currentValue: number | null;
}

export interface RoundView {
  id: number;
  windowStart: number;
  startPrice: number | null;
  endPrice: number | null;
  outcome: RoundOutcome | null;
  status: RoundStatus;
  /** 本回合剩余秒数 */
  remainingSeconds: number;
  serverTimeMs: number;
}

export interface SettlePrices {
  startPrice?: number | null;
  endPrice?: number | null;
}

/** 盈亏统计 + 账户视角：`equity` = 游戏钱包余额 + 持仓现值 */
export type PnlView = PnlStats & { gameBalance: number; equity: number };

export interface PageView<T> {
  rows: T[];
  total: number;
  pageNum: number;
  pageSize: number;
}

/** 全站成交流的一条：用户名打码，金额只亮成本 */
export interface LiveBetView {
  username: string;
  side: Side;
  amount: number;
  ts: number;
  createdAt: string;
}

export type SettleResult =
  | { status: 'SETTLED'; round: RoundView; outcome: Side; winners: number; paidOut: number }
  | { status: 'VOIDED'; round: RoundView; refunded: number; bets: number }
  | {
      status: 'SKIPPED';
      reason: 'NOT_FOUND' | 'NOT_LOCKED' | 'ALREADY_SETTLED' | 'WAITING_FOR_PRICE';
    };

export interface PredictionServiceDeps {
  db: DatabaseSync;
  rounds: RoundRepo;
  bets: BetRepo;
  accounts: AccountRepo;
  quotes: QuoteStore;
  clock: Clock;
  /** 可选：有订阅者时推送回合/成交流事件 */
  events?: EventBus;
}

export interface PredictionService {
  ensureAccount(userId: number, username?: string): void;
  gameBalanceOf(userId: number): number;
  ensureRound(startPrice?: number | null): RoundView;
  currentRound(): RoundView;
  roundOf(windowStart: number): RoundView | null;
  lockRound(windowStart: number): boolean;
  buy(userId: number, side: unknown, amount: unknown): BetView;
  /** 卖出注单：`contracts` 省略即整单卖出，给部分份数则拆出一笔 SOLD 记录 */
  sell(userId: number, betId: number, contracts?: number | null): BetView;
  /** 买入试算，供前端下注面板预览（不落库、不扣款） */
  previewBuy(side: Side, amount: number): BuyPlan;
  /** 定盘：`LOCKED` 回合取开收盘价判涨跌、批量派彩；缺价则按等待策略作废退本金 */
  settleRound(windowStart: number, prices?: SettlePrices): SettleResult;
  /** 补结算巡检：捞出窗口早该结束却还停在 OPEN / LOCKED 的回合，补锁并重跑结算 */
  sweepStuckRounds(priceLookup?: (windowStart: number) => SettlePrices | null): SettleResult[];
  /** 预测盈亏统计（含账户余额与总权益） */
  pnl(userId: number): PnlView;
  /** 我的下注历史（分页） */
  listBets(userId: number, pageNum?: number, pageSize?: number): PageView<BetView>;
  /** 往期已结算回合（分页） */
  listSettledRounds(pageNum?: number, pageSize?: number): PageView<RoundView>;
  /** 全站最近成交，供实时成交流 */
  recentActivity(limit?: number): LiveBetView[];
  toBetView(bet: PredictionBet): BetView;
}

/**
 * 部分卖出时按比例拆出成本，4 位小数 HALF_UP。
 * 整单卖出直接沿用原成本，避免 `cost × n / n` 的舍入漂移。
 */
function soldCostOf(bet: PredictionBet, contracts: number): number {
  if (contracts === bet.contracts) return bet.cost;
  return roundTo((bet.cost * contracts) / bet.contracts);
}

export function createPredictionService(deps: PredictionServiceDeps): PredictionService {
  const { db, rounds, bets, accounts, quotes, clock } = deps;
  const events = deps.events;

  /** 用户名打码：成交流是全站可见的，没必要把完整用户名摊出去 */
  function maskUsername(username: string): string {
    return username.length <= 2 ? username : `${username.slice(0, 2)}***`;
  }

  function publishRound(view: RoundView): void {
    events?.publish('round', view);
  }

  function toBetView(bet: PredictionBet): BetView {
    const book = quotes.get();
    const bid = normalizeBid(quoteFor(book, bet.side)?.bid ?? null);
    const inCurrentWindow = bet.windowStart === windowStartFor(clock.now());
    return {
      id: bet.id,
      roundId: bet.roundId,
      windowStart: bet.windowStart,
      side: bet.side,
      contracts: bet.contracts,
      cost: bet.cost,
      avgPrice: bet.avgPrice,
      payout: bet.payout,
      status: bet.status,
      createdAt: bet.createdAt,
      currentValue:
        bet.status === 'ACTIVE' && inCurrentWindow && bid != null ? roundTo(bet.contracts * bid) : null,
    };
  }

  function toRoundView(round: {
    id: number;
    windowStart: number;
    startPrice: number | null;
    endPrice: number | null;
    outcome: RoundOutcome | null;
    status: RoundStatus;
  }): RoundView {
    const now = clock.now();
    return {
      id: round.id,
      windowStart: round.windowStart,
      startPrice: round.startPrice,
      endPrice: round.endPrice,
      outcome: round.outcome,
      status: round.status,
      remainingSeconds: remainingSeconds(now),
      serverTimeMs: now,
    };
  }

  function currentRound(): RoundView {
    const now = clock.now();
    const ws = windowStartFor(now);
    let round = rounds.findByWindowStart(ws);
    if (round == null) {
      rounds.insertIfAbsent(ws, null);
      round = rounds.findByWindowStart(ws);
    }
    if (round == null) throw new Error(`回合创建失败：windowStart=${ws}`);
    return toRoundView(round);
  }

  /** 封盘：CAS 带 status='OPEN'，重复调用无害 */
  function lockRound(windowStart: number): boolean {
    const locked = rounds.casLock(windowStart) > 0;
    if (locked) {
      const round = rounds.findByWindowStart(windowStart);
      if (round != null) publishRound(toRoundView(round));
    }
    return locked;
  }

  function requireUsableAsk(side: Side, nowMs: number): number {
    const book = quotes.get();
    if (book == null || !isQuoteFresh(book, nowMs)) {
      throw new DomainError('PRICE_UNAVAILABLE', '盘口尚未就绪或已超龄');
    }
    const ask = normalizeAsk(quoteFor(book, side)?.ask ?? null);
    if (ask == null) {
      throw new DomainError('PRICE_UNAVAILABLE', `${side} 方向暂无卖单`);
    }
    return ask;
  }

  return {
    ensureAccount(userId, username = '') {
      accounts.ensure(userId, username);
    },

    gameBalanceOf(userId) {
      return accounts.gameBalanceOf(userId);
    },

    ensureRound(startPrice = null) {
      const ws = windowStartFor(clock.now());
      let round = rounds.findByWindowStart(ws);
      if (round != null) return toRoundView(round);

      rounds.insertIfAbsent(ws, startPrice);
      round = rounds.findByWindowStart(ws);
      if (round == null) throw new Error(`回合创建失败：windowStart=${ws}`);
      const view = toRoundView(round);
      // 只在真的新建回合时广播，否则每秒一次的巡检会把推送刷成噪声
      publishRound(view);
      return view;
    },

    currentRound,

    roundOf(windowStart) {
      const round = rounds.findByWindowStart(windowStart);
      return round == null ? null : toRoundView(round);
    },

    lockRound,

    previewBuy(side, amount) {
      assertSide(side);
      assertAmount(amount);
      return planBuy(amount, requireUsableAsk(side, clock.now()));
    },

    buy(userId, side, amount) {
      assertSide(side);
      assertAmount(amount);

      const now = clock.now();
      const round = rounds.findByWindowStart(windowStartFor(now));
      if (round == null) {
        throw new DomainError('ROUND_NOT_FOUND', '当前回合尚未开盘');
      }
      if (!isRoundTradable(round, now)) {
        throw new DomainError('ROUND_LOCKED', '回合已封盘，等待结算');
      }

      const plan = planBuy(amount, requireUsableAsk(side, now));

      // 扣款与落单必须同事务：只扣钱不落单，用户就凭空少了一笔钱
      const view = withTx(db, () => {
        accounts.ensure(userId);
        if (accounts.addGameBalance(userId, -plan.total) === 0) {
          throw new DomainError(
            'INSUFFICIENT_BALANCE',
            `游戏钱包余额不足，本次需要 ${plan.total}（成本 ${plan.cost} + 手续费 ${plan.fee}）`,
          );
        }
        const bet = bets.insert({
          userId,
          roundId: round.id,
          windowStart: round.windowStart,
          side,
          contracts: plan.contracts,
          cost: plan.cost,
          avgPrice: plan.price,
        });
        return toBetView(bet);
      });

      // 推送刻意留在事务外：发出去就撤不回，事务回滚了推送还在就是假消息
      events?.publish('activity', {
        username: maskUsername(accounts.find(userId)?.username ?? '匿名'),
        side,
        amount: view.cost,
        ts: clock.now(),
        createdAt: view.createdAt,
      });
      return view;
    },

    sell(userId, betId, contracts = null) {
      const bet = bets.findById(betId);
      if (bet == null || bet.userId !== userId) {
        throw new DomainError('BET_NOT_FOUND', `注单不存在：${betId}`);
      }
      if (bet.status !== 'ACTIVE') {
        throw new DomainError('BET_NOT_ACTIVE', `注单已 ${bet.status}，不能卖出`);
      }

      const now = clock.now();
      const round = rounds.findById(bet.roundId);
      // 卖价取的是「当前」盘口，所以只卖得掉当前窗口这一回合：卡在 OPEN 的旧回合结果早已定死，
      // 放行就等于照今天的价卖已知结果
      if (round == null || !isRoundSellable(round, now)) {
        throw new DomainError('ROUND_LOCKED', '只有当前未封盘回合的注单可以卖出');
      }

      const book = quotes.get();
      if (book == null || !isQuoteFresh(book, now)) {
        throw new DomainError('PRICE_UNAVAILABLE', '盘口尚未就绪或已超龄');
      }
      const bid = normalizeBid(quoteFor(book, bet.side)?.bid ?? null);
      if (bid == null) {
        throw new DomainError('PRICE_UNAVAILABLE', `${bet.side} 方向暂无买单`);
      }

      const wanted = contracts == null ? bet.contracts : roundTo(contracts);
      if (!Number.isFinite(wanted) || wanted <= 0 || wanted > bet.contracts) {
        throw new DomainError(
          'CONTRACTS_INVALID',
          `卖出份数需在 (0, ${bet.contracts}] 内，收到：${contracts}`,
        );
      }

      const plan = planSell(wanted, bid);
      const fullSell = wanted === bet.contracts;

      // 扣注单与回款必须同事务：只改状态不回款 = 用户白卖
      return withTx(db, () => {
        if (fullSell) {
          if (bets.casSellFull(bet.id, plan.net) === 0) {
            throw new DomainError('BET_NOT_ACTIVE', '注单状态已变化，请刷新后重试');
          }
        } else {
          if (bets.casPartialSell(bet.id, wanted, soldCostOf(bet, wanted)) === 0) {
            throw new DomainError('BET_NOT_ACTIVE', '注单状态已变化，请刷新后重试');
          }
        }

        if (accounts.addGameBalance(userId, plan.net) === 0) {
          throw new Error(`卖出回款失败：账户不存在 user=${userId}`);
        }

        if (fullSell) {
          const sold = bets.findById(bet.id);
          if (sold == null) throw new Error(`卖出后注单丢失：id=${bet.id}`);
          return toBetView(sold);
        }

        // 部分卖出：拆一笔 SOLD 记录留痕，原单继续持有剩余份数
        const soldCost = soldCostOf(bet, wanted);
        return toBetView(
          bets.insertSold({
            userId,
            roundId: bet.roundId,
            windowStart: bet.windowStart,
            side: bet.side,
            contracts: wanted,
            cost: soldCost,
            avgPrice: roundTo(soldCost / wanted),
            payout: plan.net,
          }),
        );
      });
    },

    settleRound,

    sweepStuckRounds(priceLookup) {
      const results: SettleResult[] = [];
      // 阈值取上一窗口起点：上一个回合此刻正被正常结算、合法地停在 LOCKED，必须排除
      const staleBefore = previousWindowStart(clock.now());
      for (const round of rounds.listUnsettledBefore(staleBefore)) {
        // 只认 LOCKED 的定盘先把 OPEN 补一次锁；CAS 带 status='OPEN'，重复跑无害
        if (round.status === 'OPEN') lockRound(round.windowStart);
        results.push(settleRound(round.windowStart, priceLookup?.(round.windowStart) ?? {}));
      }
      return results;
    },

    pnl(userId) {
      const book = quotes.get();
      const stats = computePnl(
        bets.listAllByUser(userId),
        (side) => normalizeBid(quoteFor(book, side)?.bid ?? null),
        windowStartFor(clock.now()),
      );
      const gameBalance = accounts.gameBalanceOf(userId);
      return { ...stats, gameBalance, equity: roundTo(gameBalance + stats.activeValue) };
    },

    listBets(userId, pageNum = 1, pageSize = 10) {
      const { rows, total } = bets.listByUser(userId, pageSize, (pageNum - 1) * pageSize);
      return { rows: rows.map(toBetView), total, pageNum, pageSize };
    },

    listSettledRounds(pageNum = 1, pageSize = 10) {
      const { rows, total } = rounds.listSettled(pageSize, (pageNum - 1) * pageSize);
      return { rows: rows.map(toRoundView), total, pageNum, pageSize };
    },

    recentActivity(limit = 20) {
      return bets.listRecent(limit).map((bet) => {
        const username = accounts.find(bet.userId)?.username ?? '匿名';
        return {
          username: maskUsername(username),
          side: bet.side,
          amount: bet.cost,
          ts: Date.parse(`${bet.createdAt.replace(' ', 'T')}Z`) || clock.now(),
          createdAt: bet.createdAt,
        };
      });
    },

    toBetView,
  };

  /** 定盘入口：只在回合已封盘时生效，取不到价则走作废分支 */
  function settleRound(windowStart: number, prices: SettlePrices = {}): SettleResult {
    const result = settleOnce(windowStart, prices);
    // 定盘/作废都要广播：前端据此刷新注单与余额
    if (result.status === 'SETTLED' || result.status === 'VOIDED') publishRound(result.round);
    return result;
  }

  function settleOnce(windowStart: number, prices: SettlePrices): SettleResult {
    const round = rounds.findByWindowStart(windowStart);
    if (round == null) return { status: 'SKIPPED', reason: 'NOT_FOUND' };
    if (round.status === 'SETTLED') return { status: 'SKIPPED', reason: 'ALREADY_SETTLED' };
    if (round.status !== 'LOCKED') return { status: 'SKIPPED', reason: 'NOT_LOCKED' };

    const startPrice = prices.startPrice ?? round.startPrice ?? null;
    const endPrice = prices.endPrice ?? null;

    if (startPrice == null || endPrice == null) {
      return maybeVoid(round);
    }
    return settleWithPrice(round.id, startPrice, endPrice);
  }

  /** 缺价分支：等够了就作废退本金，没等够就下次巡检再说 */
  function maybeVoid(round: PredictionRound): SettleResult {
    const activeBetCount = bets.countActiveByRound(round.id);
    const ageSeconds = (clock.now() - round.windowStart * 1000) / 1000;
    if (!isVoidDue(ageSeconds, activeBetCount)) {
      return { status: 'SKIPPED', reason: 'WAITING_FOR_PRICE' };
    }

    return withTx(db, () => {
      // CAS 带 status='LOCKED'：重复跑不会二次退款
      if (rounds.casVoid(round.id) === 0) {
        return { status: 'SKIPPED', reason: 'ALREADY_SETTLED' } as const;
      }
      bets.settleDraw(round.id);
      const refunds = bets.listByRoundAndStatus(round.id, 'DRAW');
      let refunded = 0;
      for (const bet of refunds) {
        if (accounts.addGameBalance(bet.userId, bet.cost) === 0) {
          throw new Error(`退款失败：账户不存在 user=${bet.userId}`);
        }
        refunded = roundTo(refunded + bet.cost);
      }
      const updated = rounds.findById(round.id);
      if (updated == null) throw new Error(`作废后回合丢失：id=${round.id}`);
      return { status: 'VOIDED', round: toRoundView(updated), refunded, bets: refunds.length };
    });
  }

  /**
   * 定盘 + 派彩，整回合一个事务。
   * 这里不是「一批互相独立的任务」，而是一件事：回合定盘、全部注单改状态、全部派彩。
   * 拆开提交的话，状态先落地而派彩失败 = 有人标了 WON 却没拿到钱，而回合已经 SETTLED，
   * 这笔钱就静默丢了。所以批次必须同生共死，失败整批回滚留给下一次巡检；
   * `casSettle` 的 `WHERE status='LOCKED'` 就是重跑的幂等边界。
   */
  function settleWithPrice(roundId: number, startPrice: number, endPrice: number): SettleResult {
    const outcome = resolveOutcome(startPrice, endPrice);

    return withTx(db, () => {
      // 锁定后 updateStartPrice(WHERE status='OPEN') 已经够不着这行，另走一条只认空值的 CAS
      rounds.fillStartPrice(roundId, startPrice);

      if (rounds.casSettle(roundId, endPrice, outcome) === 0) {
        return { status: 'SKIPPED', reason: 'ALREADY_SETTLED' } as const;
      }

      bets.settleWon(roundId, outcome);
      bets.settleLost(roundId, opposite(outcome));
      const winners = bets.listByRoundAndStatus(roundId, 'WON');
      let paidOut = 0;
      for (const winner of winners) {
        // 每份合约兑付 $1，所以派彩额就是份数
        if (accounts.addGameBalance(winner.userId, winner.contracts) === 0) {
          throw new Error(`派彩失败：账户不存在 user=${winner.userId}`);
        }
        paidOut = roundTo(paidOut + winner.contracts);
      }

      const updated = rounds.findById(roundId);
      if (updated == null) throw new Error(`结算后回合丢失：id=${roundId}`);
      return { status: 'SETTLED', round: toRoundView(updated), outcome, winners: winners.length, paidOut };
    });
  }
}
