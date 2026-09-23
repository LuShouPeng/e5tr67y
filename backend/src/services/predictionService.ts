import type { DatabaseSync } from 'node:sqlite';

import { DomainError } from '../domain/errors.ts';
import { isRoundSellable, isRoundTradable } from '../domain/lifecycle.ts';
import { roundTo } from '../domain/money.ts';
import { assertAmount, assertSide, planBuy, planSell, type BuyPlan } from '../domain/order.ts';
import { isQuoteFresh, normalizeAsk, normalizeBid, quoteFor } from '../domain/pricing.ts';
import type { BetStatus, PredictionBet, RoundOutcome, RoundStatus, Side } from '../domain/types.ts';
import { remainingSeconds, windowStartFor } from '../domain/window.ts';
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

export interface PredictionServiceDeps {
  db: DatabaseSync;
  rounds: RoundRepo;
  bets: BetRepo;
  accounts: AccountRepo;
  quotes: QuoteStore;
  clock: Clock;
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
      rounds.insertIfAbsent(ws, startPrice);
      const round = rounds.findByWindowStart(ws);
      if (round == null) throw new Error(`回合创建失败：windowStart=${ws}`);
      return toRoundView(round);
    },

    currentRound,

    roundOf(windowStart) {
      const round = rounds.findByWindowStart(windowStart);
      return round == null ? null : toRoundView(round);
    },

    lockRound(windowStart) {
      return rounds.casLock(windowStart) > 0;
    },

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
      return withTx(db, () => {
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

    toBetView,
  };
}
