import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { subirAmbiente, type Ambiente } from './helpers/ambiente.js';

/**
 * Ambiente SEMEADO — e a diferenca inteira deste arquivo.
 *
 * `admin.cardapio.test.ts` sobe o banco vazio e passa verde com um bug que
 * derruba a producao: o seed grava categorias com id EXPLICITO, a sequence do
 * Postgres nao avanca junto, e o primeiro `create` sem id colide com a PK da
 * primeira categoria semeada. Banco vazio nao tem com o que colidir.
 *
 * O estado semeado E o estado de producao. Testar so o banco vazio e testar um
 * ambiente que nao existe em lugar nenhum — foi assim que `cozinha@local`
 * sobreviveu ate o primeiro login de verdade.
 */
let amb: Ambiente;
let admin: string;

beforeAll(async () => {
  amb = await subirAmbiente({ semear: true });
  admin = amb.tokenStaff(1, 'ADMIN');
}, 240_000);

afterAll(async () => {
  await amb?.parar();
});

const aut = (t: string) => ({ authorization: `Bearer ${t}` });

function criar(nome: string) {
  return amb.app.inject({
    method: 'POST',
    url: '/api/admin/categorias',
    headers: aut(admin),
    payload: { nome },
  });
}

/** Categoria + um produto, que e o minimo para ela existir no `/menu`. */
async function criarComProduto(prefixo: string): Promise<number> {
  const cat = await criar(`${prefixo}-${randomUUID().slice(0, 6)}`);
  expect(cat.statusCode).toBe(201);
  const id = cat.json().id as number;

  const p = await amb.app.inject({
    method: 'POST',
    url: '/api/admin/produtos',
    headers: aut(admin),
    payload: {
      categoriaId: id,
      nome: `Item-${randomUUID().slice(0, 6)}`,
      precoCentavos: 1000,
    },
  });
  expect(p.statusCode).toBe(201);
  return id;
}

