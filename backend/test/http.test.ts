import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_GAME_BALANCE } from '../src/infra/repos/accountRepo.ts';
import { BASE_NOW, makeApp, makeHarness, type TestApp } from './helpers.ts';

let h: ReturnType<typeof makeHarness>;
let t: TestApp;

before(() => {
  h = makeHarness({ book: { upAsk: 0.5, upBid: 0.6, downAsk: 0.5, downBid: 0.4 } });
  t = makeApp(h);
});

after(async () => {
  await t.close();
});

describe('GET /api/health', () => {
  it('返回服务状态与服务端时间', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.serverTimeMs, BASE_NOW);
  });
});

describe('GET /api/prediction/current', () => {
  it('返回当前回合与盘口', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/prediction/current' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.round.status, 'OPEN');
    assert.equal(body.round.remainingSeconds, 300);
    assert.deepEqual(body.quote.up, { bid: 0.6, ask: 0.5 });
    assert.deepEqual(body.quote.down, { bid: 0.4, ask: 0.5 });
  });

  it('无盘口时 quote 为 null（而不是空对象）', async () => {
    const bare = makeApp(makeHarness({ book: null }));
    try {
      const res = await bare.app.inject({ method: 'GET', url: '/api/prediction/current' });
      assert.equal(res.json().quote, null);
    } finally {
      await bare.close();
    }
  });
});

describe('POST /api/prediction/buy', () => {
  it('下单成功返回注单视图', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/prediction/buy',
      headers: { 'x-user-id': '11', 'x-username': 'trader' },
      payload: { side: 'UP', amount: 100 },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.side, 'UP');
    assert.equal(body.contracts, 200);
    assert.equal(body.cost, 100);
    assert.equal(h.accounts.gameBalanceOf(11), DEFAULT_GAME_BALANCE - 103.5);
  });

  it('方向非法 → 400 SIDE_INVALID', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/prediction/buy',
      payload: { side: 'LONG', amount: 100 },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'SIDE_INVALID');
  });

  it('金额越界 → 400 AMOUNT_INVALID', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/prediction/buy',
      payload: { side: 'UP', amount: 0 },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'AMOUNT_INVALID');
  });

  it('缺少 body → 400', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/prediction/buy', payload: {} });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'SIDE_INVALID');
  });

  it('余额不足 → 400 INSUFFICIENT_BALANCE', async () => {
    const poorHarness = makeHarness({ book: { upAsk: 0.5 } });
    const poor = makeApp(poorHarness);
    try {
      poorHarness.accounts.ensure(5, 'poor', 50);
      const res = await poor.app.inject({
        method: 'POST',
        url: '/api/prediction/buy',
        headers: { 'x-user-id': '5' },
        payload: { side: 'UP', amount: 100 },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.code, 'INSUFFICIENT_BALANCE');
      assert.equal(poorHarness.accounts.gameBalanceOf(5), 50, '不扣款');
    } finally {
      await poor.close();
    }
  });
});

