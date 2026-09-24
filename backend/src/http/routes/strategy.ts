import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { GeoGuard } from '../../live/geoblock.ts';
import type { LiveBroker } from '../../live/liveBroker.ts';
import type { LiveStore } from '../../live/liveStore.ts';
import type { Redeemer } from '../../live/redeemer.ts';
import type { OrderQueue } from '../../execution/orderQueue.ts';
import type { DecisionRepo } from '../../strategy/decisionRepo.ts';
import type { StrategyRunner } from '../../strategy/runner.ts';

export interface StrategyRouteDeps {
  runner: StrategyRunner;
  decisions: DecisionRepo;
  orders: OrderQueue;
  /** 开关接口的口令；为 null 时开关接口一律拒绝（只读接口照常） */
  adminToken: string | null;
  live?: { broker: LiveBroker; store: LiveStore; geo: GeoGuard; redeemer: Redeemer | null; redeemDisabledReason: string | null } | null;
}

function requireAdmin(token: string | null, req: FastifyRequest, reply: FastifyReply): boolean {
  const given = req.headers['x-admin-token'];
  if (token == null || given !== token) {
    void reply.status(403).send({ error: { code: 'FORBIDDEN', message: '需要正确的 x-admin-token（STRATEGY_ADMIN_TOKEN）' } });
    return false;
  }
  return true;
}

export function registerStrategyRoutes(app: FastifyInstance, deps: StrategyRouteDeps): void {
  const { runner, decisions } = deps;

  app.get('/api/strategy/status', () => {
    const s = runner.status();
    return { ...s, summary: decisions.summary(s.broker), orders: deps.orders.stats() };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/strategy/orders', (req) => {
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(req.query.limit ?? 50)) || 50));
    return { rows: deps.orders.recent(limit) };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/strategy/decisions', (req) => {
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(req.query.limit ?? 50)) || 50));
    // state_json 很长，列表里不带；要看具体 state 查库
    return { rows: decisions.recent(runner.status().broker, limit).map(({ stateJson: _s, ...rest }) => rest) };
  });

  app.post('/api/strategy/switch', (req, reply) => {
    if (!requireAdmin(deps.adminToken, req, reply)) return reply;
    const on = (req.body as { on?: unknown } | undefined)?.on === true;
    runner.setEnabled(on);
    return runner.status();
  });

  const live = deps.live;
  if (live) {
    app.get('/api/live/status', async () => ({
      geo: await live.geo.ensure(),
      balance: await live.broker.balance().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })),
      ...live.broker.riskStatus(),
    }));
    app.get('/api/live/orders', () => ({ rows: live.store.recentOrders(100) }));
    app.get('/api/live/positions', () => ({ rows: live.store.recentPositions(100) }));
    app.get('/api/live/redeem', () =>
      live.redeemer ? { enabled: true, ...live.redeemer.status() } : { enabled: false, reason: live.redeemDisabledReason },
    );
    app.post('/api/live/redeem/run', async (req, reply) => {
      if (!requireAdmin(deps.adminToken, req, reply)) return reply;
      if (!live.redeemer) return reply.status(409).send({ error: { code: 'REDEEM_DISABLED', message: live.redeemDisabledReason } });
      return { redeemedConditions: await live.redeemer.runOnce(), ...live.redeemer.status() };
    });
  }
}
