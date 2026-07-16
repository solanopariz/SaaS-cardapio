import { Prisma } from '@prisma/client';
import {
  podeTransicionar,
  type CriarPedido,
  type PedidoPayload,
  type StatusPedido,
} from '@cardapio/shared';
import { prisma } from '../../lib/prisma.js';
import {
  conflito,
  naoEncontrado,
  requisicaoInvalida,
  PRISMA_UNIQUE_VIOLATION,
} from '../../lib/errors.js';
import type { TokenComanda } from '../../plugins/auth.js';

/** Shape de leitura reutilizado em todo lugar que devolve um pedido ao painel. */
const INCLUDE_PEDIDO = {
  itens: {
    include: {
      produto: { select: { nome: true } },
      participante: { select: { apelido: true } },
    },
  },
  comanda: { select: { mesa: { select: { numero: true } } } },
} satisfies Prisma.PedidoInclude;

type PedidoCompleto = Prisma.PedidoGetPayload<{ include: typeof INCLUDE_PEDIDO }>;

export function paraPayload(p: PedidoCompleto): PedidoPayload {
  return {
    id: p.id,
    comandaId: p.comandaId,
    mesaNumero: p.comanda.mesa.numero,
    seq: p.seq,
    status: p.status,
    criadoEm: p.criadoEm.toISOString(),
    itens: p.itens.map((i) => ({
      id: i.id,
      produtoId: i.produtoId,
      produtoNome: i.produto.nome,
      qtd: i.qtd,
      precoUnitarioCentavos: i.precoUnitarioCentavos,
      observacao: i.observacao,
      participanteApelido: i.participante?.apelido ?? 'mesa',
      canceladoEm: i.canceladoEm?.toISOString() ?? null,
    })),
  };
}

export interface ResultadoCriarPedido {
  pedido: PedidoPayload;
  /** false quando a chave de idempotencia ja existia — nada foi criado. */
  criado: boolean;
}

/**
 * Assinatura canonica do que o cliente PEDIU. Serve para decidir se um POST
 * repetido com a mesma `Idempotency-Key` e a mesma intencao ou outra.
 *
 * Ordem nao entra: o mesmo carrinho reenviado com os itens embaralhados
 * continua sendo o mesmo pedido.
 *
 * Preco NAO entra: e snapshot decidido pelo servidor, nao vem do cliente. Se o
 * cardapio mudou de preco entre a tentativa e o retry, isso nao torna o pedido
 * "outro" — a comanda ja aberta nao muda de valor, e essa e a regra da casa.
 *
 * `canceladoEm` NAO entra: se a cozinha cancelou o item entre a tentativa e o
 * retry, o retry continua sendo o mesmo pedido. Assinar o que aconteceu DEPOIS
 * faria o retry de uma rede lenta virar 409 por causa de uma acao da cozinha.
 */
function assinatura(
  itens: { produtoId: number; qtd: number; participanteId: number | null; observacao: string | null }[],
): string {
  return itens
    .map((i) => `${i.produtoId}:${i.qtd}:${i.participanteId ?? '-'}:${i.observacao ?? ''}`)
    .sort()
    .join('|');
}

/**
 * Mesma chave, conteudo diferente. Ver o comentario de `criarPedido`.
 *
 * 409 e nao 200: devolver o pedido antigo faria o item novo sumir em silencio —
 * o cliente veria sucesso, o carrinho limparia e a cozinha nunca saberia da
 * coca. Perda silenciosa de dado e o pior desfecho possivel aqui.
 */
function conteudoDivergente(): never {
  throw conflito(
    'IDEMPOTENCY_KEY_REUSADA',
    'esta Idempotency-Key ja foi usada com outros itens. O pedido original foi ' +
      'registrado; envie os itens novos com uma chave nova.',
  );
}

