import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { env } from './lib/env.js';
import { AppError } from './lib/errors.js';
import authPlugin from './plugins/auth.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { comandaRoutes } from './modules/comanda/comanda.routes.js';
import { menuRoutes } from './modules/menu/menu.routes.js';
import { pedidoRoutes } from './modules/pedido/pedido.routes.js';
import { sessaoRoutes } from './modules/sessao/sessao.routes.js';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: env.NODE_ENV !== 'test',
    // Nao logue o header Authorization nem o Idempotency-Key com o token junto.
    disableRequestLogging: false,
  });

  app.register(cors, { origin: env.CORS_ORIGIN, credentials: true });
  app.register(authPlugin);

  app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(sessaoRoutes);
      await api.register(menuRoutes);
      await api.register(pedidoRoutes);
      await api.register(comandaRoutes);
    },
    { prefix: '/api' },
  );

  app.get('/health', async () => ({ ok: true }));

  /**
   * Traducao unica de erro. Nenhum service toca em `reply`; eles lancam AppError
   * e este handler decide o status.
   */
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ code: err.code, message: err.message });
    }

    if (err instanceof ZodError) {
      return reply.code(400).send({
        code: 'VALIDACAO',
        message: 'dados invalidos',
        campos: err.flatten().fieldErrors,
      });
    }

    // Qualquer outra coisa e bug nosso. Loga inteiro, devolve nada.
    req.log.error({ err }, 'erro nao tratado');
    return reply.code(500).send({ code: 'ERRO_INTERNO', message: 'erro interno' });
  });

  return app;
}
