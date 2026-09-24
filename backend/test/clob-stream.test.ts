import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createClobBookStream, subscribeMessage, type StreamBook } from '../src/market/clobStream.ts';
import type { WsLike } from '../src/market/chainlinkStream.ts';
import { createMarketFeed, type FetchLike } from '../src/market/feed.ts';
import { createPriceHistory } from '../src/market/priceHistory.ts';
import { BASE_NOW, makeHarness } from './helpers.ts';

type FakeWs = WsLike & { sent: string[]; closed: boolean; fire(type: 'open' | 'message' | 'close', data?: unknown): void };

function fakeWs(): FakeWs {
  const listeners = new Map<string, ((e: { data?: unknown }) => void)[]>();
  return {
    sent: [],
    closed: false,
    send(d) {
      this.sent.push(d);
    },
    close() {
      this.closed = true;
    },
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    fire(type, data) {
      for (const fn of listeners.get(type) ?? []) fn({ data });
    },
  };
}

function setup(clockStart = 1_000_000) {
  let clock = clockStart;
  const sockets: FakeWs[] = [];
  const books: StreamBook[] = [];
  const stream = createClobBookStream({
    now: () => clock,
    wsFactory: () => {
      const ws = fakeWs();
      sockets.push(ws);
      return ws;
    },
    onBook: (b) => books.push(b),
  });
  return { stream, sockets, books, tick: (ms: number) => (clock += ms), now: () => clock };
}

const book = (asset: string, bids: string[], asks: string[]) =>
  JSON.stringify({ event_type: 'book', asset_id: asset, bids: bids.map((price) => ({ price, size: '10' })), asks: asks.map((price) => ({ price, size: '10' })) });

describe('CLOB 盘口流', () => {
  it('连上后订阅两个 token；两个都有快照才算有盘口', () => {
    const { stream, sockets, books } = setup();
    stream.subscribe(100, 'up', 'down');
    const ws = sockets[0]!;
    ws.fire('open');
    assert.deepEqual(ws.sent, [subscribeMessage('up', 'down')]);
    assert.deepEqual(JSON.parse(ws.sent[0]!), { assets_ids: ['up', 'down'], type: 'market' });

    ws.fire('message', book('up', ['0.47', '0.49'], ['0.52', '0.55']));
    assert.equal(stream.current(), null);
    // 快照可以是数组
    ws.fire('message', `[${book('down', ['0.48'], ['0.53'])}]`);
    assert.deepEqual(stream.current(), { windowStart: 100, upBid: 0.49, upAsk: 0.52, downBid: 0.48, downAsk: 0.53, ts: 1_000_000 });
    assert.equal(books.length, 1);
  });

  it('price_change 按 best_bid / best_ask 更新；别的 token 的消息不收', () => {
    const { stream, sockets } = setup();
    stream.subscribe(100, 'up', 'down');
    const ws = sockets[0]!;
    ws.fire('open');
    ws.fire('message', book('up', ['0.47'], ['0.52']));
    ws.fire('message', book('down', ['0.48'], ['0.53']));
    ws.fire('message', JSON.stringify({
      event_type: 'price_change',
      price_changes: [
        { asset_id: 'up', price: '0.5', size: '5', side: 'BUY', best_bid: '0.5', best_ask: '0.51' },
        { asset_id: 'other', best_bid: '0.1', best_ask: '0.2' },
      ],
    }));
    const b = stream.current()!;
    assert.equal(b.upBid, 0.5);
    assert.equal(b.upAsk, 0.51);
    assert.equal(b.downBid, 0.48);
  });

  it('盘口没变时靠 PONG 确认仍有效，时间戳前进；断线后不再前进', () => {
    const { stream, sockets, books, tick } = setup();
    stream.subscribe(100, 'up', 'down');
    const ws = sockets[0]!;
    ws.fire('open');
    ws.fire('message', book('up', ['0.47'], ['0.52']));
    ws.fire('message', book('down', ['0.48'], ['0.53']));
    const first = stream.current()!.ts;
    tick(4_000);
    ws.fire('message', 'PONG');
    assert.equal(stream.current()!.ts, first + 4_000);
    assert.equal(books.at(-1)!.ts, first + 4_000);
    ws.fire('close');
    tick(10_000);
    assert.equal(stream.current()!.ts, first + 4_000);
    assert.equal(stream.status().connected, false);
  });

  it('换回合：旧盘口作废、换一条连接订阅新 token', () => {
    const { stream, sockets } = setup();
    stream.subscribe(100, 'up', 'down');
    sockets[0]!.fire('open');
    sockets[0]!.fire('message', book('up', ['0.47'], ['0.52']));
    sockets[0]!.fire('message', book('down', ['0.48'], ['0.53']));
    stream.subscribe(100, 'up', 'down'); // 同一组：无副作用
    assert.equal(sockets.length, 1);
    stream.subscribe(400, 'up2', 'down2');
    assert.equal(sockets.length, 2);
    assert.ok(sockets[0]!.closed);
    assert.equal(stream.current(), null);
    sockets[1]!.fire('open');
    assert.deepEqual(JSON.parse(sockets[1]!.sent[0]!).assets_ids, ['up2', 'down2']);
    // 旧连接迟到的消息不算
    sockets[0]!.fire('message', book('up2', ['0.1'], ['0.9']));
    assert.equal(stream.current(), null);
    stream.stop();
  });
});

