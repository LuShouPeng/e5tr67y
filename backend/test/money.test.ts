import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { roundTo, truncateTo } from '../src/domain/money.ts';

describe('roundTo：4 位小数 HALF_UP（对齐 BigDecimal.setScale）', () => {
  it('恰好落在网格上的值原样返回', () => {
    assert.equal(roundTo(0.0175), 0.0175);
    assert.equal(roundTo(1), 1);
    assert.equal(roundTo(10000), 10000);
    assert.equal(roundTo(0), 0);
  });

  it('消除浮点尾差：0.1 + 0.2 归到 0.3', () => {
    assert.equal(0.1 + 0.2 === 0.3, false);
    assert.equal(roundTo(0.1 + 0.2), 0.3);
  });

  it('不会二次舍入：1.00004999 保持 1，而非进位成 1.0001', () => {
    assert.equal(roundTo(1.00004999), 1);
    assert.equal(roundTo(1.00005001), 1.0001);
  });

  it('半值向远离零方向进位（HALF_UP）', () => {
    assert.equal(roundTo(0.00005), 0.0001);
    assert.equal(roundTo(0.00015), 0.0002);
    assert.equal(roundTo(-0.00005), -0.0001);
    assert.equal(roundTo(2.5, 0), 3);
    assert.equal(roundTo(1.5, 0), 2);
  });

  it('极小值在 4 位小数下归零', () => {
    assert.equal(roundTo(1e-7), 0);
    assert.equal(roundTo(-1e-7), 0);
    assert.equal(roundTo(0.000049), 0);
  });

  it('支持其它精度', () => {
    assert.equal(roundTo(1.23456, 2), 1.23);
    assert.equal(roundTo(1.23556, 2), 1.24);
    assert.equal(roundTo(0.0175, 6), 0.0175);
  });

  it('拒绝非有限数值与超范围量级', () => {
    assert.throws(() => roundTo(Number.NaN), RangeError);
    assert.throws(() => roundTo(Number.POSITIVE_INFINITY), RangeError);
    assert.throws(() => roundTo(1e21), RangeError);
  });
});

describe('truncateTo：向零取整（对齐 BigDecimal RoundingMode.DOWN）', () => {
  it('直接丢弃多余小数位，不进位', () => {
    assert.equal(truncateTo(1234.56789), 1234.5678);
    assert.equal(truncateTo(0.00009), 0);
    assert.equal(truncateTo(0.99999), 0.9999);
  });

  it('负数同样向零取整（不是向下取整）', () => {
    assert.equal(truncateTo(-1234.56789), -1234.5678);
    assert.equal(truncateTo(-0.00009), 0);
  });

  it('舍入到 0 时不产生 -0（JSON 与 Object.is 语义下都是异常值）', () => {
    assert.equal(Object.is(truncateTo(-0.00009), -0), false);
    assert.equal(Object.is(roundTo(-1e-7), -0), false);
  });

  it('恰好落在网格上不受影响', () => {
    assert.equal(truncateTo(0.0175), 0.0175);
    assert.equal(truncateTo(3), 3);
  });
});
