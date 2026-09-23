import type { Clock } from './clock.ts';
import type { PredictionService, SettlePrices } from './predictionService.ts';

export interface SchedulerDeps {
  service: PredictionService;
  clock: Clock;
  /** 取某个窗口的开收盘价；返回 null 表示上游暂无数据 */
  priceLookup?: (windowStart: number) => SettlePrices | null;
  /** 巡检间隔，默认 1 秒 */
  intervalMs?: number;
  onError?: (e: unknown) => void;
}

export interface Scheduler {
  /** 跑一轮：开回合 → 封盘上一回合 → 结算 → 补结算巡检 */
  tick(): void;
  start(): void;
  stop(): void;
  running(): boolean;
}

/**
 * 回合生命周期的心跳。
 *
 * 每一步都是幂等的 CAS：重复跑只会撞在 `WHERE status=...` 上返回 0 行，
 * 所以这个「每秒都全量重试一遍」的笨办法是安全的，也把上游漏推送、
 * 进程中途重启这些情况一并兜住。
 */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { service, clock, priceLookup } = deps;
  const intervalMs = deps.intervalMs ?? 1000;
  let timer: ReturnType<typeof setInterval> | null = null;

  function guard(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      deps.onError?.(e);
    }
  }

  function tick(): void {
    const now = clock.now();
    const windowStart = Math.floor(now / 1000 / 300) * 300;
    const prevWindowStart = windowStart - 300;

    // 1) 当前窗口必须有回合，否则用户下单会撞 ROUND_NOT_FOUND
    const prices = priceLookup?.(windowStart) ?? null;
    guard(() => service.ensureRound(prices?.startPrice ?? null));

    // 2) 上一窗口到点封盘
    guard(() => service.lockRound(prevWindowStart));

    // 3) 上一窗口尝试定盘（缺价会自动降级为「等下次」）
    guard(() => {
      service.settleRound(prevWindowStart, priceLookup?.(prevWindowStart) ?? {});
    });

    // 4) 兜底：漏锁漏结的旧回合补一遍
    guard(() => {
      service.sweepStuckRounds(priceLookup ?? undefined);
    });
  }

  return {
    tick,
    start() {
      if (timer != null) return;
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer == null) return;
      clearInterval(timer);
      timer = null;
    },
    running: () => timer != null,
  };
}
