import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  bestPrice,
  clobBookUrl,
  cryptoPriceUrl,
  eventSlug,
  gammaEventUrl,
  parseBook,
  parseCryptoPrice,
  parseGammaTokens,
  parseHttpDateMs,
  parseJsonArrayField,
} from '../src/market/polymarket.ts';

const WS = Date.UTC(2026, 8, 23, 7, 5, 0, 0) / 1000;

describe('URL 构造', () => {
  it('slug 就是窗口起点', () => {
    assert.equal(eventSlug(WS), `btc-updown-5m-${WS}`);
    assert.equal(gammaEventUrl(WS), `https://gamma-api.polymarket.com/events/slug/btc-updown-5m-${WS}`);
  });

  it('取价地址必须带 TWAP 参数（否则拿到的是边界现价，与官方结算不一致）', () => {
    const url = cryptoPriceUrl(WS);
    assert.match(url, /twapEnabled=true/);
    assert.match(url, /twapLookbackSeconds=60/);
    assert.match(url, /symbol=BTC/);
    assert.match(url, /variant=fiveminute/);
  });

  it('开收盘时间覆盖整个窗口', () => {
    const url = cryptoPriceUrl(WS);
    assert.match(url, new RegExp(encodeURIComponent('2026-09-23T07:05:00.000Z')));
    assert.match(url, new RegExp(encodeURIComponent('2026-09-23T07:10:00.000Z')));
  });

  it('book 地址对 token 做转义', () => {
    assert.match(clobBookUrl('a b/c'), /token_id=a%20b%2Fc$/);
  });
});

describe('parseJsonArrayField：数组与被转义的数组字符串都要吃', () => {
  it('真数组原样返回', () => {
    assert.deepEqual(parseJsonArrayField(['a', 'b']), ['a', 'b']);
  });

  it('JSON 字符串解析成数组', () => {
    assert.deepEqual(parseJsonArrayField('["Up","Down"]'), ['Up', 'Down']);
  });

  it('空串 / 非数组 JSON / 其它类型一律 null', () => {
    assert.equal(parseJsonArrayField(''), null);
    assert.equal(parseJsonArrayField('{"a":1}'), null);
    assert.equal(parseJsonArrayField('not json'), null);
    assert.equal(parseJsonArrayField(null), null);
    assert.equal(parseJsonArrayField(42), null);
  });
});

describe('parseGammaTokens：按 outcomes 与 clobTokenIds 的下标对应取 token', () => {
  const makeEvent = (outcomes: unknown, tokenIds: unknown, slug = eventSlug(WS)) => ({
    markets: [{ slug, outcomes, clobTokenIds: tokenIds }],
  });

  it('正序：Up 在前', () => {
    const tokens = parseGammaTokens(makeEvent('["Up","Down"]', '["token-up","token-down"]'), eventSlug(WS));
    assert.deepEqual(tokens, { upTokenId: 'token-up', downTokenId: 'token-down' });
  });

  it('倒序：Down 在前也不会认错方向（下标对应，不靠顺序猜）', () => {
    const tokens = parseGammaTokens(makeEvent('["Down","Up"]', '["token-down","token-up"]'), eventSlug(WS));
    assert.deepEqual(tokens, { upTokenId: 'token-up', downTokenId: 'token-down' });
  });

  it('大小写不敏感', () => {
    const tokens = parseGammaTokens(makeEvent(['up', 'DOWN'], ['a', 'b']), eventSlug(WS));
    assert.deepEqual(tokens, { upTokenId: 'a', downTokenId: 'b' });
  });

  it('按 slug 命中对应市场，其余市场作备选', () => {
    const event = {
      markets: [
        { slug: 'other-slug', outcomes: '["Up","Down"]', clobTokenIds: '["x","y"]' },
        { slug: eventSlug(WS), outcomes: '["Up","Down"]', clobTokenIds: '["real-up","real-down"]' },
      ],
    };
    assert.deepEqual(parseGammaTokens(event, eventSlug(WS)), {
      upTokenId: 'real-up',
      downTokenId: 'real-down',
    });
  });

  it('slug 全不命中时退回第一个可用市场', () => {
    const event = { markets: [{ slug: 'nope', outcomes: '["Up","Down"]', clobTokenIds: '["x","y"]' }] };
    assert.deepEqual(parseGammaTokens(event, eventSlug(WS)), { upTokenId: 'x', downTokenId: 'y' });
  });

  it('outcomes 认不出来时退回下标 0/1', () => {
    const tokens = parseGammaTokens(makeEvent('["YES","NO"]', '["t0","t1"]'), eventSlug(WS));
    assert.deepEqual(tokens, { upTokenId: 't0', downTokenId: 't1' });
  });

  it('无 markets / 无 token 字段 → null', () => {
    assert.equal(parseGammaTokens({ markets: [] }, 'x'), null);
    assert.equal(parseGammaTokens({}, 'x'), null);
    assert.equal(parseGammaTokens(null, 'x'), null);
    assert.equal(parseGammaTokens({ markets: [{ slug: 'x' }] }, 'x'), null);
  });

  it('只有一个 token 时另一边为 null，不硬凑', () => {
    const tokens = parseGammaTokens(makeEvent('["Up"]', '["only-up"]'), eventSlug(WS));
    assert.deepEqual(tokens, { upTokenId: 'only-up', downTokenId: null });
  });
});

