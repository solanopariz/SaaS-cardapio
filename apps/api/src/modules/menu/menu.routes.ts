import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';

/**
 * O cardapio e a rota mais chamada e a que menos muda. Toda mesa que senta
 * carrega ela inteira.
 *
 * ETag sobre o conteudo: o celular manda If-None-Match e recebe 304 sem corpo.
 * Publica e cacheavel — nao ha nada de privado num cardapio.
 *
 * Nao exige token: o cliente busca o menu antes mesmo de entrar na comanda.
 */
export async function menuRoutes(app: FastifyInstance): Promise<void> {
  app.get('/menu', async (req, reply) => {
    const categorias = await prisma.categoria.findMany({
      where: { ativa: true },
      orderBy: { ordem: 'asc' },
      include: {
        produtos: {
          where: { disponivel: true },
          orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
          select: {
            id: true,
            nome: true,
            descricao: true,
            precoCentavos: true,
            imagemUrl: true,
          },
        },
      },
    });

    // Categoria sem produto disponivel nao aparece.
    const payload = categorias.filter((c) => c.produtos.length > 0);

    const etag = `"${createHash('sha1').update(JSON.stringify(payload)).digest('hex')}"`;

    if (req.headers['if-none-match'] === etag) {
      return reply.code(304).send();
    }

    return reply
      .header('ETag', etag)
      .header('Cache-Control', 'public, max-age=30, must-revalidate')
      .send(payload);
  });
}
