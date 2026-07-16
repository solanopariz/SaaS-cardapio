import type { z } from 'zod';
import type {
  categoriaSchema,
  categoriaUpdateSchema,
  produtoSchema,
  produtoUpdateSchema,
} from '@cardapio/shared';
import { prisma } from '../../lib/prisma.js';
import { naoEncontrado, requisicaoInvalida } from '../../lib/errors.js';

/**
 * CRUD do cardapio. Duas regras moldam tudo aqui:
 *
 * 1. NAO EXISTE DELETE. `PedidoItem.produto` e `onDelete: Restrict` e isso e
 *    proposital: apagar um produto vendido apagaria o passado. Sair do cardapio
 *    e `disponivel: false` (produto) / `ativa: false` (categoria) — os campos
 *    ja existiam e o /menu ja os respeitava.
 *
 * 2. Mudar o preco NAO mexe em comanda aberta. Quem cobra e o snapshot em
 *    `PedidoItem.precoUnitarioCentavos`, copiado no instante do pedido. O
 *    cliente paga o preco que estava na tela quando pediu.
 */

/**
 * Tira as chaves `undefined` do PATCH antes de entregar ao Prisma.
 *
 * `{ nome: undefined }` e `{}` sao a mesma intencao — "nao mexe no nome" — mas
 * sob `exactOptionalPropertyTypes` sao tipos diferentes, e o Prisma so aceita o
 * segundo. Apagar a chave e o que o schema de PATCH ja quer dizer; o cast
 * seria so esconder a diferenca do compilador.
 */
type SoDefinidos<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

function definidos<T extends object>(o: T): SoDefinidos<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as SoDefinidos<T>;
}

type NovaCategoria = z.infer<typeof categoriaSchema>;
type PatchCategoria = z.infer<typeof categoriaUpdateSchema>;
type NovoProduto = z.infer<typeof produtoSchema>;
type PatchProduto = z.infer<typeof produtoUpdateSchema>;

/**
 * Diferente do /menu: devolve TUDO, inclusive inativo e indisponivel. O admin
 * precisa enxergar o que escondeu para poder trazer de volta — um filtro aqui
 * deixaria o produto esgotado invisivel para a unica tela capaz de reativa-lo.
 */
export async function listarCardapio() {
  return prisma.categoria.findMany({
    orderBy: [{ ordem: 'asc' }, { id: 'asc' }],
    include: {
      produtos: { orderBy: [{ ordem: 'asc' }, { nome: 'asc' }] },
    },
  });
}

export async function criarCategoria(input: NovaCategoria) {
  return prisma.categoria.create({ data: input });
}

export async function atualizarCategoria(id: number, input: PatchCategoria) {
  await acharCategoria(id);
  return prisma.categoria.update({ where: { id }, data: definidos(input) });
}

export async function criarProduto(input: NovoProduto) {
  await acharCategoria(input.categoriaId);
  return prisma.produto.create({ data: input });
}

export async function atualizarProduto(id: number, input: PatchProduto) {
  const existe = await prisma.produto.findUnique({ where: { id } });
  if (!existe) throw naoEncontrado('produto');

  // Mover de categoria e permitido, mas a categoria de destino tem que existir.
  // Sem esta checagem o Prisma levantaria P2003 (foreign key) e o error handler
  // devolveria 500 — um erro do admin virando bug nosso no log.
  if (input.categoriaId !== undefined) await acharCategoria(input.categoriaId);

  return prisma.produto.update({ where: { id }, data: definidos(input) });
}

async function acharCategoria(id: number) {
  const c = await prisma.categoria.findUnique({ where: { id } });
  if (!c) throw requisicaoInvalida('CATEGORIA_INEXISTENTE', `categoria ${id} nao existe`);
  return c;
}
