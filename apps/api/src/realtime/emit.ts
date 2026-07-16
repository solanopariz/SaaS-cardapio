/**
 * Emissores tipados. UNICO lugar do backend que chama `io.emit`.
 *
 * REGRA 1 — emitir DEPOIS do commit, nunca dentro da transacao:
 *
 *     const payload = await prisma.$transaction(async (tx) => { ... });
 *     emitirPedidoNovo(payload);   // <- so aqui, com a transacao ja commitada
 *
 * Emitir dentro da transacao e depois dar rollback poe a cozinha a preparar um
 * pedido que nao existe no banco. O socket nao tem rollback.
 *
 * REGRA 2 — emit que falha NAO derruba o request. Corolario da regra 1: quando
 * estas funcoes rodam, o COMMIT ja aconteceu e o estado no banco e verdade.
 * Lancar aqui devolveria 500 para uma operacao que deu certo — o cliente
 * acharia que nao tem comanda, tendo. E nao desfaria nada: nao ha rollback a
 * dar. Entao a falha e logada e engolida.
 *
 * Isto e coerente com o que o resto do sistema ja assume: o socket nao e fonte
 * de verdade, o estado inicial vem sempre por HTTP, e o `reconnect` invalida
 * tudo justamente porque eventos perdidos nao sao recuperaveis por fila.
 * Um emit que falha e um evento perdido — categoria que o cliente ja sabe
 * tratar via refetch.
 */

import {
  EV,
  ROOM_CAIXA,
  ROOM_COZINHA,
  roomComanda,
  type ComandaFechadaPayload,
  type ContaSolicitadaPayload,
  type ItemCanceladoPayload,
  type MesaStatusPayload,
  type PedidoPayload,
  type PedidoStatusPayload,
} from '@cardapio/shared';
import { getIo, type TypedServer } from './io.js';

interface LogEventos {
  error: (obj: Record<string, unknown>, msg: string) => void;
}

// console ate o server.ts injetar o logger do Fastify. Nos testes, que sobem o
// app sem `criarIo`, este default e o que mantem o console legivel.
let log: LogEventos = {
  error: (obj, msg) => console.error(msg, obj),
};

export function configurarLogEventos(l: LogEventos): void {
  log = l;
}

/**
 * Envelope unico: resolve o `io` e entrega, e se qualquer coisa estourar,
 * loga em vez de propagar. Ver REGRA 2 no topo.
 */
function emitir(evento: string, entregar: (io: TypedServer) => void): void {
  try {
    entregar(getIo());
  } catch (err) {
    log.error(
      { err, evento },
      'emit falhou; o commit ja ocorreu e o banco esta correto. O cliente se ' +
        'realinha no proximo refetch/reconnect.',
    );
  }
}

/**
 * Pedido novo: a cozinha para produzir, o caixa para o total do grid.
 *
 * O cliente NAO entra aqui: ele ja tem a resposta do POST.
 *
 * O caixa entrou depois de o painel dele ser dirigido no navegador. Antes,
 * `pedido:novo` ia so para a cozinha — mas a `CaixaPage` tem
 * `staleTime: Infinity` ("o socket empurra") e o `useSocket` invalida as mesas
 * ao receber este evento, com o comentario "e barato, so o caixa escuta".
 * O caixa nao escutava. O total do grid ficava congelado o servico inteiro:
 * medido em R$ 65,70 enquanto o banco ja dizia R$ 69,70, e so um F5 corrigia.
 *
 * Nao era risco de dinheiro (o dialogo de fechamento refaz o fetch, e o
 * `fecharComanda` recalcula no servidor) — era o numero que o caixa olha de
 * relance estar errado o tempo todo.
 */
export function emitirPedidoNovo(p: PedidoPayload): void {
  emitir(EV.PEDIDO_NOVO, (io) => io.to([ROOM_COZINHA, ROOM_CAIXA]).emit(EV.PEDIDO_NOVO, p));
}

/** Status mudou: a cozinha atualiza o card, o cliente ve "seu pedido esta pronto". */
export function emitirPedidoStatus(p: PedidoStatusPayload): void {
  emitir(EV.PEDIDO_STATUS, (io) =>
    io.to([ROOM_COZINHA, roomComanda(p.comandaId)]).emit(EV.PEDIDO_STATUS, p),
  );
}

/**
 * Cancelamento DERRUBA o total. Por isso o caixa entra aqui e nao no
 * `pedido:status` comum: RECEBIDO -> EM_PREPARO nao mexe em dinheiro nenhum, e
 * mandar isso ao caixa seria trafego puro.
 *
 * A regra que decide quem recebe o que nao e "quem tem interesse" — e "o que
 * muda o numero na tela de quem".
 */
export function emitirPedidoCancelado(p: PedidoStatusPayload): void {
  emitir(EV.PEDIDO_CANCELADO, (io) =>
    io.to([ROOM_COZINHA, ROOM_CAIXA, roomComanda(p.comandaId)]).emit(EV.PEDIDO_CANCELADO, p),
  );
}

/** Idem: estorno de item muda o total do grid do caixa. */
export function emitirItemCancelado(p: ItemCanceladoPayload): void {
  emitir(EV.ITEM_CANCELADO, (io) =>
    io.to([ROOM_COZINHA, ROOM_CAIXA, roomComanda(p.comandaId)]).emit(EV.ITEM_CANCELADO, p),
  );
}

/** O cliente pediu a conta. Acende no painel do caixa. */
export function emitirContaSolicitada(p: ContaSolicitadaPayload): void {
  emitir(EV.CONTA_SOLICITADA, (io) => io.to(ROOM_CAIXA).emit(EV.CONTA_SOLICITADA, p));
}

export function emitirMesaStatus(p: MesaStatusPayload): void {
  emitir(EV.MESA_STATUS, (io) => io.to([ROOM_CAIXA, ROOM_COZINHA]).emit(EV.MESA_STATUS, p));
}

/**
 * Caixa fechou. O celular do cliente recebe, limpa o localStorage e volta a
 * tela inicial — a mesa se auto-libera no dispositivo, sem polling.
 *
 * Se o celular estava offline nesse instante, ele descobre no proximo
 * `GET /comandas/me`, que responde 410 Gone.
 */
export function emitirComandaFechada(p: ComandaFechadaPayload): void {
  emitir(EV.COMANDA_FECHADA, (io) =>
    io.to([ROOM_CAIXA, roomComanda(p.comandaId)]).emit(EV.COMANDA_FECHADA, p),
  );
}
