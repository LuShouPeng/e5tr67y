import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAmount,
  assertSide,
  estimateContracts,
  planBuy,
  planSell,
} from '../src/domain/order.ts';
import { DomainError } from '../src/domain/errors.ts';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    return `非领域错误：${String(e)}`;
  }
  return '未抛错';
}

describe('下单参数校验', () => {
  it('方向只接受 UP / DOWN', () => {
    assert.doesNotThrow(() => assertSide('UP'));
    assert.doesNotThrow(() => assertSide('DOWN'));
    assert.equal(codeOf(() => assertSide('up')), 'SIDE_INVALID');
    assert.equal(codeOf(() => assertSide(null)), 'SIDE_INVALID');
  });

  it('金额闭区间 [1, 10000]', () => {
    assert.doesNotThrow(() => assertAmount(1));
    assert.doesNotThrow(() => assertAmount(10_000));
    assert.equal(codeOf(() => assertAmount(0.99)), 'AMOUNT_INVALID');
    assert.equal(codeOf(() => assertAmount(10_000.01)), 'AMOUNT_INVALID');
    assert.equal(codeOf(() => assertAmount(Number.NaN)), 'AMOUNT_INVALID');
    assert.equal(codeOf(() => assertAmount('100' as unknown as number)), 'AMOUNT_INVALID');
  });
});

describe('planBuy：份数 = 金额 ÷ 卖一价（向零取整），费用在金额之外', () => {
  it('100 USDT @50¢ → 200 份，成本 100，费 3.5，共扣 103.5', () => {
    const plan = planBuy(100, 0.5);
    assert.equal(plan.contracts, 200);
    assert.equal(plan.cost, 100);
    assert.equal(plan.fee, 3.5);
    assert.equal(plan.total, 103.5);
    assert.equal(plan.payout, 200);
  });

  it('10 USDT @25¢ → 40 份，成本 10，费 0.525', () => {
    const plan = planBuy(10, 0.25);
    assert.equal(plan.contracts, 40);
    assert.equal(plan.cost, 10);
    assert.equal(plan.fee, 0.525);
    assert.equal(plan.total, 10.525);
    assert.equal(plan.payout, 40);
  });

  it('非整除价：份数向零取整，成本被舍回金额以内', () => {
    const plan = planBuy(100, 0.37);
    assert.equal(plan.contracts, 270.2702);
    assert.equal(plan.cost, 100);
    assert.ok(plan.cost <= 100, '成本不得超过下单金额');
    assert.equal(plan.payout, 270.2702);
  });

  it('高价位的极端取整：100 @99¢ 成本仍不超过金额', () => {
    const plan = planBuy(100, 0.99);
    assert.equal(plan.contracts, 101.0101);
    assert.equal(plan.cost, 100);
    assert.ok(plan.cost <= 100);
  });

  it('贴近 1 的价位：1 USDT @99.99¢ 买 1.0001 份', () => {
    const plan = planBuy(1, 0.9999);
    assert.equal(plan.contracts, 1.0001);
    assert.equal(plan.cost, 1);
  });

  it('所有金额档位都满足 成本 ≤ 金额 且 派彩 ≥ 金额', () => {
    for (const amount of [1, 2.5, 17.77, 99.99, 1000, 10_000]) {
      for (const ask of [0.01, 0.13, 0.5, 0.77, 0.99]) {
        const plan = planBuy(amount, ask);
        assert.ok(plan.cost <= amount, `成本 ${plan.cost} > 金额 ${amount} @${ask}`);
        assert.ok(plan.payout >= amount, `派彩 ${plan.payout} < 金额 ${amount} @${ask}`);
        assert.equal(plan.total, Number((plan.cost + plan.fee).toFixed(4)));
      }
    }
  });

  it('价位不可用（0 / 1 / 越界）拒绝下单', () => {
    assert.equal(codeOf(() => planBuy(100, 0)), 'PRICE_UNAVAILABLE');
    assert.equal(codeOf(() => planBuy(100, 1)), 'PRICE_UNAVAILABLE');
    assert.equal(codeOf(() => planBuy(100, 1.2)), 'PRICE_UNAVAILABLE');
    assert.equal(codeOf(() => planBuy(100, Number.NaN)), 'PRICE_UNAVAILABLE');
  });

  it('金额越界先于取价被拒', () => {
    assert.equal(codeOf(() => planBuy(0, 0.5)), 'AMOUNT_INVALID');
    assert.equal(codeOf(() => planBuy(10_001, 0.5)), 'AMOUNT_INVALID');
  });
});

describe('planSell：成交额 = 份数 × 买一价，扣费后到手', () => {
  it('100 份 @60¢ → 成交额 60，费 1.68，到手 58.32', () => {
    const plan = planSell(100, 0.6);
    assert.equal(plan.gross, 60);
    assert.equal(plan.fee, 1.68);
    assert.equal(plan.net, 58.32);
  });

  it('50 份 @50¢ → 成交额 25，费 0.875，到手 24.125', () => {
    const plan = planSell(50, 0.5);
    assert.equal(plan.gross, 25);
    assert.equal(plan.fee, 0.875);
    assert.equal(plan.net, 24.125);
  });

  it('碎股部分卖出：33.3333 份 @42¢ → 成交额 14，费 0.5684', () => {
    const plan = planSell(33.3333, 0.42);
    assert.equal(plan.gross, 14);
    assert.equal(plan.fee, 0.5684);
    assert.equal(plan.net, 13.4316);
  });

  it('买一 1 时不收费（概率端点费率为 0）', () => {
    const plan = planSell(10, 1);
    assert.equal(plan.gross, 10);
    assert.equal(plan.fee, 0);
    assert.equal(plan.net, 10);
  });

  it('份数必须为正', () => {
    assert.equal(codeOf(() => planSell(0, 0.5)), 'CONTRACTS_INVALID');
    assert.equal(codeOf(() => planSell(-1, 0.5)), 'CONTRACTS_INVALID');
    assert.equal(codeOf(() => planSell(Number.NaN, 0.5)), 'CONTRACTS_INVALID');
  });

  it('价位不可用（0 / 越界）拒绝卖出', () => {
    assert.equal(codeOf(() => planSell(10, 0)), 'PRICE_UNAVAILABLE');
    assert.equal(codeOf(() => planSell(10, 1.5)), 'PRICE_UNAVAILABLE');
  });
});

describe('estimateContracts：前端的「预计收益」口径', () => {
  it('金额 ÷ 概率价格，向下取整', () => {
    assert.equal(estimateContracts(100, 0.5), 200);
    assert.equal(estimateContracts(100, 0.37), 270.2702);
    assert.equal(estimateContracts(100, 1), 100);
  });

  it('价位不可用时返回 0，供 UI 显示空态', () => {
    assert.equal(estimateContracts(100, 0), 0);
    assert.equal(estimateContracts(100, 1.5), 0);
    assert.equal(estimateContracts(100, Number.NaN), 0);
  });

  it('与 planBuy 的份数完全一致', () => {
    for (const amount of [1, 5, 33.33, 500, 10_000]) {
      for (const price of [0.02, 0.31, 0.5, 0.68, 0.97]) {
        assert.equal(estimateContracts(amount, price), planBuy(amount, price).contracts);
      }
    }
  });
});