/**
 * Cria o pedido. Retorna o payload para o caller emitir DEPOIS do commit.
 * Este service nao emite nada.
 *
 * LOCK: a transacao abre com `SELECT ... FOR UPDATE` na comanda — o mesmo lock
 * que `fecharComanda` toma. Sem ele, dois bugs (ambos reproduzidos em teste
 * antes de existir este comentario):
 *
 * 1. DINHEIRO. Ler o status da comanda e inserir o pedido sao ~4 queries
 *    separadas. O caixa fechando a conta nessa janela commitava entre as duas:
 *    o pedido entrava numa comanda ja FECHADA, fora do total que acabara de
 *    ser gravado. A cozinha preparava, o cliente comia, ninguem cobrava.
 *    Travar a comanda antes de ler o status ordena os dois: ou o fechamento
 *    espera e soma este pedido, ou este pedido relê FECHADA e devolve 409.
 *
 * 2. SEQ. `aggregate(_max: seq) + 1` fora de lock: dois pedidos concorrentes
 *    calculavam o MESMO seq e um estourava em `@@unique([comandaId, seq])` —
 *    que o catch la embaixo nao trata (ele so conhece a colisao de
 *    idempotencyKey), virando 500. Quatro amigos pedindo junto: tres tomavam
 *    "erro interno". Sob o lock, cada um calcula o seq com acesso exclusivo.
 *
 * Custo: pedidos da MESMA comanda serializam. Sao ~10 pessoas numa mesa, e
 * mesas diferentes nao se tocam — o lock e por linha.
 */
