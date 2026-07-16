import {
  calcularTotalComanda,
  calcularTotalPorParticipante,
  type FecharComanda,
  type PedidoPayload,
} from '@cardapio/shared';
import { prisma } from '../../lib/prisma.js';
import { comandaFechada, conflito, naoEncontrado, requisicaoInvalida } from '../../lib/errors.js';
import { paraPayload } from '../pedido/pedido.service.js';

const INCLUDE_COMANDA = {
  mesa: true,
  participantes: true,
  pedidos: {
    include: {
      itens: {
        include: {
          produto: { select: { nome: true } },
          participante: { select: { apelido: true } },
        },
      },
      comanda: { select: { mesa: { select: { numero: true } } } },
    },
    orderBy: { seq: 'asc' as const },
  },
} as const;

export interface ComandaDetalhe {
  id: number;
  mesaNumero: number;
  status: string;
  abertaEm: string;
  pedidos: PedidoPayload[];
  totalCentavos: number;
  totalPorParticipante: Record<string, number>;
  participantes: { id: number; apelido: string }[];
}

function montarDetalhe(c: Awaited<ReturnType<typeof buscarBruta>>): ComandaDetalhe {
  const pedidos = c!.pedidos.map(paraPayload);

  // O total NUNCA vem do banco enquanto a comanda esta aberta — e derivado.
  const paraCalculo = c!.pedidos.map((p) => ({
    status: p.status,
    itens: p.itens.map((i) => ({
      qtd: i.qtd,
      precoUnitarioCentavos: i.precoUnitarioCentavos,
      canceladoEm: i.canceladoEm,
      participanteApelido: i.participante?.apelido ?? null,
    })),
  }));

  return {
    id: c!.id,
    mesaNumero: c!.mesa.numero,
    status: c!.status,
    abertaEm: c!.abertaEm.toISOString(),
    pedidos,
    totalCentavos: calcularTotalComanda(paraCalculo),
    totalPorParticipante: Object.fromEntries(calcularTotalPorParticipante(paraCalculo)),
    participantes: c!.participantes.map((p) => ({ id: p.id, apelido: p.apelido })),
  };
}

function buscarBruta(id: number) {
  return prisma.comanda.findUnique({ where: { id }, include: INCLUDE_COMANDA });
}

/**
 * `GET /comandas/me`. O 410 e o contrato com o front: significa "existia, acabou".
 * Nao e 404 — 404 diria "nunca existiu" e o celular ficaria tentando de novo.
 */
export async function obterComandaDoCliente(comandaId: number): Promise<ComandaDetalhe> {
  const c = await buscarBruta(comandaId);
  if (!c) throw naoEncontrado('comanda');
  if (c.status === 'FECHADA' || c.status === 'CANCELADA') throw comandaFechada();
  return montarDetalhe(c);
}

export async function obterComandaDoCaixa(comandaId: number): Promise<ComandaDetalhe> {
  const c = await buscarBruta(comandaId);
  if (!c) throw naoEncontrado('comanda');
  return montarDetalhe(c); // o caixa PODE ver comanda fechada (reimprimir recibo)
}

export interface ResultadoPedirConta {
  comandaId: number;
  mesaId: number;
  mesaNumero: number;
  totalParcialCentavos: number;
}

export async function pedirConta(comandaId: number): Promise<ResultadoPedirConta> {
  return prisma.$transaction(async (tx) => {
    const c = await tx.comanda.findUnique({
      where: { id: comandaId },
      include: { mesa: true, pedidos: { include: { itens: true } } },
    });
    if (!c) throw naoEncontrado('comanda');
    if (c.status === 'FECHADA' || c.status === 'CANCELADA') throw comandaFechada();

    // Idempotente de graca: clicar "pedir a conta" duas vezes nao e erro.
    if (c.status === 'ABERTA') {
      await tx.comanda.update({
        where: { id: comandaId },
        data: { status: 'AGUARDANDO_PAGAMENTO' },
      });
      await tx.mesa.update({
        where: { id: c.mesaId },
        data: { status: 'AGUARDANDO_FECHAMENTO' },
      });
    }

    return {
      comandaId,
      mesaId: c.mesaId,
      mesaNumero: c.mesa.numero,
      totalParcialCentavos: calcularTotalComanda(c.pedidos),
    };
  });
}

export interface ResultadoFechar {
  comandaId: number;
  mesaId: number;
  mesaNumero: number;
  totalCentavos: number;
  trocoCentavos: number | null;
}

