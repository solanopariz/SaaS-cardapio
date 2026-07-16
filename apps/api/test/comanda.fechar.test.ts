import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { subirAmbiente, type Ambiente } from './helpers/ambiente.js';

let amb: Ambiente;
let caixa: string;
let produtoId: number;
const PRECO = 1500; // R$ 15,00

beforeAll(async () => {
  amb = await subirAmbiente();

  const usuario = await amb.prisma.usuario.create({
    data: { nome: 'Caixa', email: 'caixa@teste', senhaHash: 'x', role: 'CAIXA' },
  });
  caixa = amb.tokenStaff(usuario.id, 'CAIXA');

  const categoria = await amb.prisma.categoria.create({ data: { nome: 'Bebidas' } });
  const produto = await amb.prisma.produto.create({
    data: { categoriaId: categoria.id, nome: 'Cerveja', precoCentavos: PRECO },
  });
  produtoId = produto.id;
}, 180_000);

afterAll(async () => {
  await amb?.parar();
});

let proximaMesa = 800;

/** Mesa nova + um cliente dentro. Cada teste isolado do outro. */
async function mesaComCliente() {
  const numero = proximaMesa++;
  const k = randomBytes(8).toString('hex');
  await amb.prisma.mesa.create({ data: { numero, qrSecret: k } });

  const r = await amb.app.inject({
    method: 'POST',
    url: '/api/sessions/join',
    payload: { mesa: numero, k, apelido: 'Ana', deviceId: randomUUID() },
  });
  const { token, comandaId } = r.json();
  return { numero, comandaId, token };
}

function pedir(token: string, qtd = 1) {
  return amb.app.inject({
    method: 'POST',
    url: '/api/comandas/me/pedidos',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
    payload: { itens: [{ produtoId, qtd, participanteId: null, observacao: null }] },
  });
}

function fechar(comandaId: number, metodo = 'PIX', valorRecebidoCentavos?: number) {
  return amb.app.inject({
    method: 'POST',
    url: `/api/caixa/comandas/${comandaId}/fechar`,
    headers: { authorization: `Bearer ${caixa}` },
    payload: { metodo, valorRecebidoCentavos },
  });
}

