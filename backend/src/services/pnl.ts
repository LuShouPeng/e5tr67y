import { roundTo } from '../domain/money.ts';
import type { PredictionBet, Side } from '../domain/types.ts';

export interface PnlStats {
  totalBets: number;
  activeBets: number;
  wonBets: number;
  lostBets: number;
  soldBets: number;
  /** 作废退本金的笔数（盈亏记 0） */
  voidBets: number;
  /** 已了结笔数 = 赢 + 输 + 已卖 + 作废 */
  settledBets: number;
  /** 胜率（百分数，2 位小数）：赢的笔数 ÷ 已了结笔数 */
  winRate: number;
  /** 累计投入成本 */
  totalCost: number;
  /** 已实现盈亏：结算与卖出所得 − 成本 */
  realizedPnl: number;
  /** 持仓成本 */
  activeCost: number;
  /** 持仓现值（本回合按买一价估值，其余按成本挂账） */
  activeValue: number;
  unrealizedPnl: number;
  totalPnl: number;
}

/**
 * 单笔持仓的可变现价值。
 *
 * 只有**当前窗口**的注单才按买一价重估：其余回合的卖价早已取不到，
 * 按成本挂账比按某个陈年价签字更诚实。同窗口但无买一价时记 0——
 * 意思是「此刻卖不掉」，而不是「值原价」。
 */
export function betValue(
  bet: PredictionBet,
  bid: number | null,
  currentWindowStart: number,
): number {
  if (bet.windowStart !== currentWindowStart) return bet.cost;
  return bid == null ? 0 : roundTo(bet.contracts * bid);
}

export function computePnl(
  bets: readonly PredictionBet[],
  bidOf: (side: Side) => number | null,
  currentWindowStart: number,
): PnlStats {
  let activeBets = 0;
  let wonBets = 0;
  let lostBets = 0;
  let soldBets = 0;
  let voidBets = 0;
  let totalCost = 0;
  let realizedPnl = 0;
  let activeCost = 0;
  let activeValue = 0;

  for (const bet of bets) {
    totalCost = roundTo(totalCost + bet.cost);

    switch (bet.status) {
      case 'WON':
      case 'LOST':
      case 'SOLD': {
        if (bet.status === 'WON') wonBets++;
        else if (bet.status === 'LOST') lostBets++;
        else soldBets++;
        // 输单 payout 为 0，卖出 payout 为到手金额，赢单 payout 为份数
        realizedPnl = roundTo(realizedPnl + (bet.payout ?? 0) - bet.cost);
        break;
      }
      case 'DRAW': {
        // 作废退款：payout == cost，盈亏记 0，但计入已了结
        voidBets++;
        break;
      }
      case 'ACTIVE': {
        activeBets++;
        activeCost = roundTo(activeCost + bet.cost);
        activeValue = roundTo(activeValue + betValue(bet, bidOf(bet.side), currentWindowStart));
        break;
      }
    }
  }

  const settledBets = wonBets + lostBets + soldBets + voidBets;
  const unrealizedPnl = roundTo(activeValue - activeCost);
  return {
    totalBets: bets.length,
    activeBets,
    wonBets,
    lostBets,
    soldBets,
    voidBets,
    settledBets,
    winRate: settledBets === 0 ? 0 : roundTo((wonBets / settledBets) * 100, 2),
    totalCost,
    realizedPnl,
    activeCost,
    activeValue,
    unrealizedPnl,
    totalPnl: roundTo(realizedPnl + unrealizedPnl),
  };
}