/**
 * Fecha a conta e libera a mesa.
 *
 * `SELECT ... FOR UPDATE` na comanda antes de qualquer coisa. Dois caixas
 * clicando "fechar" no mesmo instante: o segundo bloqueia no lock, e quando
 * entra, le `status = FECHADA` e recebe 409. Sem o lock, ambos leriam
 * AGUARDANDO_PAGAMENTO, ambos somariam, ambos gravariam — e a mesa seria
 * liberada duas vezes, com dois recibos.
 *
 * O pagamento em si e processado FORA do sistema (maquininha). `metodo` e
 * registro contabil, nao integracao.
 */
export async function fecharComanda(
  comandaId: number,
  usuarioId: number,
  input: FecharComanda,
): Promise<ResultadoFechar> {
  return prisma.$transaction(async (tx) => {
    // Prisma nao expoe FOR UPDATE no query builder — precisa ser SQL cru.
    const travadas = await tx.$queryRaw<{ id: number; status: string; mesa_id: number }[]>`
      SELECT id, status, mesa_id FROM comandas WHERE id = ${comandaId} FOR UPDATE
    `;
    const travada = travadas[0];
    if (!travada) throw naoEncontrado('comanda');

    if (travada.status === 'FECHADA') {
      throw conflito('COMANDA_JA_FECHADA', 'esta comanda ja foi fechada por outro operador');
    }
    if (travada.status === 'CANCELADA') {
      throw conflito('COMANDA_CANCELADA', 'esta comanda foi cancelada');
    }

    const pedidos = await tx.pedido.findMany({
      where: { comandaId },
      include: { itens: true },
    });
    const totalCentavos = calcularTotalComanda(pedidos);

    // A conta mudou entre a tela e o clique: um pedido novo entrou pelo socket
    // enquanto o dialogo estava aberto. O total aqui dentro esta CERTO — mas o
    // operador combinou outro numero com o cliente, e o troco sairia do bolso
    // de alguem. Recusar e mandar reler.
    //
    // Antes do VALOR_INSUFICIENTE de proposito: se a conta mudou, dizer "faltou
    // dinheiro" manda o operador buscar mais notas em vez de reler a conta.
    if (totalCentavos !== input.totalEsperadoCentavos) {
      throw conflito(
        'TOTAL_MUDOU',
        `a conta mudou: a tela mostrava ${input.totalEsperadoCentavos}, o total agora e ${totalCentavos}`,
      );
    }

    let trocoCentavos: number | null = null;
    if (input.metodo === 'DINHEIRO') {
      const recebido = input.valorRecebidoCentavos!; // garantido pelo refine do Zod
      if (recebido < totalCentavos) {
        throw requisicaoInvalida('VALOR_INSUFICIENTE', 'valor recebido menor que o total');
      }
      trocoCentavos = recebido - totalCentavos;
    }

    const mesa = await tx.mesa.findUniqueOrThrow({ where: { id: travada.mesa_id } });

    await tx.comanda.update({
      where: { id: comandaId },
      data: {
        status: 'FECHADA',
        totalCentavos,
        metodoPagamento: input.metodo,
        fechadaEm: new Date(),
        fechadaPorUsuarioId: usuarioId,
      },
    });

    // Mesa volta a LIVRE. O indice parcial `uniq_comanda_aberta` agora permite
    // uma comanda nova nesta mesa — o mesmo QR impresso serve o proximo cliente.
    await tx.mesa.update({ where: { id: mesa.id }, data: { status: 'LIVRE' } });

    return { comandaId, mesaId: mesa.id, mesaNumero: mesa.numero, totalCentavos, trocoCentavos };
  });
}

export interface MesaResumo {
  id: number;
  numero: number;
  status: string;
  comandaId: number | null;
  totalParcialCentavos: number;
  abertaEm: string | null;
}

/** Grid do painel do caixa. */
export async function listarMesas(): Promise<MesaResumo[]> {
  const mesas = await prisma.mesa.findMany({
    orderBy: { numero: 'asc' },
    include: {
      comandas: {
        where: { status: { in: ['ABERTA', 'AGUARDANDO_PAGAMENTO'] } },
        include: { pedidos: { include: { itens: true } } },
      },
    },
  });

  return mesas.map((m) => {
    const c = m.comandas[0] ?? null;
    return {
      id: m.id,
      numero: m.numero,
      status: m.status,
      comandaId: c?.id ?? null,
      totalParcialCentavos: c ? calcularTotalComanda(c.pedidos) : 0,
      abertaEm: c?.abertaEm.toISOString() ?? null,
    };
  });
}