describe('POST /caixa/comandas/:id/fechar', () => {
  it('grava o total, marca quem fechou e libera a mesa', async () => {
    const { comandaId, token, numero } = await mesaComCliente();
    await pedir(token, 2);

    const r = await fechar(comandaId);
    expect(r.statusCode).toBe(200);
    expect(r.json().totalCentavos).toBe(2 * PRECO);

    const c = await amb.prisma.comanda.findUniqueOrThrow({ where: { id: comandaId } });
    expect(c.status).toBe('FECHADA');
    expect(c.totalCentavos).toBe(2 * PRECO); // recibo imutavel, agora sim gravado
    expect(c.fechadaEm).not.toBeNull();
    expect(c.fechadaPorUsuarioId).not.toBeNull();

    const mesa = await amb.prisma.mesa.findFirstOrThrow({ where: { numero } });
    expect(mesa.status).toBe('LIVRE'); // o QR impresso serve o proximo cliente
  });

  /**
   * A claim do README: "Fechar conta usa SELECT ... FOR UPDATE: dois caixas
   * clicando junto, um recebe 409."
   *
   * O segundo bloqueia no lock; quando entra, RELE a linha (READ COMMITTED
   * reavalia a tupla apos adquirir o lock) e ve FECHADA -> 409. Se o lock nao
   * existisse, ambos leriam AGUARDANDO_PAGAMENTO, ambos somariam, ambos
   * gravariam: dois recibos e a mesa liberada duas vezes.
   */
  it('dois caixas fechando junto: um 200, um 409', async () => {
    const { comandaId, token } = await mesaComCliente();
    await pedir(token);

    const [a, b] = await Promise.all([fechar(comandaId), fechar(comandaId)]);
    const status = [a.statusCode, b.statusCode].sort();

    expect(status).toEqual([200, 409]);

    const perdedor = a.statusCode === 409 ? a : b;
    expect(perdedor.json().code).toBe('COMANDA_JA_FECHADA');

    // E o dinheiro foi gravado UMA vez.
    const c = await amb.prisma.comanda.findUniqueOrThrow({ where: { id: comandaId } });
    expect(c.totalCentavos).toBe(PRECO);
  });

  it('DINHEIRO: valor recebido menor que o total e recusado', async () => {
    const { comandaId, token } = await mesaComCliente();
    await pedir(token, 2); // 3000

    const r = await fechar(comandaId, 'DINHEIRO', 2000);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('VALOR_INSUFICIENTE');

    // Recusou = nao fechou. A comanda continua viva.
    const c = await amb.prisma.comanda.findUniqueOrThrow({ where: { id: comandaId } });
    expect(c.status).not.toBe('FECHADA');
    expect(c.totalCentavos).toBeNull();
  });

  it('DINHEIRO: troco = recebido - total', async () => {
    const { comandaId, token } = await mesaComCliente();
    await pedir(token, 2); // 3000

    const r = await fechar(comandaId, 'DINHEIRO', 5000);
    expect(r.statusCode).toBe(200);
    expect(r.json().trocoCentavos).toBe(2000);
  });

  it('fechar comanda inexistente: 404', async () => {
    const r = await fechar(999_999);
    expect(r.statusCode).toBe(404);
  });

  /**
   * HIPOTESE — o pedido em voo durante o fechamento.
   *
   * `fecharComanda` trava a linha da COMANDA (FOR UPDATE). `criarPedido` insere
   * em PEDIDOS, outra tabela, e le o status da comanda ~4 queries ANTES de
   * inserir. Se o fechamento commitar nessa janela, o pedido entra numa comanda
   * ja FECHADA e fica fora do total que acabou de ser gravado.
   *
   * Cenario real, nao teorico: fechar aceita comanda ABERTA (nao exige que o
   * cliente tenha pedido a conta). Um cliente paga no balcao enquanto o amigo
   * pede mais uma cerveja pelo celular.
   *
   * INVARIANTE: o total gravado tem que bater com a soma dos itens nao
   * cancelados da comanda. Sempre. Se sobrar item fora do total, e comida de
   * graca.
   */
  it('INVARIANTE: total gravado == soma dos itens, mesmo com pedido em voo', async () => {
    const achados: string[] = [];
    const desfechos: string[] = [];

    // Varias tentativas com atrasos diferentes: a janela e de milissegundos e
    // varia com o agendamento. Uma tentativa so nao prova ausencia.
    for (const atrasoMs of [0, 1, 2, 3, 5, 8, 12, 20]) {
      const { comandaId, token } = await mesaComCliente();
      await pedir(token); // baseline: 1500

      const pedidoEmVoo = pedir(token);
      await new Promise((r) => setTimeout(r, atrasoMs));
      const fechamento = fechar(comandaId);

      const [rp, rf] = await Promise.all([pedidoEmVoo, fechamento]);
      desfechos.push(`${atrasoMs}ms: pedido=${rp.statusCode} fechar=${rf.statusCode}`);

      // So existem dois desfechos legitimos, e o lock decide qual:
      //   pedido vence -> 201, e o fechamento espera e SOMA este pedido
      //   fechar vence -> pedido rele FECHADA e toma 409, sem inserir nada
      // Qualquer outra combinacao (500, ou 201 fora do total) e o bug.
      expect([201, 409]).toContain(rp.statusCode);
      expect([200, 409]).toContain(rf.statusCode);

      const c = await amb.prisma.comanda.findUniqueOrThrow({
        where: { id: comandaId },
        include: { pedidos: { include: { itens: true } } },
      });

      if (c.status !== 'FECHADA') continue; // o fechamento perdeu; nada a checar

      const somaReal = c.pedidos
        .filter((p) => p.status !== 'CANCELADO')
        .flatMap((p) => p.itens)
        .filter((i) => i.canceladoEm === null)
        .reduce((s, i) => s + i.qtd * i.precoUnitarioCentavos, 0);

      if (c.totalCentavos !== somaReal) {
        achados.push(
          `atraso=${atrasoMs}ms: comanda ${comandaId} FECHADA com total=${c.totalCentavos} ` +
            `mas os itens somam ${somaReal} (diferenca=${somaReal - c.totalCentavos!}). ` +
            `POST /pedidos devolveu ${rp.statusCode}, /fechar devolveu ${rf.statusCode}.`,
        );
      }

      // Amarra o desfecho ao dinheiro: 201 obriga o item a estar no total.
      // Sem isto o teste passaria com o pedido perdido em silencio.
      const esperado = rp.statusCode === 201 ? 2 * PRECO : PRECO;
      if (c.totalCentavos !== esperado) {
        achados.push(
          `atraso=${atrasoMs}ms: pedido devolveu ${rp.statusCode} mas o total gravado ` +
            `foi ${c.totalCentavos}, esperado ${esperado}.`,
        );
      }
    }

    expect(achados, `comida de graca:\n${achados.join('\n')}`).toEqual([]);

    // Diagnostico: se TODOS os desfechos forem identicos, a corrida provavelmente
    // nao esta acontecendo e este teste virou decorativo. Nao falha por isso —
    // depende do agendador — mas deixa o rastro no output.
    if (new Set(desfechos.map((d) => d.split(': ')[1])).size === 1) {
      console.warn(
        `[atencao] todos os desfechos iguais (${desfechos[0]?.split(': ')[1]}). ` +
          'A corrida pode nao estar colidindo — o verde aqui pode ser vazio.',
      );
    }
  });

  /**
   * Segundo achado do mesmo arquivo. `criarPedido` calcula `seq` com
   * `aggregate(_max: seq) + 1` e a tabela tem `@@unique([comandaId, seq])`.
   * Dois pedidos concorrentes na mesma comanda calculam o MESMO seq.
   *
   * O catch de P2002 em pedido.service.ts so trata a colisao de
   * `idempotencyKey` ("Duas requisicoes com a MESMA chave", diz o comentario):
   * ele procura o vencedor pela propria chave, nao acha — porque as chaves aqui
   * sao DIFERENTES, quem colidiu foi o seq — e cai no `throw e`. Resultado: 500.
   *
   * Dois amigos na mesma mesa pedindo junto. Nao e cenario exotico: e o produto.
   */
  it('dois pedidos simultaneos na mesma comanda nao dao 500 (colisao de seq)', async () => {
    const { token } = await mesaComCliente();

    // Chaves de idempotencia DIFERENTES: sao dois pedidos legitimos distintos.
    const rs = await Promise.all([pedir(token), pedir(token), pedir(token), pedir(token)]);

    const erros = rs.filter((r) => r.statusCode >= 500);
    expect(
      erros.map((e) => e.json()),
      'pedidos concorrentes na mesma mesa devolveram 500',
    ).toEqual([]);

    // Todos criados, com seq distintos.
    expect(rs.every((r) => r.statusCode === 201)).toBe(true);
    const seqs = rs.map((r) => r.json().seq);
    expect(new Set(seqs).size).toBe(4);
  });
});
