import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { windowStartFor } from '../src/domain/window.ts';
import { createMarketFeed } from '../src/market/feed.ts';
import { createPriceHistory } from '../src/market/priceHistory.ts';
import { createSimulatedMarket } from '../src/market/simulated.ts';
import { BASE_NOW, makeHarness } from './helpers.ts';

const WS = windowStartFor(BASE_NOW);

describe('syncTargetPrice：目标价晚到也能补上', () => {
  it('回合先由调度器建出（目标价为空），随后价到 → 回填（落库精度 8 位小数，同上游 NUMERIC(20,8)）', () => {
    const h = makeHarness({ withRound: false });
    try {
      h.service.ensureRound(null);
      assert.equal(h.rounds.findByWindowStart(WS)?.startPrice, null);

      assert.equal(h.service.syncTargetPrice(WS, 85_990.81943700438), true);
      assert.equal(h.rounds.findByWindowStart(WS)?.startPrice, 85_990.819437);
    } finally {
      h.close();
    }
  });

  it('重复回填同一个价无副作用、不重复广播', () => {
    const h = makeHarness({ withRound: false });
    try {
      h.service.ensureRound(null);
      const seen: unknown[] = [];
      h.events.subscribe((e) => {
        if (e.type === 'round') seen.push(e.data);
      });

      assert.equal(h.service.syncTargetPrice(WS, 86_000), true);
      assert.equal(seen.length, 1);
      assert.equal(h.service.syncTargetPrice(WS, 86_000), false);
      assert.equal(seen.length, 1, '无变化就不该再推一次');
    } finally {
      h.close();
    }
  });

  it('价变了要覆盖旧价并广播', () => {
    const h = makeHarness({ withRound: false });
    try {
      h.service.ensureRound(null);
      h.service.syncTargetPrice(WS, 86_000);
      assert.equal(h.service.syncTargetPrice(WS, 86_010), true);
      assert.equal(h.rounds.findByWindowStart(WS)?.startPrice, 86_010);
    } finally {
      h.close();
    }
  });

  it('封盘后不再改目标价（否则就是事后改判据）', () => {
    const h = makeHarness({ withRound: false });
    try {
      h.service.ensureRound(null);
      h.service.lockRound(WS);
      assert.equal(h.service.syncTargetPrice(WS, 86_000), false);
      assert.equal(h.rounds.findByWindowStart(WS)?.startPrice, null);
    } finally {
      h.close();
    }
  });

  it('回合不存在 / 价为 null / 价位 0 都不写', () => {
    const h = makeHarness({ withRound: false });
    try {
      assert.equal(h.service.syncTargetPrice(WS, 86_000), false, '回合不存在');
      h.service.ensureRound(null);
      assert.equal(h.service.syncTargetPrice(WS, null), false);
      assert.equal(h.rounds.findByWindowStart(WS)?.startPrice, null);
    } finally {
      h.close();
    }
  });

  it('精度按 8 位小数落库，不因浮点尾差反复改价', () => {
    const h = makeHarness({ withRound: false });
    try {
      h.service.ensureRound(null);
      assert.equal(h.service.syncTargetPrice(WS, 85990.819437004381), true);
      // 同一个值的另一种写法（多出可忽略的尾数）不应触发第二次写入
      assert.equal(h.service.syncTargetPrice(WS, 85990.8194370043855), false);
    } finally {
      h.close();
    }
  });
});

describe('行情接入与回合创建的先后顺序无关', () => {
  it('调度器先建回合（无价）时，行情照样把目标价补给前端', async () => {
    const h = makeHarness({ withRound: false });
    try {
      // 模拟调度器抢先建出回合
      h.service.ensureRound(null);
      assert.equal(h.service.currentRound().startPrice, null);

      const feed = createMarketFeed({
        quotes: h.quotes,
        prices: createPriceHistory(),
        service: h.service,
        clock: h.clock,
        events: h.events,
        mode: 'simulated',
        simulated: createSimulatedMarket({ seed: 5 }),
      });

      const snapshot = await feed.refresh();
      assert.notEqual(snapshot.targetPrice, null);
      // 模拟器的价是 2 位小数，落库后应与之一致
      assert.equal(h.service.currentRound().startPrice, snapshot.targetPrice);
      assert.equal(h.rounds.findByWindowStart(WS)?.startPrice, snapshot.targetPrice);
    } finally {
      h.close();
    }
  });

  it('行情先到（回合带价创建）时也无缝', async () => {
    const h = makeHarness({ withRound: false });
    try {
      const feed = createMarketFeed({
        quotes: h.quotes,
        prices: createPriceHistory(),
        service: h.service,
        clock: h.clock,
        mode: 'simulated',
        simulated: createSimulatedMarket({ seed: 5 }),
      });
      const snapshot = await feed.refresh();
      assert.equal(h.service.currentRound().startPrice, snapshot.targetPrice);

      // 调度器随后再 tick 一次，不应把已有目标价抹掉
      h.service.ensureRound(snapshot.targetPrice);
      assert.equal(h.rounds.findByWindowStart(WS)?.startPrice, snapshot.targetPrice);
    } finally {
      h.close();
    }
  });
});
