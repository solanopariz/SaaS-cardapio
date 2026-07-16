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
