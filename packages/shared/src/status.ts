/**
 * Maquinas de estado do dominio. Funcoes puras, sem banco, sem IO.
 *
 * Vive em `shared` porque o front tambem precisa: o painel da cozinha usa
 * `proximoStatus` para desenhar o botao de avancar. Uma unica definicao das
 * transicoes validas, consumida pelos dois lados.
 */

export const STATUS_PEDIDO = [
  'RECEBIDO',
  'EM_PREPARO',
  'PRONTO',
  'ENTREGUE',
  'CANCELADO',
] as const;
export type StatusPedido = (typeof STATUS_PEDIDO)[number];

export const STATUS_COMANDA = [
  'ABERTA',
  'AGUARDANDO_PAGAMENTO',
  'FECHADA',
  'CANCELADA',
] as const;
export type StatusComanda = (typeof STATUS_COMANDA)[number];

export const STATUS_MESA = ['LIVRE', 'OCUPADA', 'AGUARDANDO_FECHAMENTO'] as const;
export type StatusMesa = (typeof STATUS_MESA)[number];

export const METODOS_PAGAMENTO = ['DINHEIRO', 'CREDITO', 'DEBITO', 'PIX', 'OUTRO'] as const;
export type MetodoPagamento = (typeof METODOS_PAGAMENTO)[number];

/**
 * Transicoes validas de um pedido.
 *
 * CANCELADO e alcancavel de qualquer estado exceto ENTREGUE: comida ja entregue
 * nao volta para a cozinha. Estornar item ja entregue e decisao do caixa, no
 * fechamento — nao do painel de producao.
 *
 * ENTREGUE e CANCELADO sao terminais.
 */
const TRANSICOES_PEDIDO: Readonly<Record<StatusPedido, readonly StatusPedido[]>> = {
  RECEBIDO: ['EM_PREPARO', 'CANCELADO'],
  EM_PREPARO: ['PRONTO', 'CANCELADO'],
  PRONTO: ['ENTREGUE', 'CANCELADO'],
  ENTREGUE: [],
  CANCELADO: [],
};

export function podeTransicionar(de: StatusPedido, para: StatusPedido): boolean {
  return TRANSICOES_PEDIDO[de].includes(para);
}

export function transicoesValidas(de: StatusPedido): readonly StatusPedido[] {
  return TRANSICOES_PEDIDO[de];
}

/**
 * O proximo status no caminho feliz (sem cancelamento). E o que o botao
 * "avancar" do painel da cozinha dispara. `null` em estado terminal.
 */
export function proximoStatus(de: StatusPedido): StatusPedido | null {
  const feliz = TRANSICOES_PEDIDO[de].filter((s) => s !== 'CANCELADO');
  return feliz[0] ?? null;
}

export function ehTerminal(status: StatusPedido): boolean {
  return TRANSICOES_PEDIDO[status].length === 0;
}

/** Pedidos que a cozinha precisa ver. Bootstrap do painel filtra por isto. */
export const STATUS_ATIVOS_COZINHA: readonly StatusPedido[] = [
  'RECEBIDO',
  'EM_PREPARO',
  'PRONTO',
];