describe('feed × CLOB 流', () => {
  const WS = BASE_NOW / 1000;
  const stubs: Array<[string, unknown]> = [
    ['crypto-price', { openPrice: '60000', closePrice: null, completed: false }],
    ['events/slug', { markets: [{ slug: `btc-updown-5m-${WS}`, outcomes: '["Up","Down"]', clobTokenIds: '["t-up","t-down"]' }] }],
    ['token_id=t-up', { bids: [{ price: '0.40' }], asks: [{ price: '0.60' }] }],
    ['token_id=t-down', { bids: [{ price: '0.40' }], asks: [{ price: '0.60' }] }],
  ];
  function fetchStub(calls: string[]): FetchLike {
    return async (url) => {
      calls.push(url);
      const hit = stubs.find(([m]) => url.includes(m));
      return { status: hit ? 200 : 404, headers: null, json: async () => hit?.[1] ?? {} };
    };
  }

  it('流里盘口新鲜就不拉账本；流旧了退回 REST；旧窗口的推送不写', async () => {
    const h = makeHarness({ book: null });
    const calls: string[] = [];
    const sockets: FakeWs[] = [];
    let feedRef: ReturnType<typeof createMarketFeed> | null = null;
    const stream = createClobBookStream({
      now: () => h.clock.now(),
      wsFactory: () => {
        const ws = fakeWs();
        sockets.push(ws);
        return ws;
      },
      onBook: (b) => feedRef!.applyStreamBook(b),
    });
    const feed = createMarketFeed({
      quotes: h.quotes, prices: createPriceHistory(), service: h.service, clock: h.clock,
      fetchImpl: fetchStub(calls), mode: 'polymarket', bookStream: stream,
    });
    feedRef = feed;

    // 第一轮：流还没数据 → REST 兜底，同时订阅了当前窗口
    await feed.refresh();
    assert.equal(calls.filter((u) => u.includes('/book')).length, 2);
    assert.equal(h.quotes.get()!.up.ask, 0.6);
    const ws = sockets[0]!;
    ws.fire('open');
    assert.deepEqual(JSON.parse(ws.sent[0]!).assets_ids, ['t-up', 't-down']);

    // 流推来盘口 → 立刻写入 quotes
    ws.fire('message', book('t-up', ['0.55'], ['0.57']));
    ws.fire('message', book('t-down', ['0.42'], ['0.44']));
    assert.equal(h.quotes.get()!.up.ask, 0.57);
    assert.equal(h.quotes.get()!.ts, h.clock.now());

    // 第二轮：流新鲜 → 不再拉账本
    calls.length = 0;
    h.clock.advance(2_000);
    ws.fire('message', 'PONG');
    const snap = await feed.refresh();
    assert.equal(calls.filter((u) => u.includes('/book')).length, 0);
    assert.equal(snap.quote!.upAsk, 0.57);

    // 流静默超过 5 秒 → 这一轮用 REST
    h.clock.advance(6_000);
    await feed.refresh();
    assert.equal(calls.filter((u) => u.includes('/book')).length, 2);
    assert.equal(h.quotes.get()!.up.ask, 0.6);

    // 下一个窗口开始后，旧窗口的推送不写进 quotes
    h.clock.advance(300_000);
    ws.fire('message', book('t-up', ['0.1'], ['0.2']));
    assert.equal(h.quotes.get()!.up.ask, 0.6);
    stream.stop();
    h.close();
  });
});
