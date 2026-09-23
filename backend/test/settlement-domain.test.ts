import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isVoidDue, resolveOutcome, voidWaitSeconds } from '../src/domain/settlement.ts';
import { VOID_AFTER_SECONDS, WINDOW_SECONDS } from '../src/domain/types.ts';

describe('resolveOutcome：收盘 TWAP ≥ 开盘 TWAP 判 UP', () => {
  it('上涨判 UP，下跌判 DOWN', () => {
    assert.equal(resolveOutcome(60_000, 60_010), 'UP');
    assert.equal(resolveOutcome(60_010, 60_000), 'DOWN');
  });

  it('相等算 UP（Polymarket 官方口径，没有平局）', () => {
    assert.equal(resolveOutcome(60_000, 60_000), 'UP');
  });

  it('差 1 分也照判', () => {
    assert.equal(resolveOutcome(60_000, 60_000.01), 'UP');
    assert.equal(resolveOutcome(60_000, 59_999.99), 'DOWN');
  });

  it('非有限数值抛错，避免脏价定盘', () => {
    assert.throws(() => resolveOutcome(Number.NaN, 60_000), RangeError);
    assert.throws(() => resolveOutcome(60_000, Number.POSITIVE_INFINITY), RangeError);
  });
});

describe('缺价等待策略：有钱押着就多等一会儿', () => {
  it('有注单等满一小时，没注单只等两个窗口', () => {
    assert.equal(voidWaitSeconds(1), VOID_AFTER_SECONDS);
    assert.equal(voidWaitSeconds(0), 2 * WINDOW_SECONDS);
  });

  it('未到等待时长不作废', () => {
    assert.equal(isVoidDue(100, 1), false);
    assert.equal(isVoidDue(3599, 1), false);
  });

  it('到点即作废', () => {
    assert.equal(isVoidDue(3600, 1), true);
    assert.equal(isVoidDue(599, 0), false);
    assert.equal(isVoidDue(600, 0), true);
  });
});
