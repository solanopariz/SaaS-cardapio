import type { FastifyInstance } from 'fastify';
import { joinSessaoSchema } from '@cardapio/shared';
import { join } from './sessao.service.js';

export async function sessaoRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Unica rota do cliente sem token. A credencial e o par (mesa, k) que veio
   * do QR impresso.
   */
  app.post('/sessions/join', async (req, reply) => {
    const input = joinSessaoSchema.parse(req.body);
    const r = await join(input);
    return reply.code(r.comandaNova ? 201 : 200).send(r);
  });
}
