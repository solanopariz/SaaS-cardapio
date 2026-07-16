import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { fecharComandaSchema } from '@cardapio/shared';
import { exigirComanda, exigirRole } from '../../plugins/auth.js';
import { emitirComandaFechada, emitirContaSolicitada, emitirMesaStatus } from '../../realtime/emit.js';
import {
  fecharComanda,
  listarMesas,
  obterComandaDoCaixa,
  obterComandaDoCliente,
  pedirConta,
} from './comanda.service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

export async function comandaRoutes(app: FastifyInstance): Promise<void> {
  // --- Cliente ------------------------------------------------------------

  /** 410 Gone se ja foi fechada. O front usa isso para limpar o localStorage. */
  app.get('/comandas/me', { preHandler: exigirComanda }, async (req) =>
    obterComandaDoCliente(req.comanda!.comandaId),
  );

  app.post('/comandas/me/conta', { preHandler: exigirComanda }, async (req) => {
    const r = await pedirConta(req.comanda!.comandaId);

    // POS-COMMIT: acende no painel do caixa.
    emitirContaSolicitada({
      comandaId: r.comandaId,
      mesaNumero: r.mesaNumero,
      totalParcialCentavos: r.totalParcialCentavos,
    });
    emitirMesaStatus({
      mesaId: r.mesaId,
      numero: r.mesaNumero,
      status: 'AGUARDANDO_FECHAMENTO',
      comandaId: r.comandaId,
    });

    return r;
  });

  // --- Painel do caixa -----------------------------------------------------

  app.get('/caixa/mesas', { preHandler: exigirRole('CAIXA') }, async () => listarMesas());

  app.get('/caixa/comandas/:id', { preHandler: exigirRole('CAIXA') }, async (req) => {
    const { id } = idParam.parse(req.params);
    return obterComandaDoCaixa(id);
  });

  app.post('/caixa/comandas/:id/fechar', { preHandler: exigirRole('CAIXA') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const input = fecharComandaSchema.parse(req.body);

    const r = await fecharComanda(id, req.staff!.usuarioId, input);

    // POS-COMMIT. O celular do cliente recebe, limpa o storage e volta ao inicio.
    emitirComandaFechada({
      comandaId: r.comandaId,
      mesaNumero: r.mesaNumero,
      totalCentavos: r.totalCentavos,
    });
    emitirMesaStatus({ mesaId: r.mesaId, numero: r.mesaNumero, status: 'LIVRE', comandaId: null });

    return r;
  });
}
