import { normalizeQuoteBook, type QuoteBook } from '../domain/pricing.ts';

export interface QuoteStore {
  get(): QuoteBook | null;
  set(raw: {
    upBid?: number | null;
    upAsk?: number | null;
    downBid?: number | null;
    downAsk?: number | null;
    ts?: number;
  }): QuoteBook;
  /** 上游断开时清空盘口：宁可不报价，也不拿旧价成交 */
  clear(): void;
}

export function createQuoteStore(initial: QuoteBook | null = null): QuoteStore {
  let book: QuoteBook | null = initial;
  return {
    get: () => book,
    set(raw) {
      book = normalizeQuoteBook(raw);
      return book;
    },
    clear() {
      book = null;
    },
  };
}
