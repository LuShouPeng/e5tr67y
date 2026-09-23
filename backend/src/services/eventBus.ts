export type PredictionEventType = 'round' | 'market' | 'activity';

export interface BusEvent {
  type: PredictionEventType;
  data: unknown;
}

export interface EventBus {
  publish(type: PredictionEventType, data: unknown): void;
  subscribe(fn: (event: BusEvent) => void): () => void;
  subscriberCount(): number;
}

/**
 * 极简进程内事件总线，只服务 SSE 推送。
 *
 * 刻意不引入 Redis/MQ：单进程、订阅者就是浏览器长连接，
 * 多一个中间件就多一处「推送先到、事实后到」的不一致。
 * 推送一律在事务提交之后发出——发出去就撤不回，事务回滚了推送还在就是假消息。
 */
export function createEventBus(): EventBus {
  const listeners = new Set<(event: BusEvent) => void>();

  return {
    publish(type, data) {
      for (const listener of listeners) {
        try {
          listener({ type, data });
        } catch {
          // 单个订阅者出错不能影响其它订阅者与下单主流程
        }
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    subscriberCount: () => listeners.size,
  };
}
