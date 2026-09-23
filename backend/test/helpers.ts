import { openDatabase } from '../src/infra/db.ts';
import { createAccountRepo, type AccountRepo } from '../src/infra/repos/accountRepo.ts';
import { createBetRepo, type BetRepo } from '../src/infra/repos/betRepo.ts';
import { createRoundRepo, type RoundRepo } from '../src/infra/repos/roundRepo.ts';
import { createQuoteStore, type QuoteStore } from '../src/market/quoteStore.ts';
import {
  createPredictionService,
  type PredictionService,
} from '../src/services/predictionService.ts';
import { fixedClock } from '../src/services/clock.ts';
import { windowStartFor } from '../src/domain/window.ts';

/** 2026-09-23T07:05:00Z —— 一个干净的 5 分钟窗口起点 */
export const BASE_NOW = Date.UTC(2026, 8, 23, 7, 5, 0, 0);

export interface HarnessOptions {
  nowMs?: number;
  /** 盘口时间戳，默认与 nowMs 同步（视为新鲜） */
  quoteTs?: number;
  /** 传 null 表示上游无盘口 */
  book?: {
    upBid?: number | null;
    upAsk?: number | null;
    downBid?: number | null;
    downAsk?: number | null;
  } | null;
  /** 是否预建当前回合 */
  withRound?: boolean;
  startPrice?: number | null;
}

export interface Harness {
  service: PredictionService;
  quotes: QuoteStore;
  rounds: RoundRepo;
  bets: BetRepo;
  accounts: AccountRepo;
  clock: ReturnType<typeof fixedClock>;
  /** 直接下手改库，用于构造不一致状态来验证事务回滚 */
  db: ReturnType<typeof openDatabase>;
  close(): void;
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const nowMs = options.nowMs ?? BASE_NOW;
  const db = openDatabase(':memory:');
  const clock = fixedClock(nowMs);
  const quotes = createQuoteStore();
  const rounds = createRoundRepo(db);
  const bets = createBetRepo(db);
  const accounts = createAccountRepo(db);

  if (options.book !== null) {
    quotes.set({ upBid: 0.49, upAsk: 0.5, downBid: 0.49, downAsk: 0.5, ...options.book, ts: options.quoteTs ?? nowMs });
  }
  if (options.withRound !== false) {
    // 显式传 null 表示「目标价暂时缺」，不能当成没传而被默认值顶掉
    const startPrice = options.startPrice === undefined ? 60_000 : options.startPrice;
    rounds.insertIfAbsent(windowStartFor(nowMs), startPrice);
  }

  const service = createPredictionService({ db, rounds, bets, accounts, quotes, clock });
  return { service, quotes, rounds, bets, accounts, clock, db, close: () => db.close() };
}
