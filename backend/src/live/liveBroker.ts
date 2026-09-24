import type { Side } from '../domain/types.ts';
import { OrderRejectedError, type Broker, type BrokerPosition, type Fill } from '../execution/broker.ts';
import type { GeoGuard } from './geoblock.ts';
import type { LiveStore } from './liveStore.ts';

/**
 * 实盘通道：Polymarket CLOB（官方 `@polymarket/clob-client`）真金白银下单。
 *
 * 与模拟盘完全分离：独立 SQLite 账本（LiveStore）、独立风控、独立开关，不碰游戏钱包。
 * 下单方式：FAK 市价单 + 价格上限 / 下限（吃得到限价以内的就成交，剩下的撤掉），等价于上游「看到的价没变差才成交」。
 *
 * 每一笔真单之前都要过三道闸：
 * 1. 地域合规（GeoGuard，失败即关闭）；
 * 2. 风控：单笔上限、未了结仓位成本上限、日内亏损上限；
 * 3. dry-run：默认开启，只签名不提交，账本照记（dry_run=1），确认一切正常后再显式关掉。
 */

export interface ClobLike {
  createAndPostMarketOrder(
    order: { tokenID: string; amount: number; side: 'BUY' | 'SELL'; price?: number },
    options?: Record<string, unknown>,
    orderType?: 'FOK' | 'FAK',
  ): Promise<unknown>;
  createMarketOrder?(
    order: { tokenID: string; amount: number; side: 'BUY' | 'SELL'; price?: number },
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  getBalanceAllowance(params: { asset_type: 'COLLATERAL' }): Promise<{ balance?: string } | unknown>;
}

export interface WindowTokens {
  upTokenId: string | null;
  downTokenId: string | null;
}

export interface LiveRiskConfig {
  /** 单笔最多花多少 USDC（硬上限，策略 base stake 超过也会被截断） */
  maxStakeUsd: number;
  /** 未了结仓位成本合计上限 */
  maxOpenCostUsd: number;
  /** UTC 当日已实现亏损到这个数就停止开新仓 */
  maxDailyLossUsd: number;
}

export interface LiveBrokerOptions {
  clob: ClobLike;
  store: LiveStore;
  geo: GeoGuard;
  tokens: (windowStart: number) => WindowTokens | null;
  risk: LiveRiskConfig;
  dryRun: boolean;
  now?: () => number;
  /** dry-run 下的虚拟余额（没有真实钱包也能跑通链路） */
  dryRunBalance?: number;
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

/** CLOB 回包：BUY 的 making = 付出的 USDC、taking = 收到的份额；SELL 反过来 */
export function parseOrderResponse(resp: unknown): { ok: boolean; orderId: string | null; status: string; making: number; taking: number; error: string | null } {
  const r = (resp ?? {}) as Record<string, unknown>;
  const error = typeof r.errorMsg === 'string' && r.errorMsg !== '' ? r.errorMsg : typeof r.error === 'string' ? r.error : null;
  return {
    ok: r.success === true && error == null,
    orderId: typeof r.orderID === 'string' ? r.orderID : null,
    status: typeof r.status === 'string' ? r.status : r.success === true ? 'matched' : 'rejected',
    making: num(r.makingAmount),
    taking: num(r.takingAmount),
    error,
  };
}

function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export interface LiveBroker extends Broker {
  /** 用回合结果把已结束窗口的持仓记成输赢（赢的需到 Polymarket 领取） */
  resolveWindow(windowStart: number, outcome: Side): void;
  riskStatus(): { dryRun: boolean; openCost: number; realizedToday: number; risk: LiveRiskConfig };
}

export function createLiveBroker(options: LiveBrokerOptions): LiveBroker {
  const { clob, store, geo, risk, dryRun } = options;
  const now = options.now ?? Date.now;
  const dryRunBalance = options.dryRunBalance ?? 1_000;

  async function assertTradable(): Promise<void> {
    const g = await geo.ensure();
    if (!g.allowed) throw new OrderRejectedError('GEO_BLOCKED', g.reason ?? '地域受限');
  }

  function tokenFor(windowStart: number, side: Side): string {
    const t = options.tokens(windowStart);
    const id = side === 'UP' ? t?.upTokenId : t?.downTokenId;
    if (!id) throw new OrderRejectedError('NO_TOKEN', `窗口 ${windowStart} 的 ${side} token 未知`);
    return id;
  }

  function toPosition(p: { id: number; windowStart: number; side: Side; shares: number; cost: number }): BrokerPosition {
    return {
      id: String(p.id),
      windowStart: p.windowStart,
      side: p.side,
      contracts: p.shares,
      avgPrice: p.shares > 0 ? p.cost / p.shares : 0,
      cost: p.cost,
    };
  }

  return {
    kind: 'live',

    async balance() {
      if (dryRun) return Math.max(0, dryRunBalance + store.realizedSince(0, true) - store.openCost(true));
      const resp = (await clob.getBalanceAllowance({ asset_type: 'COLLATERAL' })) as { balance?: string };
      // USDC 6 位小数，接口回的是最小单位
      return num(resp?.balance) / 1e6;
    },

    async position(windowStart) {
      const p = store.openPositionFor(windowStart);
      return p ? toPosition(p) : null;
    },

    async hasUnsettled() {
      return store.openPositions().length > 0;
    },

    async buy(req): Promise<Fill> {
      await assertTradable();
      const t = now();
      const realizedToday = store.realizedSince(utcDayStart(t), dryRun);
      if (realizedToday <= -risk.maxDailyLossUsd) {
        throw new OrderRejectedError('RISK', `日内已亏 ${realizedToday.toFixed(2)}，达到上限 ${risk.maxDailyLossUsd}`);
      }
      const stake = Math.min(req.stake, risk.maxStakeUsd);
      if (store.openCost(dryRun) + stake > risk.maxOpenCostUsd) {
        throw new OrderRejectedError('RISK', `未了结仓位成本将超过上限 ${risk.maxOpenCostUsd}`);
      }
      const tokenId = tokenFor(req.windowStart, req.side);
      const order = { tokenID: tokenId, amount: stake, side: 'BUY' as const, price: req.maxPrice };

      let shares: number;
      let usdc: number;
      let orderId: string | null = null;
      let status: string;
      if (dryRun) {
        // 能签就签一下，顺带验证私钥 / API key 配置；不提交
        if (clob.createMarketOrder) await clob.createMarketOrder(order);
        shares = stake / req.maxPrice;
        usdc = stake;
        status = 'DRY_RUN';
      } else {
        const r = parseOrderResponse(await clob.createAndPostMarketOrder(order, undefined, 'FAK'));
        orderId = r.orderId;
        status = r.status;
        if (!r.ok || r.taking <= 0) {
          store.recordOrder({
            windowStart: req.windowStart, side: req.side, tokenId, action: 'BUY', amount: stake, priceLimit: req.maxPrice,
            shares: 0, usdc: 0, orderId, status, dryRun, error: r.error ?? '未成交', createdAt: t,
          });
          throw new OrderRejectedError('MISSED', `买单未成交：${r.error ?? status}`);
        }
        shares = r.taking;
        usdc = r.making;
      }
      store.recordOrder({
        windowStart: req.windowStart, side: req.side, tokenId, action: 'BUY', amount: stake, priceLimit: req.maxPrice,
        shares, usdc, orderId, status, dryRun, error: null, createdAt: t,
      });
      const pos = store.openPosition({ windowStart: req.windowStart, side: req.side, tokenId, shares, cost: usdc, dryRun, nowMs: t });
      return { id: String(pos.id), side: req.side, contracts: shares, avgPrice: usdc / shares, amount: usdc, dryRun };
    },

    async sell(req): Promise<Fill> {
      await assertTradable();
      const t = now();
      const pos = store.position(Number(req.position.id));
      if (pos == null || pos.status !== 'OPEN') throw new OrderRejectedError('NO_POSITION', `仓位 ${req.position.id} 不在持`);
      const order = { tokenID: pos.tokenId, amount: pos.shares, side: 'SELL' as const, price: req.minPrice };
      let usdc: number;
      let sold = pos.shares;
      let orderId: string | null = null;
      let status: string;
      if (dryRun) {
        if (clob.createMarketOrder) await clob.createMarketOrder(order);
        usdc = pos.shares * req.minPrice;
        status = 'DRY_RUN';
      } else {
        const r = parseOrderResponse(await clob.createAndPostMarketOrder(order, undefined, 'FAK'));
        orderId = r.orderId;
        status = r.status;
        if (!r.ok || r.taking <= 0) {
          store.recordOrder({
            windowStart: pos.windowStart, side: pos.side, tokenId: pos.tokenId, action: 'SELL', amount: pos.shares,
            priceLimit: req.minPrice, shares: 0, usdc: 0, orderId, status, dryRun, error: r.error ?? '未成交', createdAt: t,
          });
          throw new OrderRejectedError('MISSED', `卖单未成交：${r.error ?? status}`);
        }
        usdc = r.taking;
        // SELL 的 making 是卖出的份额；FAK 可能只成交一部分
        if (r.making > 0) sold = Math.min(r.making, pos.shares);
      }
      store.recordOrder({
        windowStart: pos.windowStart, side: pos.side, tokenId: pos.tokenId, action: 'SELL', amount: pos.shares,
        priceLimit: req.minPrice, shares: sold, usdc, orderId, status, dryRun, error: null, createdAt: t,
      });
      if (sold < pos.shares - 1e-6) store.partialSell(pos.id, sold, usdc, t);
      else store.closePosition(pos.id, usdc, t);
      return { id: String(pos.id), side: pos.side, contracts: sold, avgPrice: usdc / sold, amount: usdc, dryRun };
    },

    async realizedPnl(fillId) {
      const p = store.position(Number(fillId));
      if (p == null || p.status === 'OPEN') return null;
      return p.proceeds + (p.payout ?? 0) - p.cost;
    },

    resolveWindow(windowStart, outcome) {
      for (const p of store.openPositions()) {
        if (p.windowStart === windowStart) store.resolvePosition(p.id, p.side === outcome, now());
      }
    },

    riskStatus() {
      const t = now();
      return { dryRun, openCost: store.openCost(dryRun), realizedToday: store.realizedSince(utcDayStart(t), dryRun), risk };
    },
  };
}
