/**
 * Aritmetica de dinheiro. Funcoes puras.
 *
 * Dinheiro e SEMPRE inteiro em centavos. Nunca float, nunca `number` com
 * decimal, nunca `parseFloat`. 0.1 + 0.2 !== 0.3 e ninguem quer descobrir isso
 * fechando o caixa.
 *
 * O total de uma comanda ABERTA nunca e armazenado — e derivado destas funcoes.
 * Total denormalizado + concorrencia = divergencia silenciosa na hora de cobrar.
 * So no fechamento gravamos `comandas.total_centavos`, como recibo imutavel.
 */

import type { StatusPedido } from './status.js';

export interface ItemCobravel {
  qtd: number;
  /**
   * Snapshot do preco no momento do pedido, nao o preco atual do produto.
   * Se o dono sobe o preco da coxinha as 15h, a comanda aberta as 14h nao muda.
   */
  precoUnitarioCentavos: number;
  canceladoEm: Date | string | null;
}

export interface PedidoCobravel {
  status: StatusPedido;
  itens: readonly ItemCobravel[];
}

/** Item entra na conta se nao foi estornado. */
export function itemEhCobravel(item: ItemCobravel): boolean {
  return item.canceladoEm === null;
}

/** Pedido entra na conta se nao foi cancelado inteiro. */
export function pedidoEhCobravel(pedido: PedidoCobravel): boolean {
  return pedido.status !== 'CANCELADO';
}

export function subtotalItem(item: ItemCobravel): number {
  return item.qtd * item.precoUnitarioCentavos;
}

/** Soma de itens nao cancelados. */
export function calcularTotalItens(itens: readonly ItemCobravel[]): number {
  return itens.filter(itemEhCobravel).reduce((acc, i) => acc + subtotalItem(i), 0);
}

/**
 * Total da comanda: ignora pedidos cancelados E itens estornados dentro de
 * pedidos ativos. Este e o numero que o caixa cobra.
 */
export function calcularTotalComanda(pedidos: readonly PedidoCobravel[]): number {
  return pedidos
    .filter(pedidoEhCobravel)
    .reduce((acc, p) => acc + calcularTotalItens(p.itens), 0);
}

/**
 * Total por participante — a divisao da conta que o caixa confere.
 * Chave e o apelido; itens sem participante caem em `compartilhado`.
 */
export function calcularTotalPorParticipante<
  T extends ItemCobravel & { participanteApelido: string | null },
>(pedidos: readonly (PedidoCobravel & { itens: readonly T[] })[]): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const pedido of pedidos) {
    if (!pedidoEhCobravel(pedido)) continue;
    for (const item of pedido.itens) {
      if (!itemEhCobravel(item)) continue;
      const chave = item.participanteApelido ?? 'compartilhado';
      mapa.set(chave, (mapa.get(chave) ?? 0) + subtotalItem(item));
    }
  }
  return mapa;
}

/**
 * "19,90" -> 1990. O inverso de `formatarBRL`, para o admin digitar preco.
 * `null` = nao e um preco valido (quem chama decide o que dizer ao usuario).
 *
 * Nunca via parseFloat: `parseFloat('19.99') * 100` e 1998.9999999999998, e
 * arredondar isso e apostar. Aqui os centavos saem do PROPRIO texto, como
 * inteiro — os reais e os centavos nunca se encontram num float.
 *
 * Aceita virgula ou ponto: o teclado do balcao tem os dois e o operador nao
 * quer saber qual e o "certo".
 */
export function parsearBRL(texto: string): number | null {
  const limpo = texto.trim().replace(/^R\$\s*/u, '');
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/u.exec(limpo);
  if (!m) return null;
  // padEnd, nao padStart: "19,9" e dezenove e noventa, nao dezenove e nove.
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** Centavos -> "R$ 12,50". Formatacao, nao aritmetica. */
export function formatarBRL(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}
