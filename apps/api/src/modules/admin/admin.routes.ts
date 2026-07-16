import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  categoriaSchema,
  categoriaUpdateSchema,
  produtoSchema,
  produtoUpdateSchema,
} from '@cardapio/shared';
import { exigirRole } from '../../plugins/auth.js';
import {
  atualizarCategoria,
  atualizarProduto,
  criarCategoria,
  criarProduto,
  listarCardapio,
} from './admin.service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

/**
 * Sem DELETE de proposito — ver admin.service.ts. "Tirar do cardapio" e um
 * PATCH de `disponivel`/`ativa`.
 *
 * Nao ha emissao de socket aqui: o /menu e cacheado por ETag sobre o conteudo,
 * entao qualquer edicao ja muda o hash e o proximo revalidate (max-age=30)
 * entrega o cardapio novo sozinho.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const soAdmin = { preHandler: exigirRole('ADMIN') };

  app.get('/admin/cardapio', soAdmin, async () => listarCardapio());

  // --- Categorias ----------------------------------------------------------

  app.post('/admin/categorias', soAdmin, async (req, reply) =>
    reply.code(201).send(await criarCategoria(categoriaSchema.parse(req.body))),
  );

  app.patch('/admin/categorias/:id', soAdmin, async (req) => {
    const { id } = idParam.parse(req.params);
    return atualizarCategoria(id, categoriaUpdateSchema.parse(req.body));
  });

  // --- Produtos ------------------------------------------------------------

  app.post('/admin/produtos', soAdmin, async (req, reply) =>
    reply.code(201).send(await criarProduto(produtoSchema.parse(req.body))),
  );

  app.patch('/admin/produtos/:id', soAdmin, async (req) => {
    const { id } = idParam.parse(req.params);
    return atualizarProduto(id, produtoUpdateSchema.parse(req.body));
  });
}