describe('criar categoria em cima do cardapio semeado', () => {
  it('o seed deixa categorias com id explicito', async () => {
    // Controle positivo do cenario: sem categorias semeadas, nao ha colisao
    // possivel e o resto deste arquivo nao provaria nada.
    const n = await amb.prisma.categoria.count();
    expect(n).toBeGreaterThan(0);
  });

  /**
   * O primeiro clique em "Criar categoria" que o dono da no painel.
   *
   * Sem o `setval` no fim do seed: nextval=1, colide com a PK da Padaria, 500.
   * E `nextval` nao volta atras nem em transacao abortada — entao o erro se
   * repete uma vez por categoria semeada e "some sozinho" na quinta tentativa.
   */
  it('a PRIMEIRA categoria criada pelo admin entra, sem 500', async () => {
    const r = await criar(`Sobremesas-${randomUUID().slice(0, 6)}`);

    expect(r.statusCode).toBe(201);
    expect(r.json().id).toBeGreaterThan(0);
  });

  /**
   * Uma por categoria semeada: se a sequence estiver dessincronizada, cada
   * tentativa queima um nextval e so a de indice N+1 passa. Um teste de UMA
   * criacao poderia passar por sorte se alguem "consertasse" com um retry.
   */
  it('varias seguidas entram, todas com id proprio', async () => {
    const rs = [];
    for (let i = 0; i < 6; i++) rs.push(await criar(`Cat-${randomUUID().slice(0, 6)}`));

    expect(rs.filter((r) => r.statusCode !== 201)).toHaveLength(0);
    expect(new Set(rs.map((r) => r.json().id)).size).toBe(6);
  });

  it('produto novo na categoria nova aparece no /menu', async () => {
    const cat = await criar(`Doces-${randomUUID().slice(0, 6)}`);
    expect(cat.statusCode).toBe(201);

    const p = await amb.app.inject({
      method: 'POST',
      url: '/api/admin/produtos',
      headers: aut(admin),
      payload: { categoriaId: cat.json().id, nome: `Pudim-${randomUUID().slice(0, 6)}`, precoCentavos: 1200 },
    });
    expect(p.statusCode).toBe(201);

    const menu = await amb.app.inject({ method: 'GET', url: '/api/menu' });
    const ids = (menu.json() as { produtos: { id: number }[] }[]).flatMap((c) =>
      c.produtos.map((x) => x.id),
    );
    expect(ids).toContain(p.json().id);
  });

  /**
   * A sequence de produtos nunca esteve quebrada — o seed cria produto sem id.
   * Este teste existe para que, se alguem um dia puser id explicito la tambem,
   * a queda apareca aqui e nao no balcao.
   */
  /**
   * CACADA — `ordem` e o default 0.
   *
   * `Categoria.ordem` e `Int @default(0)` e a tela de admin nao edita o campo.
   * O seed grava 1..4 (Padaria, Salgados, Pratos, Bebidas). Logo TODA categoria
   * criada pelo painel nasce com 0 — menor que qualquer semeada.
   *
   * Mesma forma da `categoria.ativa`: o default era inofensivo enquanto nada
   * criava categoria. O painel de admin e o que tornou o caminho alcancavel.
   */
  it('categoria nova nasce no TOPO do cardapio — e o dono consegue mover', async () => {
    const id = await criarComProduto('Sobremesas');

    // Posicao RELATIVA a Padaria, nao indice absoluto: outros testes deste
    // arquivo ja criaram categorias em ordem=0, e com o desempate por `id` a
    // nova entra atras delas. `toBe(0)` passaria a depender da ordem dos testes
    // — e ja me deu um vermelho aqui.
    const menuAgora = async () => {
      const menu = await amb.app.inject({ method: 'GET', url: '/api/menu' });
      const cats = menu.json() as { id: number; nome: string }[];
      return {
        nova: cats.findIndex((c) => c.id === id),
        padaria: cats.findIndex((c) => c.nome === 'Padaria'),
        ultima: cats.length - 1,
        ids: cats.map((c) => c.id).join(','),
      };
    };

    // O default 0 e menor que o 1..4 do seed: a categoria nova vem antes das
    // semeadas. Comportamento ACEITO (o default nao mudou nesta rodada) — o que
    // nao podia continuar era nao existir saida.
    const antes = await menuAgora();
    expect(antes.padaria, 'Padaria precisa estar no menu para servir de marco').toBeGreaterThan(-1);
    expect(
      antes.nova,
      `a categoria nova (ordem=0) deveria vir antes da Padaria (ordem=1). ids: ${antes.ids}`,
    ).toBeLessThan(antes.padaria);

    // A SAIDA: o painel edita `ordem`. Sem isto o dono ficaria com "Sobremesas"
    // acima da Padaria para sempre, sem nada a fazer.
    const r = await amb.app.inject({
      method: 'PATCH',
      url: `/api/admin/categorias/${id}`,
      headers: aut(admin),
      payload: { ordem: 99 },
    });
    expect(r.statusCode).toBe(200);

    const depois = await menuAgora();
    expect(depois.nova, `ordem=99 e a maior de todas; ids: ${depois.ids}`).toBe(depois.ultima);
  });

  /**
   * CONTROLE POSITIVO do PATCH de `ordem`: mover uma categoria nao pode arrastar
   * as outras junto. Sem este par, o teste acima passaria com um `ordem` que
   * reescrevesse o cardapio inteiro.
   */
  it('mover uma categoria nao mexe na ordem relativa das outras', async () => {
    const semeadas = async () => {
      const menu = await amb.app.inject({ method: 'GET', url: '/api/menu' });
      return (menu.json() as { id: number; nome: string }[])
        .filter((c) => ['Padaria', 'Salgados', 'Pratos', 'Bebidas'].includes(c.nome))
        .map((c) => c.nome);
    };

    const antes = await semeadas();
    expect(antes, 'o seed tem que estar no menu, senao nao ha o que preservar').toEqual([
      'Padaria',
      'Salgados',
      'Pratos',
      'Bebidas',
    ]);

    const id = await criarComProduto('Intruso');
    const r = await amb.app.inject({
      method: 'PATCH',
      url: `/api/admin/categorias/${id}`,
      headers: aut(admin),
      payload: { ordem: 3 }, // no meio dos semeados, de proposito
    });
    expect(r.statusCode).toBe(200);

    expect(await semeadas(), 'mover o intruso embaralhou as categorias semeadas').toEqual(antes);
  });

  /**
   * CACADA 2 — o desempate que falta.
   *
   * `/menu` ordena categoria por `orderBy: { ordem: 'asc' }` e MAIS NADA. As
   * outras tres consultas do projeto desempatam (`admin/cardapio` por `id`, os
   * produtos por `nome`); so esta ficou sem. Com todas as categorias do painel
   * empatadas em ordem=0, o Postgres devolve a ordem que quiser.
   *
   * "A ordem que quiser" nao e abstrato: um UPDATE reescreve a tupla no fim do
   * heap, e o seq scan passa a devolve-la por ultimo. Ou seja, RENOMEAR uma
   * categoria no painel reordena o cardapio do cliente. Este teste faz s
   * exatamente isso e compara.
   */
  it('CACADA 2: renomear uma categoria reordena o cardapio do cliente?', async () => {
    // Com PRODUTO: `/menu` filtra `produtos.length > 0` (menu.routes.ts:35), e
    // uma categoria vazia nunca chega na lista. A primeira versao deste teste
    // criou as duas vazias, comparou uma lista que nao continha nenhuma delas e
    // passou VERDE sem tocar no que dizia testar.
    const a = await criarComProduto('AAA');
    const b = await criarComProduto('BBB');

    const idsNoMenu = async () => {
      const menu = await amb.app.inject({ method: 'GET', url: '/api/menu' });
      return (menu.json() as { id: number }[]).map((c) => c.id);
    };

    const antes = await idsNoMenu();

    // Um rename qualquer, o tipo de coisa que o dono faz sem pensar duas vezes.
    // CONTROLE POSITIVO: as duas categorias precisam estar NO menu, senao esta
    // comparacao nao tem sobre o que falhar.
    expect(antes, 'as categorias novas nem chegaram ao /menu').toEqual(
      expect.arrayContaining([a, b]),
    );

    const rename = await amb.app.inject({
      method: 'PATCH',
      url: `/api/admin/categorias/${a}`,
      headers: aut(admin),
      payload: { nome: `AAA-renomeada-${randomUUID().slice(0, 6)}` },
    });
    expect(rename.statusCode).toBe(200);

    const depois = await idsNoMenu();

    expect(
      depois,
      'renomear uma categoria mudou a ORDEM do cardapio do cliente. ' +
        `Antes: ${antes.join(',')} | Depois: ${depois.join(',')}`,
    ).toEqual(antes);
  });

  it('criar produto direto numa categoria SEMEADA tambem entra', async () => {
    const semeada = await amb.prisma.categoria.findFirstOrThrow({ orderBy: { id: 'asc' } });

    const r = await amb.app.inject({
      method: 'POST',
      url: '/api/admin/produtos',
      headers: aut(admin),
      payload: { categoriaId: semeada.id, nome: `Item-${randomUUID().slice(0, 6)}`, precoCentavos: 500 },
    });
    expect(r.statusCode).toBe(201);
  });
});
