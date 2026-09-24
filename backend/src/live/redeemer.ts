import type { LivePositionRow, LiveStore } from './liveStore.ts';

/**
 * 自动领奖：窗口结束、仓位记成 WON 之后，把赢的份额在链上换回 USDC。
 *
 * 流程（每分钟一轮）：
 * 1. 捞出 WON、真单、待领（PENDING / FAILED 且没超重试次数）的仓位，按 conditionId 分组（一次 redeem 领掉该条件下全部份额）；
 * 2. 先问链上 CTF 合约该条件是否已结算（payoutDenominator > 0）——Polymarket 判结果到上链有延迟，没结算就下一轮再看；
 * 3. 已结算就提交 redeemPositions，等回执成功才记 REDEEMED；失败记 FAILED 下一轮重试，超过次数转 MANUAL。
 *
 * 领不了的（缺 conditionId、neg-risk 市场）直接记 MANUAL，需要到 Polymarket 网页手动领。
 */

export interface RedeemChain {
  /** 执行方式说明（日志 / 状态接口用） */
  readonly mode: 'direct' | 'relayer-safe' | 'relayer-proxy';
  /** 该条件是否已在链上结算 */
  isResolved(conditionId: string): Promise<boolean>;
  /** 提交领奖并等到上链成功；失败抛错 */
  redeem(conditionId: string): Promise<{ txHash: string }>;
}

export interface RedeemerOptions {
  store: LiveStore;
  chain: RedeemChain;
  now?: () => number;
  maxAttempts?: number;
  intervalMs?: number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface RedeemerStatus {
  mode: RedeemChain['mode'];
  running: boolean;
  lastRunAt: number | null;
  lastError: string | null;
  redeemedCount: number;
}

export interface Redeemer {
  /** 跑一轮，返回本轮领成功的条件数 */
  runOnce(): Promise<number>;
  start(): void;
  stop(): void;
  status(): RedeemerStatus;
}

export function createRedeemer(options: RedeemerOptions): Redeemer {
  const { store, chain } = options;
  const now = options.now ?? Date.now;
  const maxAttempts = options.maxAttempts ?? 5;
  const log = options.log ?? (() => {});
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<number> | null = null;
  let lastRunAt: number | null = null;
  let lastError: string | null = null;
  let redeemedCount = 0;

  async function runRound(): Promise<number> {
    lastRunAt = now();
    const byCondition = new Map<string, LivePositionRow[]>();
    for (const p of store.redeemable(maxAttempts)) {
      if (p.conditionId == null) {
        store.markRedeem([p.id], 'MANUAL', now(), { error: '缺少 conditionId，请到 Polymarket 网页领取' });
        continue;
      }
      if (p.negRisk) {
        store.markRedeem([p.id], 'MANUAL', now(), { error: 'neg-risk 市场暂不支持自动领取，请到 Polymarket 网页领取' });
        continue;
      }
      const list = byCondition.get(p.conditionId) ?? [];
      list.push(p);
      byCondition.set(p.conditionId, list);
    }

    let done = 0;
    for (const [conditionId, positions] of byCondition) {
      const ids = positions.map((p) => p.id);
      try {
        if (!(await chain.isResolved(conditionId))) continue; // 还没上链结算，不算失败
        const { txHash } = await chain.redeem(conditionId);
        store.markRedeem(ids, 'REDEEMED', now(), { tx: txHash, attempted: true });
        redeemedCount += ids.length;
        done++;
        log('领奖成功', { conditionId, txHash, positions: ids.length });
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        lastError = msg;
        const exhausted = positions.every((p) => p.redeemAttempts + 1 >= maxAttempts);
        store.markRedeem(ids, exhausted ? 'MANUAL' : 'FAILED', now(), { error: msg, attempted: true });
        log('领奖失败', { conditionId, error: msg, willRetry: !exhausted });
      }
    }
    return done;
  }

  return {
    runOnce() {
      // 同一时刻只跑一轮：上一轮的交易还在等回执时不重复提交
      if (inFlight == null) inFlight = runRound().finally(() => (inFlight = null));
      return inFlight;
    },
    start() {
      if (timer) return;
      timer = setInterval(() => void this.runOnce().catch(() => {}), options.intervalMs ?? 60_000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    status: () => ({ mode: chain.mode, running: timer != null, lastRunAt, lastError, redeemedCount }),
  };
}