export async function criarPedido(
  ctx: TokenComanda,
  input: CriarPedido,
  idempotencyKey: string,
): Promise<ResultadoCriarPedido> {
  // Retentativa do celular com a mesma chave: devolve o pedido existente.
  // Barato, fora da transacao, e cobre o caso comum (rede ruim, dedo duplo).
  const jaExiste = await prisma.pedido.findUnique({
    where: { comandaId_idempotencyKey: { comandaId: ctx.comandaId, idempotencyKey } },
    include: INCLUDE_PEDIDO,
  });
  if (jaExiste) {
    if (assinatura(jaExiste.itens) !== assinatura(input.itens)) conteudoDivergente();
    return { pedido: paraPayload(jaExiste), criado: false };
  }

  try {
    const pedido = await prisma.$transaction(async (tx) => {
      // Prisma nao expoe FOR UPDATE no query builder — precisa ser SQL cru.
      // A ORDEM importa: travar ANTES de ler o status. Ler antes e travar
      // depois deixaria a decisao ser tomada sobre um status ja obsoleto, que
      // era exatamente o bug.
      const travadas = await tx.$queryRaw<{ id: number; status: string }[]>`
        SELECT id, status FROM comandas WHERE id = ${ctx.comandaId} FOR UPDATE
      `;
      const comanda = travadas[0];
      if (!comanda) throw naoEncontrado('comanda');
      if (comanda.status !== 'ABERTA') {
        throw conflito('COMANDA_NAO_ABERTA', 'a conta desta mesa ja foi pedida ou fechada');
      }

      const produtoIds = [...new Set(input.itens.map((i) => i.produtoId))];
      // `categoria: { ativa: true }` espelha o filtro do GET /menu. Sem ele os
      // dois divergem: a categoria desativada some da tela mas continua
      // aceitando pedido, e um celular com o menu ja carregado (ou com o ETag
      // em cache, ate 30s) manda a bebida que o dono acabou de tirar do
      // cardapio — 201, e a cozinha imprime.
      const produtos = await tx.produto.findMany({
        where: { id: { in: produtoIds }, disponivel: true, categoria: { ativa: true } },
      });

      if (produtos.length !== produtoIds.length) {
        const achados = new Set(produtos.map((p) => p.id));
        const faltando = produtoIds.filter((id) => !achados.has(id));
        throw requisicaoInvalida(
          'PRODUTO_INDISPONIVEL',
          `produto(s) indisponivel(is): ${faltando.join(', ')}`,
        );
      }
      const precoDe = new Map(produtos.map((p) => [p.id, p.precoCentavos]));

      // Participantes precisam ser desta comanda. Sem isto, um cliente da mesa 14
      // poderia lancar itens no nome de alguem da mesa 15.
      const participanteIds = [
        ...new Set(input.itens.map((i) => i.participanteId).filter((x): x is number => x !== null)),
      ];
      if (participanteIds.length > 0) {
        const validos = await tx.participante.count({
          where: { id: { in: participanteIds }, comandaId: ctx.comandaId },
        });
        if (validos !== participanteIds.length) {
          throw requisicaoInvalida('PARTICIPANTE_INVALIDO', 'participante nao pertence a comanda');
        }
      }

      const agregado = await tx.pedido.aggregate({
        where: { comandaId: ctx.comandaId },
        _max: { seq: true },
      });
      const seq = (agregado._max.seq ?? 0) + 1;

      return tx.pedido.create({
        data: {
          comandaId: ctx.comandaId,
          seq,
          idempotencyKey,
          status: 'RECEBIDO', // direto para producao, sem fila de aprovacao
          itens: {
            create: input.itens.map((i) => ({
              produtoId: i.produtoId,
              participanteId: i.participanteId,
              qtd: i.qtd,
              observacao: i.observacao,
              // SNAPSHOT: se o cardapio subir de preco depois, esta comanda nao muda.
              precoUnitarioCentavos: precoDe.get(i.produtoId)!,
            })),
          },
        },
        include: INCLUDE_PEDIDO,
      });
    });

    return { pedido: paraPayload(pedido), criado: true };
  } catch (e) {
    // Duas requisicoes com a MESMA chave ao mesmo tempo: a primeira commitou
    // entre o nosso findUnique la em cima e o create. O unique
    // (comandaId, idempotencyKey) pegou a segunda. Devolve a que venceu — o
    // cliente nao percebe a corrida.
    //
    // A mesma checagem de conteudo da pre-checagem tem que existir AQUI: este e
    // o caminho concorrente, e sem ela o buraco continuaria aberto exatamente
    // quando as duas tentativas correm (que e quando o header e usado).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === PRISMA_UNIQUE_VIOLATION) {
      const vencedor = await prisma.pedido.findUnique({
        where: { comandaId_idempotencyKey: { comandaId: ctx.comandaId, idempotencyKey } },
        include: INCLUDE_PEDIDO,
      });
      if (vencedor) {
        if (assinatura(vencedor.itens) !== assinatura(input.itens)) conteudoDivergente();
        return { pedido: paraPayload(vencedor), criado: false };
      }
    }
    throw e;
  }
}

export async function listarPedidosCozinha(status: StatusPedido[]): Promise<PedidoPayload[]> {
  const pedidos = await prisma.pedido.findMany({
    where: { status: { in: status } },
    include: INCLUDE_PEDIDO,
    orderBy: { criadoEm: 'asc' }, // quem chegou primeiro sai primeiro
  });
  return pedidos.map(paraPayload);
}

/**
 * Avanca o status. A transicao valida vem de `podeTransicionar` (shared),
 * nunca de um `if` solto no handler.
 *
 * A leitura e a escrita acontecem na mesma transacao com `FOR UPDATE` implicito
 * via `update ... where status = atual`: se outro cozinheiro clicou primeiro,
 * o `updateMany` afeta 0 linhas e nos detectamos.
 */
