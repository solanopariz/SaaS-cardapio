import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * REGRA 2 do emit.ts: um emit que falha NAO derruba o request.
 *
 * Este arquivo roda num worker onde `criarIo()` NUNCA foi chamado — que e
 * exatamente o estado do processo durante o boot. Por isso ele mora separado
 * do sessao.join.test.ts: la o ambiente monta o io, e `io` e estado de modulo.
 *
 * Nao precisa de banco: env.ts so valida o FORMATO das variaveis e o
 * PrismaClient nao conecta ate a primeira query.
 */

type Emit = typeof import('../../src/realtime/emit.js');
let emit: Emit;

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/naoconecta';
  process.env.JWT_SECRET_STAFF = randomBytes(32).toString('hex');
  process.env.JWT_SECRET_COMANDA = randomBytes(32).toString('hex');
  process.env.APP_PUBLIC_URL = 'http://localhost:5173';
  process.env.NODE_ENV = 'test';

  emit = await import('../../src/realtime/emit.js');
});

describe('emit sem Socket.IO inicializado', () => {
  it('nao lanca — o commit ja aconteceu e o banco e a verdade', () => {
    const erros: string[] = [];
    emit.configurarLogEventos({ error: (_o, msg) => void erros.push(msg) });

    // getIo() lanca 'Socket.IO nao inicializado'. Se este emit propagar, o
    // /join devolve 500 para uma comanda que FOI criada — o cliente acha que
    // nao tem comanda, tendo. Foi o bug real do boot: listen() vinha antes de
    // criarIo() e abria essa janela.
    expect(() =>
      emit.emitirMesaStatus({ mesaId: 1, numero: 14, status: 'OCUPADA', comandaId: 1 }),
    ).not.toThrow();

    // Engolir sem logar seria pior que estourar: o evento some e ninguem sabe.
    expect(erros).toHaveLength(1);
    expect(erros[0]).toMatch(/commit/i);
  });

  it('vale para todos os emissores, nao so o de mesa', () => {
    emit.configurarLogEventos({ error: () => {} });

    // Se alguem adicionar um emissor novo chamando getIo() direto, sem passar
    // pelo envelope `emitir()`, este teste nao pega — mas o proximo dev que
    // ler isto sabe que devia.
    expect(() =>
      emit.emitirPedidoNovo({
        id: 1,
        comandaId: 1,
        mesaNumero: 14,
        seq: 1,
        status: 'RECEBIDO',
        criadoEm: new Date().toISOString(),
        itens: [],
      }),
    ).not.toThrow();

    expect(() => emit.emitirPedidoStatus({ id: 1, comandaId: 1, status: 'PRONTO' })).not.toThrow();
    expect(() =>
      emit.emitirPedidoCancelado({ id: 1, comandaId: 1, status: 'CANCELADO' }),
    ).not.toThrow();
    expect(() =>
      emit.emitirItemCancelado({ itemId: 1, pedidoId: 1, comandaId: 1, pedidoCancelado: false }),
    ).not.toThrow();
    expect(() =>
      emit.emitirContaSolicitada({ comandaId: 1, mesaNumero: 14, totalParcialCentavos: 4200 }),
    ).not.toThrow();
    expect(() =>
      emit.emitirComandaFechada({ comandaId: 1, mesaNumero: 14, totalCentavos: 5000 }),
    ).not.toThrow();
  });

  it('log recebe o erro e o nome do evento, nao so uma mensagem generica', () => {
    const capturado: Record<string, unknown>[] = [];
    emit.configurarLogEventos({ error: (obj) => void capturado.push(obj) });

    emit.emitirMesaStatus({ mesaId: 1, numero: 14, status: 'OCUPADA', comandaId: 1 });

    expect(capturado).toHaveLength(1);
    expect(capturado[0]).toHaveProperty('evento');
    expect(capturado[0]).toHaveProperty('err');
  });
});
