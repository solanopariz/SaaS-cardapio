import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  atualizarStatusPedidoSchema,
  cancelarSchema,
  criarPedidoSchema,
  idempotencyKeySchema,
  STATUS_ATIVOS_COZINHA,
  STATUS_PEDIDO,
  type StatusPedido,
} from '@cardapio/shared';
import { exigirComanda, exigirRole } from '../../plugins/auth.js';
import { requisicaoInvalida } from '../../lib/errors.js';
import {
  emitirItemCancelado,
  emitirPedidoCancelado,
  emitirPedidoNovo,
  emitirPedidoStatus,
} from '../../realtime/emit.js';
import {
  atualizarStatusPedido,
  cancelarItem,
  cancelarPedido,
  criarPedido,
  listarPedidosCozinha,
} from './pedido.service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

export async function pedidoRoutes(app: FastifyInstance): Promise<void> {
  // --- Cliente ------------------------------------------------------------

  app.post('/comandas/me/pedidos', { preHandler: exigirComanda }, async (req, reply) => {
    const key = req.headers['idempotency-key'];
    const parsed = idempotencyKeySchema.safeParse(key);
    if (!parsed.success) {
      throw requisicaoInvalida(
        'IDEMPOTENCY_KEY_AUSENTE',
        'header Idempotency-Key (uuid) e obrigatorio',
      );
    }

    const input = criarPedidoSchema.parse(req.body);
    const { pedido, criado } = await criarPedido(req.comanda!, input, parsed.data);

    // POS-COMMIT. Retentativa (criado=false) nao reemite — a cozinha ja viu.
    if (criado) emitirPedidoNovo(pedido);

    return reply.code(criado ? 201 : 200).send(pedido);
  });

  // --- Painel da cozinha ---------------------------------------------------

  const statusQuery = z.object({
    status: z
      .string()
      .optional()
      .transform((s) => (s ? s.split(',') : undefined))
      .pipe(z.array(z.enum(STATUS_PEDIDO)).optional()),
  });

  /** Bootstrap do painel. O socket so aplica deltas depois disto. */
  app.get('/cozinha/pedidos', { preHandler: exigirRole('COZINHA') }, async (req) => {
    const { status } = statusQuery.parse(req.query);
    return listarPedidosCozinha((status ?? STATUS_ATIVOS_COZINHA) as StatusPedido[]);
  });

  app.patch('/pedidos/:id/status', { preHandler: exigirRole('COZINHA') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { status } = atualizarStatusPedidoSchema.parse(req.body);

    const pedido = await atualizarStatusPedido(id, status);

    emitirPedidoStatus({ id: pedido.id, comandaId: pedido.comandaId, status: pedido.status });
    return pedido;
  });

  app.post('/pedidos/:id/cancelar', { preHandler: exigirRole('COZINHA', 'CAIXA') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { motivo } = cancelarSchema.parse(req.body);

    const pedido = await cancelarPedido(id, motivo);

    emitirPedidoCancelado({ id: pedido.id, comandaId: pedido.comandaId, status: 'CANCELADO' });
    return pedido;
  });

  app.post('/itens/:id/cancelar', { preHandler: exigirRole('COZINHA', 'CAIXA') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { motivo } = cancelarSchema.parse(req.body);

    const r = await cancelarItem(id, motivo);

    emitirItemCancelado(r);
    // O item derrubou o pedido inteiro: a cozinha precisa tirar o card da tela.
    if (r.pedidoCancelado) {
      emitirPedidoCancelado({ id: r.pedidoId, comandaId: r.comandaId, status: 'CANCELADO' });
    }
    return r;
  });
}
