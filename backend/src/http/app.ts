import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';

import type { PriceHistory } from '../market/priceHistory.ts';
import type { QuoteStore } from '../market/quoteStore.ts';
import type { Clock } from '../services/clock.ts';
import type { EventBus } from '../services/eventBus.ts';
import type { PredictionService } from '../services/predictionService.ts';
import { toHttpError } from './errors.ts';
import { registerPredictionRoutes, type RouteDeps } from './routes/prediction.ts';

export interface BuildAppOptions extends RouteDeps {
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.register(cors, { origin: true });

  // 领域错误统一在这里翻译成 HTTP：路由里只管过用例、不写状态码
  app.setErrorHandler((error, _req, reply) => {
    const { status, body } = toHttpError(error);
    if (status >= 500) app.log.error(error);
    void reply.status(status).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `无此接口：${req.method} ${req.url}` },
    });
  });

  registerPredictionRoutes(app, options);
  return app;
}

export type { QuoteStore, PriceHistory, EventBus, Clock, PredictionService };
