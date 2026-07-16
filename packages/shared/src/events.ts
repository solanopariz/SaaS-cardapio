/**
 * Nomes e payloads dos eventos de tempo real.
 *
 * Regra que sustenta a arquitetura: TODOS os eventos aqui sao servidor -> cliente.
 * O cliente nunca emite evento que muda estado. Mutacao e sempre HTTP:
 * transacional, validada e idempotente. O socket e um canal de leitura.
 *
 * Corolario: emita SEMPRE depois do COMMIT. Emitir dentro da transacao e depois
 * dar rollback poe a cozinha a preparar um pedido que nao existe.
 */

import type { StatusPedido, StatusMesa } from './status.js';

export const EV = {
  PEDIDO_NOVO: 'pedido:novo',
  PEDIDO_STATUS: 'pedido:status',
  PEDIDO_CANCELADO: 'pedido:cancelado',
  ITEM_CANCELADO: 'item:cancelado',
  CONTA_SOLICITADA: 'conta:solicitada',
  MESA_STATUS: 'mesa:status',
  COMANDA_FECHADA: 'comanda:fechada',
} as const;

export type NomeEvento = (typeof EV)[keyof typeof EV];

/** Rooms. O servidor decide quem entra onde, no handshake. Nunca o cliente. */
export const ROOM_COZINHA = 'cozinha';
export const ROOM_CAIXA = 'caixa';
export const roomComanda = (comandaId: number) => `comanda:${comandaId}` as const;

// --- Payloads -------------------------------------------------------------

export interface ItemPayload {
  id: number;
  produtoId: number;
  produtoNome: string;
  qtd: number;
  precoUnitarioCentavos: number;
  observacao: string | null;
  participanteApelido: string;
  canceladoEm: string | null;
}

export interface PedidoPayload {
  id: number;
  comandaId: number;
  mesaNumero: number;
  seq: number;
  status: StatusPedido;
  criadoEm: string;
  itens: ItemPayload[];
}

export interface PedidoStatusPayload {
  id: number;
  comandaId: number;
  status: StatusPedido;
}

export interface ItemCanceladoPayload {
  itemId: number;
  pedidoId: number;
  comandaId: number;
  /** true quando o item cancelado era o ultimo ativo e o pedido caiu junto */
  pedidoCancelado: boolean;
}

export interface ContaSolicitadaPayload {
  comandaId: number;
  mesaNumero: number;
  totalParcialCentavos: number;
}

export interface MesaStatusPayload {
  mesaId: number;
  numero: number;
  status: StatusMesa;
  comandaId: number | null;
}

export interface ComandaFechadaPayload {
  comandaId: number;
  mesaNumero: number;
  totalCentavos: number;
}

/** Contrato tipado do Socket.IO. Use em `Server<{}, ServerToClientEvents>`. */
export interface ServerToClientEvents {
  [EV.PEDIDO_NOVO]: (p: PedidoPayload) => void;
  [EV.PEDIDO_STATUS]: (p: PedidoStatusPayload) => void;
  [EV.PEDIDO_CANCELADO]: (p: PedidoStatusPayload) => void;
  [EV.ITEM_CANCELADO]: (p: ItemCanceladoPayload) => void;
  [EV.CONTA_SOLICITADA]: (p: ContaSolicitadaPayload) => void;
  [EV.MESA_STATUS]: (p: MesaStatusPayload) => void;
  [EV.COMANDA_FECHADA]: (p: ComandaFechadaPayload) => void;
}

/**
 * Vazio de proposito. Se um dia aparecer um evento cliente -> servidor aqui,
 * pare e pergunte se ele nao deveria ser um POST.
 */
export interface ClientToServerEvents {}
