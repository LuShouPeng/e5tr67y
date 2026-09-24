import { takerFee } from '../domain/fee.ts';
import { roundTo } from '../domain/money.ts';
import { quoteFor } from '../domain/pricing.ts';
import type { QuoteStore } from '../market/quoteStore.ts';
import type { BetView, PredictionService } from '../services/predictionService.ts';
import { OrderRejectedError, type Broker, type BrokerPosition, type Fill } from './broker.ts';

/**
 * 模拟盘通道：直接走本仓库的虚拟资金预测游戏，用一个专属机器人账户下注。
 * 余额、注单、结算全在原有的 `account` / `prediction_bet` 表里，和真人玩家同一套规则，
 * 所以模拟盘成绩与页面上看到的盈亏口径完全一致。
 */

export const DEFAULT_BOT_USER_ID = 900_001;
const TERMINAL = new Set(['WON', 'LOST', 'SOLD', 'DRAW']);

export interface PaperBrokerOptions {
  service: PredictionService;
  quotes: QuoteStore;
  userId?: number;
  username?: string;
}

function toPosition(bet: BetView): BrokerPosition {
  return {
    id: String(bet.id),
    windowStart: bet.windowStart,
    side: bet.side,
    contracts: bet.contracts,
    avgPrice: bet.avgPrice,
    cost: bet.cost,
  };
}

export function createPaperBroker(options: PaperBrokerOptions): Broker {
  const { service, quotes } = options;
  const userId = options.userId ?? DEFAULT_BOT_USER_ID;
  service.ensureAccount(userId, options.username ?? 'bot');

  function recent(): BetView[] {
    return service.listBets(userId, 1, 50).rows;
  }

  return {
    kind: 'paper',
    async balance() {
      return service.gameBalanceOf(userId);
    },
    async position(windowStart) {
      const bet = recent().find((b) => b.windowStart === windowStart && b.status === 'ACTIVE');
      return bet ? toPosition(bet) : null;
    },
    async hasUnsettled() {
      return recent().some((b) => b.status === 'ACTIVE');
    },
    async buy(req): Promise<Fill> {
      const ask = quoteFor(quotes.get(), req.side)?.ask ?? null;
      if (ask == null || ask > req.maxPrice) {
        throw new OrderRejectedError('MISSED', `${req.side} 卖一 ${ask ?? 'none'} 高于限价 ${req.maxPrice}`);
      }
      const bet = service.buy(userId, req.side, roundTo(req.stake, 2));
      return { id: String(bet.id), side: bet.side, contracts: bet.contracts, avgPrice: bet.avgPrice, amount: bet.cost };
    },
    async sell(req): Promise<Fill> {
      const bid = quoteFor(quotes.get(), req.position.side)?.bid ?? null;
      if (bid == null || bid < req.minPrice) {
        throw new OrderRejectedError('MISSED', `${req.position.side} 买一 ${bid ?? 'none'} 低于限价 ${req.minPrice}`);
      }
      const bet = service.sell(userId, Number(req.position.id), null);
      return {
        id: String(bet.id),
        side: bet.side,
        contracts: bet.contracts,
        avgPrice: bid,
        amount: bet.payout ?? roundTo(bet.contracts * bid),
      };
    },
    async realizedPnl(fillId) {
      const bet = recent().find((b) => String(b.id) === fillId);
      if (bet == null || !TERMINAL.has(bet.status)) return null;
      return roundTo((bet.payout ?? 0) - bet.cost - takerFee(bet.contracts, bet.avgPrice));
    },
  };
}
