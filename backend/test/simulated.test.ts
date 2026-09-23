import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createSimulatedMarket } from '../src/market/simulated.ts';
import { WINDOW_SECONDS } from '../src/domain/types.ts';

const WS = Date.UTC(2026, 8, 23, 7, 5, 0, 0) / 1000;

describe('价格曲线：闭式函数，与调用顺序无关', () => {
  it('同一输入永远同一输出（可复现）', () => {
    const a = createSimulatedMarket({ seed: 7 });
    const b = createSimulatedMarket({ seed: 7 });
    for (const sec of [WS - 120, WS, WS + 60, WS + 299]) {
      assert.equal(a.priceAt(sec), b.priceAt(sec));
    }
  });

  it('不同种子给出不同曲线', () => {
    const a = createSimulatedMarket({ seed: 1 });
    const b = createSimulatedMarket({ seed: 2 });
    const diffs = [0, 50, 100, 200].filter((d) => a.priceAt(WS + d) !== b.priceAt(WS + d));
    assert.equal(diffs.length, 4);
  });

  it('乱序求值结果一致（无隐藏游标）', () => {
    const m = createSimulatedMarket();
    const forward = [0, 1, 2, 3].map((i) => m.priceAt(WS + i));
    const backward = [3, 2, 1, 0].map((i) => m.priceAt(WS + i)).reverse();
    assert.deepEqual(forward, backward);
  });

  it('价格始终在基准价附近窄幅波动（不会跑飞）', () => {
    const m = createSimulatedMarket({ basePrice: 60_000 });
    for (let s = WS - 600; s < WS + 600; s++) {
      const p = m.priceAt(s);
      assert.ok(p > 59_000 && p < 61_000, `第 ${s - WS} 秒价格越界：${p}`);
    }
  });

  it('相邻秒之间不会跳变（逐秒噪声上限约 0.1%，加正弦斜率仍远小于 0.3%）', () => {
    const m = createSimulatedMarket();
    for (let s = WS; s < WS + 200; s++) {
      const jump = Math.abs(m.priceAt(s + 1) - m.priceAt(s)) / m.priceAt(s);
      assert.ok(jump < 0.003, `第 ${s - WS} 秒跳变 ${jump}`);
    }
  });
});

describe('开收盘价：都是 60 秒均值，口径同上游 TWAP', () => {
  it('目标价等于窗口前 60 秒的均值', () => {
    const m = createSimulatedMarket();
    let sum = 0;
    for (let s = WS - 60; s < WS; s++) sum += m.priceAt(s);
    assert.equal(m.openPrice(WS), Math.round((sum / 60) * 100) / 100);
  });

  it('收盘价等于窗口末 60 秒的均值', () => {
    const m = createSimulatedMarket();
    let sum = 0;
    for (let s = WS + WINDOW_SECONDS - 60; s < WS + WINDOW_SECONDS; s++) sum += m.priceAt(s);
    assert.equal(m.closePrice(WS), Math.round((sum / 60) * 100) / 100);
  });

  it('同一窗口的目标价稳定（回合存的目标价不会来回改）', () => {
    const m = createSimulatedMarket();
    assert.equal(m.openPrice(WS), m.openPrice(WS));
  });

  it('相邻窗口的目标价接近但不相同', () => {
    const m = createSimulatedMarket();
    const diff = Math.abs(m.openPrice(WS + 300) - m.openPrice(WS));
    assert.ok(diff > 0, '不应完全相等');
    assert.ok(diff / m.openPrice(WS) < 0.01, '也不应差出 1%');
  });
});

describe('盘口：价格围绕目标价推出涨跌概率', () => {
  it('所有价位都落在 (0,1) 内，且买一低于卖一', () => {
    const m = createSimulatedMarket();
    for (let i = 0; i < 60; i++) {
      const q = m.quoteAt((WS + i * 5) * 1000, WS);
      for (const key of ['upBid', 'upAsk', 'downBid', 'downAsk'] as const) {
        assert.ok(q[key] > 0 && q[key] < 1, `${key} 越界：${q[key]}`);
      }
      assert.ok(q.upBid < q.upAsk, 'UP 买一必须低于卖一');
      assert.ok(q.downBid < q.downAsk, 'DOWN 买一必须低于卖一');
    }
  });

  it('UP 与 DOWN 的概率互补（两边加起来约等于 1）', () => {
    const m = createSimulatedMarket();
    for (let i = 0; i < 30; i++) {
      const q = m.quoteAt((WS + i * 10) * 1000, WS);
      const upMid = (q.upBid + q.upAsk) / 2;
      const downMid = (q.downBid + q.downAsk) / 2;
      assert.ok(Math.abs(upMid + downMid - 1) < 0.005, `${upMid} + ${downMid}`);
    }
  });

  it('价格高于目标价时偏向看涨，低于时偏向看跌', () => {
    const m = createSimulatedMarket();
    const target = m.openPrice(WS);
    let checkedUp = false;
    let checkedDown = false;
    for (let i = 0; i < 300; i++) {
      const nowMs = (WS + i) * 1000;
      const q = m.quoteAt(nowMs, WS);
      const mid = (q.upBid + q.upAsk) / 2;
      if (q.btcPrice > target) {
        assert.ok(mid >= 0.5, `价高于目标价时应偏涨：${mid}`);
        checkedUp = true;
      } else if (q.btcPrice < target) {
        assert.ok(mid <= 0.5, `价低于目标价时应偏跌：${mid}`);
        checkedDown = true;
      }
    }
    assert.ok(checkedUp && checkedDown, '样本里应同时出现高于与低于目标价的情形');
  });

  it('参考价与同一时刻的盘口价格一致', () => {
    const m = createSimulatedMarket();
    const at = (WS + 42) * 1000 + 500;
    assert.equal(m.referencePrice(at), m.quoteAt(at, WS).btcPrice);
  });
});