describe('POST /api/prediction/sell/:betId', () => {
  it('整单卖出成功', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/prediction/buy',
      headers: { 'x-user-id': '12' },
      payload: { side: 'UP', amount: 100 },
    });
    const betId = created.json().id;
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/prediction/sell/${betId}`,
      headers: { 'x-user-id': '12' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'SOLD');
  });

  it('带 contracts 查询参数时部分卖出', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/prediction/buy',
      headers: { 'x-user-id': '13' },
      payload: { side: 'UP', amount: 100 },
    });
    const betId = created.json().id;
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/prediction/sell/${betId}?contracts=50`,
      headers: { 'x-user-id': '13' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().contracts, 50);
    assert.equal(res.json().status, 'SOLD');
  });

  it('卖别人的单 → 404 BET_NOT_FOUND', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/prediction/buy',
      headers: { 'x-user-id': '14' },
      payload: { side: 'UP', amount: 10 },
    });
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/prediction/sell/${created.json().id}`,
      headers: { 'x-user-id': '99' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'BET_NOT_FOUND');
  });

  it('注单号非法 → 404', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/prediction/sell/abc' });
    assert.equal(res.statusCode, 404);
  });

  it('窗口走完后卖出 → 409 ROUND_LOCKED', async () => {
    const staleHarness = makeHarness({ book: { upAsk: 0.5, upBid: 0.6 } });
    const stale = makeApp(staleHarness);
    try {
      const created = await stale.app.inject({
        method: 'POST',
        url: '/api/prediction/buy',
        headers: { 'x-user-id': '1' },
        payload: { side: 'UP', amount: 10 },
      });
      assert.equal(created.statusCode, 200);

      // 时间推进一个窗口：盘口随之刷新，注单已不在当前窗口
      staleHarness.clock.advance(300_000);
      staleHarness.quotes.set({ upAsk: 0.5, upBid: 0.6, ts: staleHarness.clock.now() });

      const res = await stale.app.inject({
        method: 'POST',
        url: `/api/prediction/sell/${created.json().id}`,
        headers: { 'x-user-id': '1' },
      });
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error.code, 'ROUND_LOCKED');
    } finally {
      await stale.close();
    }
  });

  it('盘口不可用时卖出 → 503 PRICE_UNAVAILABLE', async () => {
    const noBookHarness = makeHarness({ book: { upAsk: 0.5, upBid: 0.6 } });
    const noBook = makeApp(noBookHarness);
    try {
      const created = await noBook.app.inject({
        method: 'POST',
        url: '/api/prediction/buy',
        headers: { 'x-user-id': '1' },
        payload: { side: 'UP', amount: 10 },
      });
      noBookHarness.quotes.clear();
      const res = await noBook.app.inject({
        method: 'POST',
        url: `/api/prediction/sell/${created.json().id}`,
        headers: { 'x-user-id': '1' },
      });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().error.code, 'PRICE_UNAVAILABLE');
    } finally {
      await noBook.close();
    }
  });
});

describe('GET /api/prediction/bets · rounds · pnl · live', () => {
  it('bets 分页返回我的注单', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/prediction/bets?pageNum=1&pageSize=5',
      headers: { 'x-user-id': '11' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.pageNum, 1);
    assert.equal(body.pageSize, 5);
    assert.equal(body.total >= 1, true);
    assert.equal(body.rows.length >= 1, true);
  });

  it('pageSize 被夹到 [1,100]，非法值回落默认', async () => {
    const big = await t.app.inject({
      method: 'GET',
      url: '/api/prediction/bets?pageSize=99999',
      headers: { 'x-user-id': '11' },
    });
    assert.equal(big.json().pageSize, 100);
    const bad = await t.app.inject({
      method: 'GET',
      url: '/api/prediction/bets?pageNum=-3&pageSize=abc',
      headers: { 'x-user-id': '11' },
    });
    assert.equal(bad.json().pageNum, 1);
    assert.equal(bad.json().pageSize, 10);
  });

  it('rounds 只返回已结算回合', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/prediction/rounds' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.total, 0, '尚无结算回合');
  });

  it('pnl 自动开户并返回账户口径', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/prediction/pnl',
      headers: { 'x-user-id': '21', 'x-username': 'neo' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.gameBalance, DEFAULT_GAME_BALANCE);
    assert.equal(body.equity, DEFAULT_GAME_BALANCE);
    assert.equal(h.accounts.find(21)?.username, 'neo');
  });

  it('live 返回全站成交且用户名打码', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/prediction/live' });
    assert.equal(res.statusCode, 200);
    const rows = res.json().rows;
    assert.equal(Array.isArray(rows), true);
    assert.equal(rows.length > 0, true);
    for (const row of rows) {
      assert.equal(row.username.includes('***') || row.username.length <= 2, true);
      assert.equal(['UP', 'DOWN'].includes(row.side), true);
    }
  });

  it('带 x-username 下单后，成交流显示打码用户名（不是空串）', async () => {
    const named = makeHarness({ book: { upAsk: 0.5 } });
    const namedApp = makeApp(named);
    try {
      const res = await namedApp.app.inject({
        method: 'POST',
        url: '/api/prediction/buy',
        headers: { 'x-user-id': '77', 'x-username': 'realtrader' },
        payload: { side: 'UP', amount: 10 },
      });
      assert.equal(res.statusCode, 200);

      const live = await namedApp.app.inject({ method: 'GET', url: '/api/prediction/live' });
      const row = live.json().rows[0];
      assert.equal(row.username, 're***');
      assert.equal(row.amount, 10);
    } finally {
      await namedApp.close();
    }
  });

  it('已是老账户时不会被后续请求改名', async () => {
    const named = makeHarness({ book: { upAsk: 0.5 } });
    const namedApp = makeApp(named);
    try {
      named.accounts.ensure(88, '老名字');
      await namedApp.app.inject({
        method: 'POST',
        url: '/api/prediction/buy',
        headers: { 'x-user-id': '88', 'x-username': '新名字' },
        payload: { side: 'UP', amount: 10 },
      });
      assert.equal(named.accounts.find(88)?.username, '老名字');
    } finally {
      await namedApp.close();
    }
  });
});

describe('GET /api/prediction/price-history', () => {
  it('返回窗口内价格点与最新价', async () => {
    t.prices.push(BASE_NOW - 1000, 60_000);
    t.prices.push(BASE_NOW - 500, 60_010);
    const res = await t.app.inject({ method: 'GET', url: '/api/prediction/price-history' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.points, [
      { time: BASE_NOW - 1000, price: 60_000 },
      { time: BASE_NOW - 500, price: 60_010 },
    ]);
    assert.deepEqual(body.latest, { time: BASE_NOW - 500, price: 60_010 });
  });

  it('超出窗口的点被丢掉', async () => {
    t.prices.push(BASE_NOW - 400_000, 59_000);
    const res = await t.app.inject({ method: 'GET', url: '/api/prediction/price-history' });
    const times = res.json().points.map((p: { time: number }) => p.time);
    assert.equal(times.includes(BASE_NOW - 400_000), false);
  });
});

describe('未知接口', () => {
  it('404 且带统一错误体', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'NOT_FOUND');
  });
});

describe('GET /api/prediction/stream（SSE）', () => {
  it('首帧推当前回合与盘口，之后推送成交流', async () => {
    const sseHarness = makeHarness({ book: { upAsk: 0.5, upBid: 0.6 } });
    const sse = makeApp(sseHarness);
    try {
      const address = await sse.app.listen({ port: 0, host: '127.0.0.1' });
      const controller = new AbortController();
      const res = await fetch(`${address}/api/prediction/stream`, {
        signal: controller.signal,
        headers: { 'x-user-id': '1' },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      async function readUntil(pattern: string): Promise<string> {
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          if (buffer.includes(pattern)) return buffer;
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
        }
        throw new Error(`等不到 ${pattern}，已收到：${buffer}`);
      }

      await readUntil('event: round');
      await readUntil('event: market');
      assert.match(buffer, /"status":"OPEN"/);
      // 首帧盘口必须与后续推送同形状（扁平字段），否则前端要写两套解析
      assert.match(buffer, /"upBid":0\.6/);
      assert.match(buffer, /"downAsk":0\.5/);

      // 下单 → 应收到 activity 推送
      sseHarness.service.buy(1, 'UP', 10);
      await readUntil('event: activity');
      assert.match(buffer, /"side":"UP"/);
      assert.match(buffer, /"amount":10/);

      controller.abort();
    } finally {
      await sse.close();
    }
  });
});