export async function atualizarStatusPedido(
  pedidoId: number,
  novo: StatusPedido,
): Promise<PedidoPayload> {
  return prisma.$transaction(async (tx) => {
    const atual = await tx.pedido.findUnique({ where: { id: pedidoId } });
    if (!atual) throw naoEncontrado('pedido');

    if (!podeTransicionar(atual.status, novo)) {
      throw conflito(
        'TRANSICAO_INVALIDA',
        `nao e possivel ir de ${atual.status} para ${novo}`,
      );
    }

    // Guarda otimista: so atualiza se o status ainda for o que lemos.
    const { count } = await tx.pedido.updateMany({
      where: { id: pedidoId, status: atual.status },
      data: { status: novo },
    });
    if (count === 0) {
      throw conflito('CONCORRENCIA', 'outro operador mudou este pedido — recarregue');
    }

    const atualizado = await tx.pedido.findUniqueOrThrow({
      where: { id: pedidoId },
      include: INCLUDE_PEDIDO,
    });
    return paraPayload(atualizado);
  });
}

export async function cancelarPedido(pedidoId: number, motivo: string): Promise<PedidoPayload> {
  return prisma.$transaction(async (tx) => {
    const atual = await tx.pedido.findUnique({ where: { id: pedidoId } });
    if (!atual) throw naoEncontrado('pedido');
    if (!podeTransicionar(atual.status, 'CANCELADO')) {
      throw conflito('TRANSICAO_INVALIDA', `pedido ${atual.status} nao pode ser cancelado`);
    }

    const { count } = await tx.pedido.updateMany({
      where: { id: pedidoId, status: atual.status },
      data: { status: 'CANCELADO', motivoCancelamento: motivo },
    });
    if (count === 0) throw conflito('CONCORRENCIA', 'outro operador mudou este pedido');

    // Itens do pedido cancelado tambem saem da conta.
    await tx.pedidoItem.updateMany({
      where: { pedidoId, canceladoEm: null },
      data: { canceladoEm: new Date(), motivoCancelamento: motivo },
    });

    const atualizado = await tx.pedido.findUniqueOrThrow({
      where: { id: pedidoId },
      include: INCLUDE_PEDIDO,
    });
    return paraPayload(atualizado);
  });
}

export interface ResultadoCancelarItem {
  itemId: number;
  pedidoId: number;
  comandaId: number;
  pedidoCancelado: boolean;
}

/**
 * Estorno pontual: "acabou o queijo, tira o pao de queijo".
 *
 * Se era o ULTIMO item ativo do pedido, o pedido inteiro vai a CANCELADO na
 * mesma transacao — um pedido sem nenhum item cobravel nao faz sentido no
 * painel da cozinha.
 */
export async function cancelarItem(
  itemId: number,
  motivo: string,
): Promise<ResultadoCancelarItem> {
  return prisma.$transaction(async (tx) => {
    const item = await tx.pedidoItem.findUnique({
      where: { id: itemId },
      include: { pedido: { select: { id: true, comandaId: true, status: true } } },
    });
    if (!item) throw naoEncontrado('item');
    if (item.canceladoEm) throw conflito('ITEM_JA_CANCELADO', 'este item ja foi estornado');
    if (item.pedido.status === 'CANCELADO') {
      throw conflito('PEDIDO_CANCELADO', 'o pedido inteiro ja foi cancelado');
    }

    const { count } = await tx.pedidoItem.updateMany({
      where: { id: itemId, canceladoEm: null },
      data: { canceladoEm: new Date(), motivoCancelamento: motivo },
    });
    if (count === 0) throw conflito('CONCORRENCIA', 'este item acabou de ser estornado');

    const ativosRestantes = await tx.pedidoItem.count({
      where: { pedidoId: item.pedidoId, canceladoEm: null },
    });

    let pedidoCancelado = false;
    if (ativosRestantes === 0 && podeTransicionar(item.pedido.status, 'CANCELADO')) {
      await tx.pedido.update({
        where: { id: item.pedidoId },
        data: { status: 'CANCELADO', motivoCancelamento: 'todos os itens estornados' },
      });
      pedidoCancelado = true;
    }

    return {
      itemId,
      pedidoId: item.pedidoId,
      comandaId: item.pedido.comandaId,
      pedidoCancelado,
    };
  });
}
