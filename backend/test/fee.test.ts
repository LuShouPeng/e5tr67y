import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { perShareFee, takerFee } from '../src/domain/fee.ts';

describe('perShareFee：每份费的形状', () => {
  it('50¢ 时最贵，每份 1.75¢（Polymarket 官方峰值）', () => {
    assert.equal(perShareFee(0.5), 0.0175);
  });

  it('关于 0.5 对称：fee(p) === fee(1 − p)（按舍入后的成交费比较）', () => {
    for (const p of [0.01, 0.1, 0.25, 0.3, 0.4, 0.49]) {
      assert.equal(takerFee(100, p), takerFee(100, 1 - p));
    }
  });

  it('两端为 0：确定的事不收风险溢价', () => {
    assert.equal(perShareFee(0), 0);
    assert.equal(perShareFee(1), 0);
  });

  it('以 0.5 为峰值先增后减', () => {
    const prices = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    const fees = prices.map(perShareFee);
    for (let i = 1; i <= 4; i++) assert.ok(fees[i]! > fees[i - 1]!, `应递增 @${prices[i]}`);
    for (let i = 5; i < fees.length; i++) assert.ok(fees[i]! < fees[i - 1]!, `应递减 @${prices[i]}`);
  });

  it('价格越界抛错', () => {
    assert.throws(() => perShareFee(-0.01), RangeError);
    assert.throws(() => perShareFee(1.01), RangeError);
  });
});

describe('takerFee：份数 × 0.07 × p × (1 − p)，4 位小数', () => {
  it('100 份 @50¢ → 1.75 USDT', () => {
    assert.equal(takerFee(100, 0.5), 1.75);
  });

  it('10 份 @50¢ → 0.175 USDT', () => {
    assert.equal(takerFee(10, 0.5), 0.175);
  });

  it('1 份 @50¢ → 0.0175 USDT（峰值每份费）', () => {
    assert.equal(takerFee(1, 0.5), 0.0175);
  });

  it('极端价格下费用显著变便宜', () => {
    assert.equal(takerFee(100, 0.01), 0.0693);
    assert.equal(takerFee(100, 0.99), 0.0693);
    // 1¢ 处的成交费只有峰值（50¢ 的 1.75）的约 4%
    assert.ok(takerFee(100, 0.01) < takerFee(100, 0.5) / 20);
  });

  it('整体一次舍入：3 份 @50¢ → 0.0525（不因分段舍入漂移）', () => {
    assert.equal(takerFee(3, 0.5), 0.0525);
  });

  it('需要进位的一笔：1 份 @12.34¢ → 0.0076', () => {
    assert.equal(takerFee(1, 0.1234), 0.0076);
  });

  it('0 份不收费', () => {
    assert.equal(takerFee(0, 0.5), 0);
  });

  it('随份数线性增长', () => {
    assert.equal(takerFee(200, 0.35), 2 * takerFee(100, 0.35));
  });

  it('结果始终落在 4 位小数网格上', () => {
    for (const contracts of [1, 7, 13.3333, 99.9999, 1234.5678]) {
      for (const p of [0.07, 0.31, 0.5, 0.83, 0.97]) {
        const fee = takerFee(contracts, p);
        assert.equal(fee, Number(fee.toFixed(4)), `contracts=${contracts} p=${p}`);
      }
    }
  });
});
