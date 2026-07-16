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

/**
 * `totalEsperadoCentavos` e o total que a TELA mostrava. Cada teste passa o
 * numero na mao (PRECO * n) de proposito: calcular aqui com a mesma funcao da
 * implementacao provaria so que a funcao e igual a si mesma.
 */
function fechar(
  comandaId: number,
  opts: {
    metodo?: string;
    valorRecebidoCentavos?: number;
    totalEsperadoCentavos: number;
  },
) {
  return amb.app.inject({
    method: 'POST',
    url: `/api/caixa/comandas/${comandaId}/fechar`,
    headers: { authorization: `Bearer ${caixa}` },
    payload: {
      metodo: opts.metodo ?? 'PIX',
      valorRecebidoCentavos: opts.valorRecebidoCentavos,
      totalEsperadoCentavos: opts.totalEsperadoCentavos,
    },
  });
}

describe('POST /caixa/comandas/:id/fechar', () => {
  it('grava o total, marca quem fechou e libera a mesa', async () => {
    const { comandaId, token, numero } = await mesaComCliente();
    await pedir(token, 2);

    const r = await fechar(comandaId, { totalEsperadoCentavos: 2 * PRECO });
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

    const [a, b] = await Promise.all([
      fechar(comandaId, { totalEsperadoCentavos: PRECO }),
      fechar(comandaId, { totalEsperadoCentavos: PRECO }),
    ]);
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

    const r = await fechar(comandaId, {
      metodo: 'DINHEIRO',
      valorRecebidoCentavos: 2000,
      totalEsperadoCentavos: 2 * PRECO,
    });
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

    const r = await fechar(comandaId, {
      metodo: 'DINHEIRO',
      valorRecebidoCentavos: 5000,
      totalEsperadoCentavos: 2 * PRECO,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().trocoCentavos).toBe(2000);
  });

  it('fechar comanda inexistente: 404', async () => {
    const r = await fechar(999_999, { totalEsperadoCentavos: 0 });
    expect(r.statusCode).toBe(404);
  });

  /**
   * O GUARDA DO TOTAL. O caixa abre o dialogo lendo R$ 15,00; o amigo pede mais
   * uma cerveja pelo celular; o caixa clica em DINHEIRO com o numero velho na
   * cabeca. Sem este guarda a API cobraria 30 em silencio — o total dela esta
   * certo — e o troco sairia do bolso de alguem.
   */
  it('total velho na tela: 409 TOTAL_MUDOU e a comanda NAO fecha', async () => {
    const { comandaId, token } = await mesaComCliente();
    await pedir(token); // a tela leu isto: 1500
    await pedir(token); // ...e entao entrou este. O total agora e 3000.

    const r = await fechar(comandaId, { totalEsperadoCentavos: PRECO });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('TOTAL_MUDOU');

    const c = await amb.prisma.comanda.findUniqueOrThrow({ where: { id: comandaId } });
    expect(c.status).not.toBe('FECHADA');
    expect(c.totalCentavos).toBeNull();
  });

  /**
   * CONTROLE POSITIVO do teste acima. Mesmissima comanda de dois pedidos: so
   * muda o numero que a tela declara. Sem este par, o 409 acima passaria
   * tambem se `fechar` estivesse quebrado por qualquer outro motivo.
   */
  it('total certo na tela: a MESMA comanda de dois pedidos fecha em 200', async () => {
    const { comandaId, token } = await mesaComCliente();
    await pedir(token);
    await pedir(token);

    const r = await fechar(comandaId, { totalEsperadoCentavos: 2 * PRECO });
    expect(r.statusCode).toBe(200);
    expect(r.json().totalCentavos).toBe(2 * PRECO);
  });

  it('DINHEIRO: o troco sai do total REAL, e o guarda impede que ele minta', async () => {
    const { comandaId, token } = await mesaComCliente();
    await pedir(token, 2); // 3000

    const r = await fechar(comandaId, {
      metodo: 'DINHEIRO',
      valorRecebidoCentavos: 5000,
      totalEsperadoCentavos: 2 * PRECO,
    });
    expect(r.statusCode).toBe(200);
    // A tela calcula 5000-3000 localmente para o preview. O guarda garante que
    // esse preview e este numero nao podem divergir.
    expect(r.json().trocoCentavos).toBe(2000);
    expect(r.json().totalCentavos).toBe(3000);
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
   *
   * O GUARDA DE TOTAL MUDOU ESTE TESTE. Agora `fechar` precisa declarar o total
   * que espera, e ESSA DECLARACAO decide qual ramo do lock e alcancavel — uma
   * aposta so mataria metade do teste. Por isso ele roda as DUAS:
   *
   *   aposta 2*PRECO ("o pedido em voo entra") -> se fechar, foi porque leu os
   *     dois pedidos: o ramo em que o fechamento SOMA o pedido novo.
   *   aposta PRECO ("o pedido em voo nao entra") -> se fechar, foi porque leu
   *     so o baseline e commitou antes: o ramo em que o PEDIDO perde e releva
   *     FECHADA, tomando 409.
   *
   * Apostar so em 2*PRECO deixaria o segundo ramo inalcancavel (o `esperado`
   * daria num galho morto), e o verde ali seria vazio.
   *
   * A CONTENCAO em si — o fechamento realmente DORMINDO no lock — nao da para
   * provar daqui: um `pedido=201 + fechar=200` acontece igual se o pedido
   * commitou antes de o fechamento sequer comecar. Quem prova isso e o teste
   * deterministico logo abaixo, que segura o lock na mao.
   */
  it('INVARIANTE: total gravado == soma dos itens, mesmo com pedido em voo', async () => {
    const achados: string[] = [];
    const desfechos: string[] = [];
    // Quantas vezes cada ramo REALMENTE fechou. Sem isto o `continue` do
    // !FECHADA engole a rodada e tudo passa por vacuidade.
    const fechou = { somandoOEmVoo: 0, antesDoEmVoo: 0 };

    // Varias tentativas com atrasos diferentes: a janela e de milissegundos e
    // varia com o agendamento. Uma tentativa so nao prova ausencia.
    for (const aposta of [2 * PRECO, PRECO]) {
      for (const atrasoMs of [0, 1, 2, 3, 5, 8, 12, 20]) {
        const { comandaId, token } = await mesaComCliente();
        await pedir(token); // baseline: 1500

        const pedidoEmVoo = pedir(token);
        await new Promise((r) => setTimeout(r, atrasoMs));
        const fechamento = fechar(comandaId, { totalEsperadoCentavos: aposta });

        const [rp, rf] = await Promise.all([pedidoEmVoo, fechamento]);
        const rodada = `aposta=${aposta} atraso=${atrasoMs}ms: pedido=${rp.statusCode} fechar=${rf.statusCode}`;
        desfechos.push(rodada);

        // O lock decide quem entra primeiro; a aposta decide se o fechamento
        // sobrevive ao que viu. Qualquer outra combinacao (500, ou 201 fora do
        // total) e o bug.
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
            `${rodada} -> comanda ${comandaId} FECHADA com total=${c.totalCentavos} ` +
              `mas os itens somam ${somaReal} (diferenca=${somaReal - c.totalCentavos!}).`,
          );
        }

        // Amarra o desfecho ao dinheiro. FECHADA so e possivel se o total lido
        // batia com a aposta, entao cada aposta obriga um desfecho do PEDIDO:
        //   2*PRECO fechou -> o pedido em voo estava la dentro: tem que ser 201
        //   PRECO fechou   -> o fechamento commitou antes: o pedido tem que ter
        //                     relido FECHADA e tomado 409, sem inserir nada
        // Sem isto o teste passaria com o pedido perdido em silencio.
        const pedidoEsperado = aposta === 2 * PRECO ? 201 : 409;
        if (rp.statusCode !== pedidoEsperado) {
          achados.push(
            `${rodada} -> fechou em ${c.totalCentavos} mas o pedido devolveu ` +
              `${rp.statusCode}, esperado ${pedidoEsperado}.`,
          );
        }
        if (c.totalCentavos !== aposta) {
          achados.push(`${rodada} -> fechou gravando ${c.totalCentavos}, mas apostou ${aposta}.`);
        }

        if (aposta === 2 * PRECO) fechou.somandoOEmVoo++;
        else fechou.antesDoEmVoo++;
      }
    }

    expect(achados, `comida de graca:\n${achados.join('\n')}`).toEqual([]);

    // CONTROLE POSITIVO, e nao diagnostico opcional: um `fecharComanda` que so
    // soubesse dar 409 deixaria tudo acima verde, porque o `continue` comeria
    // todas as rodadas. Este ramo e o barato de acertar — se nem ele fechou,
    // nada foi testado.
    expect(
      fechou.somandoOEmVoo,
      'nenhuma rodada da aposta 2*PRECO chegou a fechar: a invariante nao foi ' +
        `verificada em nada.\n${desfechos.join('\n')}`,
    ).toBeGreaterThan(0);

    // O ramo "fechar vence" depende do agendador — nao da para exigi-lo sem
    // tornar o teste instavel. Mas o silencio aqui e informacao: se ele NUNCA
    // roda, o `pedidoEsperado === 409` acima e galho morto e alguem precisa
    // saber, em vez de descobrir num restaurante.
    if (fechou.antesDoEmVoo === 0) {
      console.warn(
        '[atencao] a aposta PRECO nunca fechou — o ramo "fechar vence, pedido ' +
          'toma 409" nao foi exercitado nesta rodada.',
      );
    }
    if (new Set(desfechos.map((d) => d.split(': ')[1])).size === 1) {
      console.warn(
        `[atencao] todos os desfechos iguais (${desfechos[0]?.split(': ')[1]}). ` +
          'A corrida pode nao estar colidindo — o verde aqui pode ser vazio.',
      );
    }
  });

  /**
   * A CONTENCAO, provada em vez de torcida.
   *
   * O teste acima corre a corrida de verdade, mas nao consegue afirmar que o
   * fechamento DORMIU no lock: `pedido=201 + fechar=200` sai igual se o pedido
   * commitou antes de o fechamento comecar. Aqui o lock e segurado na mao, e o
   * cenario deixa de depender do agendador:
   *
   *   1. esta transacao trava a comanda e NAO solta
   *   2. o fechamento comeca e bate no lock (provado: ele nao responde)
   *   3. o pedido novo entra ENQUANTO ele dorme
   *   4. solta -> o fechamento acorda, RELE os pedidos e soma o que apareceu
   *
   * O passo 4 e a unica razao de o FOR UPDATE existir. Se `fecharComanda`
   * calculasse o total antes de travar, aqui gravaria 1500 com 3000 na mesa.
   */
  it('DETERMINISTICO: o fechamento dorme no lock e SOMA o pedido que entrou na espera', async () => {
    const { comandaId, token } = await mesaComCliente();
    await pedir(token); // baseline: 1500

    let fechamento!: ReturnType<typeof fechar>;

    await amb.prisma.$transaction(
      async (tx) => {
        // Trava a comanda ANTES de o fechamento existir.
        await tx.$queryRaw`SELECT id FROM comandas WHERE id = ${comandaId} FOR UPDATE`;

        fechamento = fechar(comandaId, { totalEsperadoCentavos: 2 * PRECO });

        // CONTROLE POSITIVO DA CONTENCAO: se o fechamento responder agora, ele
        // nao esperou lock nenhum e o resto do teste seria teatro.
        const cedo = await Promise.race([
          fechamento.then(() => 'respondeu'),
          new Promise((r) => setTimeout(() => r('bloqueado'), 500)),
        ]);
        expect(cedo, 'o fechamento NAO bloqueou no lock da comanda').toBe('bloqueado');

        // O amigo pede a segunda cerveja enquanto o fechamento dorme.
        await tx.pedido.create({
          data: {
            comandaId,
            seq: 2,
            idempotencyKey: randomUUID(),
            itens: { create: [{ produtoId, qtd: 1, precoUnitarioCentavos: PRECO }] },
          },
        });
      },
      { timeout: 20_000 },
    );

    // Solto o lock: o fechamento acorda aqui.
    const rf = await fechamento;

    expect(rf.statusCode).toBe(200);
    expect(rf.json().totalCentavos, 'acordou e nao releu os pedidos').toBe(2 * PRECO);

    const c = await amb.prisma.comanda.findUniqueOrThrow({ where: { id: comandaId } });
    expect(c.totalCentavos).toBe(2 * PRECO);
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