describe('parseCryptoPrice：completed 是收盘价的可用开关', () => {
  it('字符串数值与数字都接受', () => {
    assert.deepEqual(parseCryptoPrice({ openPrice: '60000.5', closePrice: 60010.25, completed: true }), {
      openPrice: 60000.5,
      closePrice: 60010.25,
      completed: true,
    });
  });

  it('completed 缺失按未收官处理', () => {
    assert.deepEqual(parseCryptoPrice({ openPrice: 60_000, closePrice: 60_100 }), {
      openPrice: 60_000,
      closePrice: 60_100,
      completed: false,
    });
  });

  it('缺失/非法/非正的价一律 null', () => {
    assert.deepEqual(parseCryptoPrice({}), { openPrice: null, closePrice: null, completed: false });
    assert.deepEqual(parseCryptoPrice({ openPrice: 'abc', closePrice: -5 }), {
      openPrice: null,
      closePrice: null,
      completed: false,
    });
  });

  it('非对象 → null', () => {
    assert.equal(parseCryptoPrice(null), null);
    assert.equal(parseCryptoPrice('60000'), null);
    assert.equal(parseCryptoPrice([]), null);
  });
});

describe('bestPrice / parseBook：档位顺序无关', () => {
  it('买盘取最高、卖盘取最低，不假设上游排过序', () => {
    assert.equal(bestPrice([{ price: '0.40' }, { price: '0.55' }, { price: '0.52' }], true), 0.55);
    assert.equal(bestPrice([{ price: '0.60' }, { price: '0.56' }, { price: '0.70' }], false), 0.56);
  });

  it('空档位回 null', () => {
    assert.equal(bestPrice([], true), null);
    assert.equal(bestPrice(undefined, true), null);
  });

  it('坏档位被跳过', () => {
    assert.equal(bestPrice([{ price: 'abc' }, { price: 0.3 }, { price: -1 }], true), 0.3);
  });

  it('parseBook 组合出买一卖一', () => {
    const book = parseBook({
      bids: [{ price: '0.48' }, { price: '0.49' }],
      asks: [{ price: '0.53' }, { price: '0.51' }],
    });
    assert.deepEqual(book, { bid: 0.49, ask: 0.51 });
  });

  it('只有一边有档位时另一边为 null', () => {
    assert.deepEqual(parseBook({ bids: [{ price: '0.4' }] }), { bid: 0.4, ask: null });
  });

  it('不是账本对象 → null', () => {
    assert.equal(parseBook({ foo: 1 }), null);
    assert.equal(parseBook(null), null);
  });
});

describe('parseHttpDateMs：上游 Date 头作时钟基准', () => {
  it('RFC 1123 时间可解析', () => {
    assert.equal(parseHttpDateMs('Wed, 23 Sep 2026 07:20:40 GMT'), Date.UTC(2026, 8, 23, 7, 20, 40));
  });

  it('缺失或非法回 null', () => {
    assert.equal(parseHttpDateMs(null), null);
    assert.equal(parseHttpDateMs(''), null);
    assert.equal(parseHttpDateMs('not a date'), null);
  });
});
