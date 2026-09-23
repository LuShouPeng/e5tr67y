import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isQuoteFresh,
  normalizeAsk,
  normalizeBid,
  normalizeQuoteBook,
  opposite,
  quoteFor,
  type QuoteBook,
} from '../src/domain/pricing.ts';

describe('normalizeBid / normalizeAsk：空档位等价于没有报价', () => {
  it('买一 0（或更小）视为无报价', () => {
    assert.equal(normalizeBid(0), null);
    assert.equal(normalizeBid(-0.1), null);
  });

  it('买一 1 是合法报价（市场认定必涨）', () => {
    assert.equal(normalizeBid(1), 1);
    assert.equal(normalizeBid(0.5), 0.5);
  });

  it('卖一 1（或更大）视为无报价：没人愿意卖', () => {
    assert.equal(normalizeAsk(1), null);
    assert.equal(normalizeAsk(1.2), null);
  });

  it('卖一 0 是合法报价', () => {
    assert.equal(normalizeAsk(0), 0);
    assert.equal(normalizeAsk(0.5), 0.5);
  });

  it('null / 非有限值一律 null', () => {
    assert.equal(normalizeBid(null), null);
    assert.equal(normalizeBid(undefined), null);
    assert.equal(normalizeBid(Number.NaN), null);
    assert.equal(normalizeAsk(Number.POSITIVE_INFINITY), null);
  });
});

describe('normalizeQuoteBook：把上游原始字段整形成盘口', () => {
  it('两边都归一，并记录时间戳', () => {
    const book = normalizeQuoteBook({ upBid: 0.62, upAsk: 0.63, downBid: 0, downAsk: 1, ts: 111 });
    assert.deepEqual(book, {
      up: { bid: 0.62, ask: 0.63 },
      down: { bid: null, ask: null },
      ts: 111,
    });
  });

  it('缺省字段按无报价处理', () => {
    const book = normalizeQuoteBook({});
    assert.deepEqual(book.up, { bid: null, ask: null });
    assert.deepEqual(book.down, { bid: null, ask: null });
    assert.equal(typeof book.ts, 'number');
  });
});

describe('quoteFor / opposite', () => {
  const book: QuoteBook = normalizeQuoteBook({ upBid: 0.4, upAsk: 0.41, downBid: 0.59, downAsk: 0.6 });

  it('按方向取到对应的那一边', () => {
    assert.deepEqual(quoteFor(book, 'UP'), { bid: 0.4, ask: 0.41 });
    assert.deepEqual(quoteFor(book, 'DOWN'), { bid: 0.59, ask: 0.6 });
  });

  it('没有盘口时返回 null', () => {
    assert.equal(quoteFor(null, 'UP'), null);
  });

  it('UP 与 DOWN 互为反面', () => {
    assert.equal(opposite('UP'), 'DOWN');
    assert.equal(opposite('DOWN'), 'UP');
    assert.equal(opposite(opposite('UP')), 'UP');
  });
});

describe('isQuoteFresh：超龄报价宁可不下单', () => {
  const book: QuoteBook = { up: { bid: 0.5, ask: 0.51 }, down: { bid: 0.49, ask: 0.5 }, ts: 10_000 };

  it('15 秒内算新鲜', () => {
    assert.equal(isQuoteFresh(book, 10_000), true);
    assert.equal(isQuoteFresh(book, 25_000), true);
    assert.equal(isQuoteFresh(book, 25_001), false);
  });

  it('时钟回拨（未来时间戳）判为不新鲜，避免误用', () => {
    assert.equal(isQuoteFresh(book, 9_000), false);
  });

  it('没有盘口即不新鲜', () => {
    assert.equal(isQuoteFresh(null, 10_000), false);
  });

  it('可自定义容忍时长', () => {
    assert.equal(isQuoteFresh(book, 40_000, 30_000), true);
    assert.equal(isQuoteFresh(book, 40_001, 30_000), false);
  });
});
