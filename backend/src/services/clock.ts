export interface Clock {
  /** 当前时间（毫秒） */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** 测试用可控时钟：把「5 分钟窗口」变成可复现的输入 */
export function fixedClock(startMs: number): Clock & { advance(ms: number): void; set(ms: number): void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}
