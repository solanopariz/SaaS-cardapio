import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { subirAmbiente, type Ambiente } from './helpers/ambiente.js';

let amb: Ambiente;
let picanha: number;
let coca: number;
const PRECO_PICANHA = 8900;
const PRECO_COCA = 700;

beforeAll(async () => {
  amb = await subirAmbiente();

  const cat = await amb.prisma.categoria.create({ data: { nome: 'Geral' } });
  picanha = (
    await amb.prisma.produto.create({
      data: { categoriaId: cat.id, nome: 'Picanha', precoCentavos: PRECO_PICANHA },
    })
  ).id;
  coca = (
    await amb.prisma.produto.create({
      data: { categoriaId: cat.id, nome: 'Coca', precoCentavos: PRECO_COCA },
    })
  ).id;
}, 180_000);

afterAll(async () => {
  await amb?.parar();
});

let proximaMesa = 700;

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

function pedir(token: string, chave: string, produtoIds: number[]) {
  return amb.app.inject({
    method: 'POST',
    url: '/api/comandas/me/pedidos',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': chave },
    payload: {
      itens: produtoIds.map((produtoId) => ({
        produtoId,
        qtd: 1,
        participanteId: null,
        observacao: null,
      })),
    },
  });
}

describe('Idempotency-Key no POST /comandas/me/pedidos', () => {
  it('mesma chave em sequencia: 201 depois 200, um pedido so', async () => {
    const { comandaId, token } = await mesaComCliente();
    const chave = randomUUID();

    const a = await pedir(token, chave, [picanha]);
    const b = await pedir(token, chave, [picanha]);

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200); // 200 = "ja existia", nao criou nada
    expect(b.json().id).toBe(a.json().id);

    // O que importa: UMA picanha no banco, nao duas.
    const n = await amb.prisma.pedido.count({ where: { comandaId } });
    expect(n).toBe(1);
  });

  /**
   * O caso que o header existe para resolver: wi-fi ruim, o celular reenvia o
   * POST antes da primeira resposta chegar. Os dois estao em voo ao mesmo tempo,
   * entao o `findUnique` de pre-checagem nao ve nada em NENHUM dos dois — quem
   * decide e o unique (comandaId, idempotencyKey) no banco.
   */
  it('mesma chave em voo simultaneo: um pedido so, sem 500', async () => {
    const { comandaId, token } = await mesaComCliente();
    const chave = randomUUID();

    const rs = await Promise.all([
      pedir(token, chave, [picanha]),
      pedir(token, chave, [picanha]),
      pedir(token, chave, [picanha]),
      pedir(token, chave, [picanha]),
    ]);

    expect(rs.filter((r) => r.statusCode >= 500)).toHaveLength(0);
    expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(3);

    // Todos apontam para o MESMO pedido.
    expect(new Set(rs.map((r) => r.json().id)).size).toBe(1);

    const n = await amb.prisma.pedido.count({ where: { comandaId } });
    expect(n).toBe(1); // quatro cliques, uma picanha cobrada
  });

  it('chaves diferentes: dois pedidos, seq distintos', async () => {
    const { comandaId, token } = await mesaComCliente();

    const a = await pedir(token, randomUUID(), [picanha]);
    const b = await pedir(token, randomUUID(), [picanha]);

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().id).not.toBe(b.json().id);
    expect(a.json().seq).not.toBe(b.json().seq);

    const n = await amb.prisma.pedido.count({ where: { comandaId } });
    expect(n).toBe(2); // duas picanhas pedidas de verdade = duas cobradas
  });

  it('sem header: 400, e nada e criado', async () => {
    const { comandaId, token } = await mesaComCliente();

    const r = await amb.app.inject({
      method: 'POST',
      url: '/api/comandas/me/pedidos',
      headers: { authorization: `Bearer ${token}` },
      payload: { itens: [{ produtoId: picanha, qtd: 1, participanteId: null, observacao: null }] },
    });

    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('IDEMPOTENCY_KEY_AUSENTE');
    expect(await amb.prisma.pedido.count({ where: { comandaId } })).toBe(0);
  });

  it('chave que nao e uuid: 400', async () => {
    const { token } = await mesaComCliente();
    const r = await pedir(token, 'chave-qualquer-nao-uuid', [picanha]);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('IDEMPOTENCY_KEY_AUSENTE');
  });

  /**
   * A chave e escopada por comanda: `@@unique([comandaId, idempotencyKey])`.
   * Duas mesas diferentes podem usar a mesma chave sem se atrapalhar — o que
   * importa, porque a chave e gerada no celular e nada garante unicidade global.
   */
  it('mesma chave em comandas diferentes: dois pedidos independentes', async () => {
    const m1 = await mesaComCliente();
    const m2 = await mesaComCliente();
    const chave = randomUUID();

    const a = await pedir(m1.token, chave, [picanha]);
    const b = await pedir(m2.token, chave, [picanha]);

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201); // nao colidiu com a mesa vizinha
    expect(await amb.prisma.pedido.count({ where: { comandaId: m1.comandaId } })).toBe(1);
    expect(await amb.prisma.pedido.count({ where: { comandaId: m2.comandaId } })).toBe(1);
  });

  /**
   * HIPOTESE — a chave nao cobre o CONTEUDO.
   *
   * Cenario: cliente manda [picanha]. O servidor RECEBE e grava, mas a resposta
   * se perde (wi-fi de restaurante). O front nao limpa a chave no erro — de
   * proposito e corretamente. O cliente adiciona uma coca e reenvia: mesma
   * chave, payload [picanha, coca].
   *
   * O servidor acha a chave e devolve o pedido ORIGINAL (so picanha) com 200.
   * O front trata 200 como sucesso: limpa o carrinho e zera a chave.
   * A coca evapora. O cliente acha que pediu; a cozinha nunca viu.
   *
   * Isto e o modo de falha SILENCIOSO: ninguem recebe erro, o item some.
   */
  it('mesma chave com payload diferente: 409, nao um 200 que engole o item', async () => {
    const { comandaId, token } = await mesaComCliente();
    const chave = randomUUID();

    const primeiro = await pedir(token, chave, [picanha]);
    expect(primeiro.statusCode).toBe(201);

    // Mesmo carrinho + coca. Mesma chave, porque o front so a limpa no sucesso.
    const segundo = await pedir(token, chave, [picanha, coca]);

    // 409, nao 200. Um 200 aqui devolveria o pedido original e o front limparia
    // o carrinho: a coca sumiria sem ninguem receber erro.
    expect(segundo.statusCode).toBe(409);
    expect(segundo.json().code).toBe('IDEMPOTENCY_KEY_REUSADA');

    // E o pedido original continua intacto — o 409 nao desfaz a picanha.
    const pedidos = await amb.prisma.pedido.count({ where: { comandaId } });
    expect(pedidos).toBe(1);
    expect(primeiro.json().itens).toHaveLength(1);
  });

  it('o 409 tambem pega no caminho concorrente, nao so na pre-checagem', async () => {
    const { token } = await mesaComCliente();
    const chave = randomUUID();

    // Payloads DIFERENTES com a MESMA chave, em voo ao mesmo tempo: a
    // pre-checagem nao ve nada em nenhum dos dois. Quem pega e o P2002 no
    // catch — que precisa comparar conteudo igual a pre-checagem faz.
    const rs = await Promise.all([
      pedir(token, chave, [picanha]),
      pedir(token, chave, [picanha, coca]),
    ]);

    const status = rs.map((r) => r.statusCode).sort();
    expect(status).toEqual([201, 409]); // um cria, o outro NAO e engolido

    const perdedor = rs.find((r) => r.statusCode === 409)!;
    expect(perdedor.json().code).toBe('IDEMPOTENCY_KEY_REUSADA');
  });

  it('mesmo carrinho em ordem diferente continua sendo o mesmo pedido', async () => {
    const { comandaId, token } = await mesaComCliente();
    const chave = randomUUID();

    const a = await pedir(token, chave, [picanha, coca]);
    const b = await pedir(token, chave, [coca, picanha]); // embaralhado

    expect(a.statusCode).toBe(201);
    // Retry legitimo: o celular reenviou o mesmo carrinho. Ordem nao e conteudo.
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
    expect(await amb.prisma.pedido.count({ where: { comandaId } })).toBe(1);
  });

  it('cozinha cancelar o item nao transforma o retry em 409', async () => {
    const { token } = await mesaComCliente();
    const chave = randomUUID();

    const a = await pedir(token, chave, [picanha]);
    const itemId = a.json().itens[0].id;

    // A cozinha cancela o item DEPOIS do pedido entrar.
    await amb.prisma.pedidoItem.update({
      where: { id: itemId },
      data: { canceladoEm: new Date(), motivoCancelamento: 'acabou' },
    });

    // O celular, que nunca recebeu a resposta, reenvia. Isto ainda e o MESMO
    // pedido: assinar `canceladoEm` faria uma acao da cozinha virar 409 na cara
    // de um cliente com rede lenta.
    const b = await pedir(token, chave, [picanha]);
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
  });
});
