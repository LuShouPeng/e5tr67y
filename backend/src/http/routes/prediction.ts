import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Side } from '../../domain/types.ts';
import { DomainError } from '../../domain/errors.ts';
import type { PriceHistory } from '../../market/priceHistory.ts';
import type { QuoteStore } from '../../market/quoteStore.ts';
import type { Clock } from '../../services/clock.ts';
import type { EventBus } from '../../services/eventBus.ts';
import type { PredictionService } from '../../services/predictionService.ts';

export interface RouteDeps {
  service: PredictionService;
  quotes: QuoteStore;
  prices: PriceHistory;
  events: EventBus;
  clock: Clock;
}

/** 演示用身份：`x-user-id` 头即用户，缺省 1 号。生产接入真登录时只换这一个函数 */
function currentUserId(req: FastifyRequest): number {
  const raw = req.headers['x-user-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 1;
}

function currentUsername(req: FastifyRequest): string | undefined {
  const raw = req.headers['x-username'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.trim() !== '' ? value.trim() : undefined;
}

function pageParams(query: unknown): { pageNum: number; pageSize: number } {
  const q = (query ?? {}) as Record<string, unknown>;
  const pageNum = Math.max(1, Math.trunc(Number(q.pageNum ?? 1)) || 1);
  const pageSizeRaw = Math.trunc(Number(q.pageSize ?? 10)) || 10;
  return { pageNum, pageSize: Math.min(100, Math.max(1, pageSizeRaw)) };
}

function pageNumOf(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new DomainError('CONTRACTS_INVALID', `页码必须是数字：${String(value)}`);
  }
  return n;
}

function sideOf(value: unknown): Side {
  if (value !== 'UP' && value !== 'DOWN') {
    throw new DomainError('SIDE_INVALID', `方向只能是 UP 或 DOWN，收到：${String(value)}`);
  }
  return value;
}

function amountOf(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new DomainError('AMOUNT_INVALID', `金额必须是数字：${String(value)}`);
  }
  return n;
}

export function registerPredictionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { service, quotes, prices, events, clock } = deps;

  app.get('/api/health', () => ({ ok: true, serverTimeMs: clock.now() }));

  app.get('/api/prediction/current', () => ({
    round: service.currentRound(),
    quote: quotes.get(),
  }));

  app.get('/api/prediction/quote', () => ({ quote: quotes.get(), serverTimeMs: clock.now() }));

  app.get('/api/prediction/price-history', () => {
    const from = clock.now() - 300_000;
    return { points: prices.since(from), latest: prices.latest() };
  });

  app.post('/api/prediction/buy', (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return service.buy(currentUserId(req), sideOf(body.side), amountOf(body.amount));
  });

  app.post<{ Params: { betId: string }; Querystring: { contracts?: string } }>(
    '/api/prediction/sell/:betId',
    (req) => {
      const betId = Number(req.params.betId);
      if (!Number.isInteger(betId) || betId <= 0) {
        throw new DomainError('BET_NOT_FOUND', `注单号非法：${req.params.betId}`);
      }
      const rawContracts = req.query.contracts;
      const contracts =
        rawContracts === undefined || rawContracts === '' ? null : pageNumOf(rawContracts);
      return service.sell(currentUserId(req), betId, contracts);
    },
  );

  app.get('/api/prediction/bets', (req) => {
    const { pageNum, pageSize } = pageParams(req.query);
    return service.listBets(currentUserId(req), pageNum, pageSize);
  });

  app.get('/api/prediction/rounds', (req) => {
    const { pageNum, pageSize } = pageParams(req.query);
    return service.listSettledRounds(pageNum, pageSize);
  });

  app.get('/api/prediction/pnl', (req) => {
    const userId = currentUserId(req);
    service.ensureAccount(userId, currentUsername(req));
    return service.pnl(userId);
  });

  app.get('/api/prediction/live', () => ({ rows: service.recentActivity(20) }));

  /**
   * SSE 事件流：`round`（开回合/封盘/定盘）、`market`（盘口）、`activity`（成交）。
   * 用 hijack 接管响应，因为这是长连接，不是「一个请求一个响应」。
   */
  app.get('/api/prediction/stream', (req: FastifyRequest, reply: FastifyReply) => {
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.hijack();

    const send = (event: string, data: unknown): void => {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // 首帧就把当前状态推下去，前端不用再补一次 GET
    send('round', service.currentRound());
    send('market', quotes.get());

    const unsubscribe = events.subscribe((e) => send(e.type, e.data));
    // 心跳：中间有反代时，静默的连接会被当成死连接掐掉
    const heartbeat = setInterval(() => raw.write(': ping\n\n'), 15_000);
    heartbeat.unref?.();

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
