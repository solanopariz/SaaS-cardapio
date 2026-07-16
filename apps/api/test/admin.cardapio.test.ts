import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { subirAmbiente, type Ambiente } from './helpers/ambiente.js';

let amb: Ambiente;
let admin: string;
let caixa: string;

beforeAll(async () => {
  amb = await subirAmbiente();
  admin = amb.tokenStaff(1, 'ADMIN');
  caixa = amb.tokenStaff(2, 'CAIXA');
}, 180_000);

afterAll(async () => {
  await amb?.parar();
});

const aut = (t: string) => ({ authorization: `Bearer ${t}` });

function post(url: string, token: string, payload: unknown) {
  return amb.app.inject({ method: 'POST', url, headers: aut(token), payload });
}
function patch(url: string, token: string, payload: unknown) {
  return amb.app.inject({ method: 'PATCH', url, headers: aut(token), payload });
}

/** Categoria nova por teste: o /menu e global e um teste nao pode sujar o outro. */
async function categoriaNova(nome = `Cat-${randomUUID().slice(0, 8)}`) {
  const r = await post('/api/admin/categorias', admin, { nome });
  expect(r.statusCode).toBe(201);
  return r.json().id as number;
}

async function produtoNovo(categoriaId: number, precoCentavos = 1000) {
  const r = await post('/api/admin/produtos', admin, {
    categoriaId,
    nome: `Prod-${randomUUID().slice(0, 8)}`,
    precoCentavos,
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as number;
}

let proximaMesa = 900;
async function mesaComCliente() {
  const numero = proximaMesa++;
  const k = randomBytes(8).toString('hex');
  await amb.prisma.mesa.create({ data: { numero, qrSecret: k } });
  const r = await amb.app.inject({
    method: 'POST',
    url: '/api/sessions/join',
    payload: { mesa: numero, k, apelido: 'Ana', deviceId: randomUUID() },
  });
  return { comandaId: r.json().comandaId as number, token: r.json().token as string };
}

function pedir(token: string, produtoId: number) {
  return amb.app.inject({
    method: 'POST',
    url: '/api/comandas/me/pedidos',
    headers: { ...aut(token), 'idempotency-key': randomUUID() },
    payload: { itens: [{ produtoId, qtd: 1, participanteId: null, observacao: null }] },
  });
}

/** O /menu inteiro, achatado em ids de produto. */
async function idsNoMenu(): Promise<number[]> {
  const r = await amb.app.inject({ method: 'GET', url: '/api/menu' });
  return (r.json() as { produtos: { id: number }[] }[]).flatMap((c) => c.produtos.map((p) => p.id));
}

describe('guard das rotas de admin', () => {
  it('CAIXA nao entra, ADMIN entra', async () => {
    const negado = await amb.app.inject({ method: 'GET', url: '/api/admin/cardapio', headers: aut(caixa) });
    expect(negado.statusCode).toBe(403);

    // CONTROLE POSITIVO: sem isto, um 403 por rota inexistente (404) ou por
    // token quebrado passaria como "o guard funciona".
    const ok = await amb.app.inject({ method: 'GET', url: '/api/admin/cardapio', headers: aut(admin) });
    expect(ok.statusCode).toBe(200);
  });

  it('sem token: 401', async () => {
    const r = await amb.app.inject({ method: 'GET', url: '/api/admin/cardapio' });
    expect(r.statusCode).toBe(401);
  });
});

describe('CRUD chega no cardapio do cliente', () => {
  it('produto criado aparece no /menu e pode ser pedido', async () => {
    const cat = await categoriaNova();
    const p = await produtoNovo(cat);

    expect(await idsNoMenu()).toContain(p);

    const { token } = await mesaComCliente();
    expect((await pedir(token, p)).statusCode).toBe(201);
  });

  it('o admin ve o que o cliente nao ve', async () => {
    const cat = await categoriaNova();
    const p = await produtoNovo(cat);
    await patch(`/api/admin/produtos/${p}`, admin, { disponivel: false });

    expect(await idsNoMenu()).not.toContain(p);

    // Sumiu do cliente, mas continua na tela do admin — senao ninguem
    // conseguiria reativar o produto de ontem.
    const r = await amb.app.inject({ method: 'GET', url: '/api/admin/cardapio', headers: aut(admin) });
    const todos = (r.json() as { produtos: { id: number }[] }[]).flatMap((c) => c.produtos.map((x) => x.id));
    expect(todos).toContain(p);
  });
});

describe('tirar do cardapio', () => {
  it('disponivel:false some do menu E recusa pedido', async () => {
    const cat = await categoriaNova();
    const p = await produtoNovo(cat);
    const { token } = await mesaComCliente();

    // CONTROLE POSITIVO: pedivel ANTES. Sem isto, um produto que nunca
    // funcionou passaria neste teste.
    expect((await pedir(token, p)).statusCode).toBe(201);

    await patch(`/api/admin/produtos/${p}`, admin, { disponivel: false });

    expect(await idsNoMenu()).not.toContain(p);
    const depois = await pedir(token, p);
    expect(depois.statusCode).toBe(400);
    expect(depois.json().code).toBe('PRODUTO_INDISPONIVEL');
  });

  /**
   * O buraco que o CRUD de admin abriria. `categoria.ativa` era filtrada no
   * /menu e ignorada no criarPedido. Enquanto nada conseguia setar ativa:false
   * era inofensivo; a tela do admin torna o caminho alcancavel.
   *
   * Cenario: 20h, o dono desativa "Bebidas". Um celular com o menu ja aberto
   * posta o pedido. Sem o guard: 201, e a cozinha imprime a bebida que acabou
   * de sair do cardapio.
   */
  it('categoria ativa:false some do menu E recusa pedido dos produtos dela', async () => {
    const cat = await categoriaNova();
    const p = await produtoNovo(cat);
    const { token } = await mesaComCliente();

    expect((await pedir(token, p)).statusCode).toBe(201); // controle positivo

    await patch(`/api/admin/categorias/${cat}`, admin, { ativa: false });

    expect(await idsNoMenu()).not.toContain(p);

    const depois = await pedir(token, p);
    expect(depois.statusCode).toBe(400);
    expect(depois.json().code).toBe('PRODUTO_INDISPONIVEL');
  });

  it('reativar a categoria traz o produto de volta', async () => {
    const cat = await categoriaNova();
    const p = await produtoNovo(cat);
    await patch(`/api/admin/categorias/${cat}`, admin, { ativa: false });
    await patch(`/api/admin/categorias/${cat}`, admin, { ativa: true });

    expect(await idsNoMenu()).toContain(p);
    const { token } = await mesaComCliente();
    expect((await pedir(token, p)).statusCode).toBe(201);
  });
});

/**
 * A regra da casa: quem cobra e o snapshot em PedidoItem.precoUnitarioCentavos.
 * Se alguem trocar o calculo para ler Produto.precoCentavos, o total da comanda
 * passa a mudar sozinho entre pedir e pagar — e o cliente descobre no caixa.
 */
describe('preco: snapshot protege a comanda aberta', () => {
  it('mudar o preco nao mexe em comanda ja aberta', async () => {
    const cat = await categoriaNova();
    const p = await produtoNovo(cat, 1000);
    const { comandaId, token } = await mesaComCliente();

    expect((await pedir(token, p)).statusCode).toBe(201);

    const antes = await amb.app.inject({ method: 'GET', url: '/api/comandas/me', headers: aut(token) });
    expect(antes.json().totalCentavos).toBe(1000);

    // Triplica o preco no cardapio com a comanda aberta.
    const up = await patch(`/api/admin/produtos/${p}`, admin, { precoCentavos: 3000 });
    expect(up.statusCode).toBe(200);
    expect(up.json().precoCentavos).toBe(3000); // controle positivo: mudou MESMO

    const depois = await amb.app.inject({ method: 'GET', url: '/api/comandas/me', headers: aut(token) });
    expect(depois.json().totalCentavos).toBe(1000); // nao 3000
  });

  it('o preco novo vale para quem pedir depois', async () => {
    const cat = await categoriaNova();
    const p = await produtoNovo(cat, 1000);
    await patch(`/api/admin/produtos/${p}`, admin, { precoCentavos: 3000 });

    const { token } = await mesaComCliente();
    expect((await pedir(token, p)).statusCode).toBe(201);

    const r = await amb.app.inject({ method: 'GET', url: '/api/comandas/me', headers: aut(token) });
    expect(r.json().totalCentavos).toBe(3000);
  });
});

describe('PATCH nao carrega default clandestino', () => {
  /**
   * `produtoSchema` tem `disponivel: z.boolean().default(true)`. Se o schema de
   * PATCH aplicasse esse default, editar o nome de um produto esgotado o
   * traria de volta ao cardapio sem ninguem pedir.
   */
  it('editar o nome nao reativa um produto indisponivel', async () => {
    const cat = await categoriaNova();
    const p = await produtoNovo(cat);
    await patch(`/api/admin/produtos/${p}`, admin, { disponivel: false });

    const r = await patch(`/api/admin/produtos/${p}`, admin, { nome: 'Nome Novo' });
    expect(r.statusCode).toBe(200);
    expect(r.json().nome).toBe('Nome Novo'); // controle positivo: o PATCH funcionou
    expect(r.json().disponivel).toBe(false); // e nao ressuscitou o produto

    expect(await idsNoMenu()).not.toContain(p);
  });
});

describe('validacao', () => {
  it('produto em categoria inexistente: 400, nao 500', async () => {
    const r = await post('/api/admin/produtos', admin, {
      categoriaId: 999_999,
      nome: 'Orfao',
      precoCentavos: 100,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('CATEGORIA_INEXISTENTE');
  });

  it('mover produto para categoria inexistente: 400, nao 500', async () => {
    const p = await produtoNovo(await categoriaNova());
    const r = await patch(`/api/admin/produtos/${p}`, admin, { categoriaId: 999_999 });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('CATEGORIA_INEXISTENTE');
  });

  it('preco zero ou negativo: 400', async () => {
    const cat = await categoriaNova();
    for (const precoCentavos of [0, -500]) {
      const r = await post('/api/admin/produtos', admin, { categoriaId: cat, nome: 'X', precoCentavos });
      expect(r.statusCode).toBe(400);
    }
  });

  it('produto inexistente: 404', async () => {
    const r = await patch('/api/admin/produtos/999999', admin, { nome: 'X' });
    expect(r.statusCode).toBe(404);
  });
});
