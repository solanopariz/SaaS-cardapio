import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io as conectar, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { subirAmbiente, type Ambiente } from '../helpers/ambiente.js';

/**
 * A regra mais afiada do projeto, de io.ts:
 *
 *   "Jamais faca `socket.on('join', room => socket.join(room))`: isso deixa
 *    qualquer pessoa escutar a comanda de qualquer mesa — inclusive os itens e
 *    o total da conta dos outros."
 *
 * Era prosa nao verificada ate este arquivo. Testar isso exige socket de
 * verdade: `app.inject()` nao abre conexao, entao aqui o app escuta numa porta
 * real. De quebra, isto exercita a ordem de boot (criarIo ANTES do listen).
 */

let amb: Ambiente;
let porta: number;
const abertos: Socket[] = [];

beforeAll(async () => {
  amb = await subirAmbiente();
  await amb.app.listen({ port: 0, host: '127.0.0.1' });
  porta = (amb.app.server.address() as AddressInfo).port;
}, 180_000);

afterEach(() => {
  for (const s of abertos.splice(0)) s.disconnect();
});

afterAll(async () => {
  await amb?.parar();
});

function conectarCom(token?: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = conectar(`http://127.0.0.1:${porta}`, {
      auth: token ? { token } : {},
      transports: ['websocket'],
      reconnection: false,
    });
    abertos.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
  });
}

/** Resolve com o payload, ou com null se nada chegar em `ms`. */
function esperar<T>(s: Socket, evento: string, ms = 250): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    s.once(evento, (p: T) => {
      clearTimeout(t);
      resolve(p);
    });
  });
}

let proximaMesa = 600;

async function comandaNova(): Promise<{ comandaId: number; token: string }> {
  const numero = proximaMesa++;
  const k = randomBytes(8).toString('hex');
  await amb.prisma.mesa.create({ data: { numero, qrSecret: k } });
  const r = await amb.app.inject({
    method: 'POST',
    url: '/api/sessions/join',
    payload: { mesa: numero, k, apelido: 'Ana', deviceId: randomUUID() },
  });
  return { comandaId: r.json().comandaId, token: r.json().token };
}

const fechada = (comandaId: number) => ({ comandaId, mesaNumero: 1, totalCentavos: 9900 });
const pedido = (comandaId: number) => ({
  id: 1,
  comandaId,
  mesaNumero: 1,
  seq: 1,
  status: 'RECEBIDO' as const,
  criadoEm: new Date().toISOString(),
  itens: [],
});

describe('handshake do socket', () => {
  it('sem token: recusado', async () => {
    await expect(conectarCom()).rejects.toThrow(/sem token/i);
  });

  it('token lixo: recusado', async () => {
    await expect(conectarCom('nao.e.um.jwt')).rejects.toThrow(/token invalido/i);
  });

  it('token de comanda nao vale como staff (segredos distintos)', async () => {
    const { token } = await comandaNova();
    const cliente = await conectarCom(token);

    const u = await amb.prisma.usuario.create({
      data: { nome: 'C', email: `c${proximaMesa++}@t`, senhaHash: 'x', role: 'COZINHA' },
    });
    const cozinha = await conectarCom(amb.tokenStaff(u.id, 'COZINHA')); // controle

    // O cliente conectou — mas como CLIENTE. Se os dois tipos de token usassem
    // o mesmo segredo, um `tipo: 'staff'` forjado passaria aqui.
    const { emitirPedidoNovo } = await import('../../src/realtime/emit.js');
    emitirPedidoNovo(pedido(999));

    const [noCliente, naCozinha] = await Promise.all([
      esperar(cliente, 'pedido:novo'),
      esperar(cozinha, 'pedido:novo'),
    ]);

    expect(naCozinha, 'a cozinha TEM que receber — senao o teste e vazio').not.toBeNull();
    expect(noCliente, 'token de comanda nao pode entrar na room da cozinha').toBeNull();
  });
});

describe('isolamento de rooms', () => {
  it('cliente recebe o evento da PROPRIA comanda', async () => {
    const a = await comandaNova();
    const s = await conectarCom(a.token);

    const { emitirComandaFechada } = await import('../../src/realtime/emit.js');
    emitirComandaFechada(fechada(a.comandaId));

    const recebido = await esperar<{ comandaId: number }>(s, 'comanda:fechada');
    expect(recebido?.comandaId).toBe(a.comandaId);
  });

  /**
   * O teste que a regra existe para proteger. Se ele ficar vermelho, a conta
   * de uma mesa esta vazando para o celular de outra.
   */
  it('cliente NAO recebe o evento da comanda de outra mesa', async () => {
    const a = await comandaNova();
    const b = await comandaNova();

    const sa = await conectarCom(a.token);
    const sb = await conectarCom(b.token);

    const { emitirComandaFechada } = await import('../../src/realtime/emit.js');

    // Evento da mesa B. O celular da mesa A esta conectado e escutando.
    emitirComandaFechada(fechada(b.comandaId));

    const [chegouEmA, chegouEmB] = await Promise.all([
      esperar(sa, 'comanda:fechada'),
      esperar(sb, 'comanda:fechada'),
    ]);

    // CONTROLE POSITIVO, e ele nao e decorativo: sem ele este teste passaria
    // tambem se o emit nunca tivesse saido. E emit que falha nao lanca — a
    // REGRA 2 do emit.ts engole em silencio, de proposito. Um "A nao recebeu"
    // sozinho nao distingue isolamento de emissor morto.
    expect(chegouEmB, 'o dono da comanda TEM que receber — senao o teste e vazio').not.toBeNull();
    expect(chegouEmA, 'a mesa vizinha nao pode ver a conta desta').toBeNull();
  });

  it('cliente nao entra na room da cozinha nem na do caixa', async () => {
    const a = await comandaNova();
    const cliente = await conectarCom(a.token);

    const u = await amb.prisma.usuario.create({
      data: { nome: 'A', email: `a${proximaMesa++}@t`, senhaHash: 'x', role: 'ADMIN' },
    });
    const admin = await conectarCom(amb.tokenStaff(u.id, 'ADMIN')); // controle: esta nas duas

    const { emitirPedidoNovo, emitirMesaStatus } = await import('../../src/realtime/emit.js');
    emitirPedidoNovo(pedido(a.comandaId)); // ROOM_COZINHA
    emitirMesaStatus({ mesaId: 1, numero: 1, status: 'OCUPADA', comandaId: a.comandaId }); // caixa+cozinha

    const [pedidoNoCliente, pedidoNoAdmin, mesaNoCliente, mesaNoAdmin] = await Promise.all([
      esperar(cliente, 'pedido:novo'),
      esperar(admin, 'pedido:novo'),
      esperar(cliente, 'mesa:status'),
      esperar(admin, 'mesa:status'),
    ]);

    expect(pedidoNoAdmin, 'controle: o admin TEM que receber pedido:novo').not.toBeNull();
    expect(mesaNoAdmin, 'controle: o admin TEM que receber mesa:status').not.toBeNull();

    // O cliente ve o que acontece com o pedido DELE (pedido:status), nunca o
    // fluxo do salao. mesa:status expoe quais mesas estao ocupadas; pedido:novo
    // expoe o que as outras mesas estao comendo.
    expect(pedidoNoCliente).toBeNull();
    expect(mesaNoCliente).toBeNull();
  });

  /**
   * A regra literal do comentario: nao existe `socket.on('join')`. O cliente
   * pode emitir o que quiser; o servidor nao escuta nada dele.
   */
  it('cliente emitindo "join" nao entra em room nenhuma', async () => {
    const a = await comandaNova();
    const b = await comandaNova();
    const sa = await conectarCom(a.token);
    const sb = await conectarCom(b.token); // controle positivo

    // O ataque: tenta entrar na room da comanda alheia e nas de staff.
    sa.emit('join', `comanda:${b.comandaId}`);
    sa.emit('join', 'caixa');
    sa.emit('join', 'cozinha');
    sa.emit('subscribe', `comanda:${b.comandaId}`);
    await new Promise((r) => setTimeout(r, 150)); // tempo de o servidor reagir, se reagisse

    const { emitirComandaFechada } = await import('../../src/realtime/emit.js');
    emitirComandaFechada(fechada(b.comandaId));

    const [chegouEmA, chegouEmB] = await Promise.all([
      esperar(sa, 'comanda:fechada'),
      esperar(sb, 'comanda:fechada'),
    ]);

    // Sem o controle, "o ataque falhou" e indistinguivel de "o evento nunca saiu".
    expect(chegouEmB, 'o dono legitimo TEM que receber — senao o teste e vazio').not.toBeNull();
    expect(chegouEmA, 'emitir "join" nao pode dar acesso a conta alheia').toBeNull();
  });
});

describe('rooms de staff', () => {
  /**
   * O caixa TAMBEM recebe pedido:novo. Nao por interesse — por dinheiro: a
   * `CaixaPage` tem `staleTime: Infinity` e so atualiza o total do grid quando
   * este evento chega. Enquanto ele ia so para a cozinha, o total ficava
   * congelado o servico inteiro (medido no navegador: R$ 65,70 na tela contra
   * R$ 69,70 no banco, corrigindo so no F5).
   */
  it('pedido:novo vai para COZINHA e CAIXA', async () => {
    const u = await amb.prisma.usuario.create({
      data: { nome: 'C', email: `c${proximaMesa++}@t`, senhaHash: 'x', role: 'COZINHA' },
    });
    const v = await amb.prisma.usuario.create({
      data: { nome: 'X', email: `x${proximaMesa++}@t`, senhaHash: 'x', role: 'CAIXA' },
    });

    const cozinha = await conectarCom(amb.tokenStaff(u.id, 'COZINHA'));
    const caixa = await conectarCom(amb.tokenStaff(v.id, 'CAIXA'));

    const { emitirPedidoNovo } = await import('../../src/realtime/emit.js');
    emitirPedidoNovo(pedido(1));

    const [naCozinha, noCaixa] = await Promise.all([
      esperar(cozinha, 'pedido:novo'),
      esperar(caixa, 'pedido:novo'),
    ]);

    expect(naCozinha, 'a cozinha precisa produzir').not.toBeNull();
    expect(noCaixa, 'sem isto o total do grid do caixa congela').not.toBeNull();
  });

  /**
   * O discriminante. Se a regra fosse "o caixa recebe tudo de pedido", este
   * teste ficaria vermelho — e o painel levaria uma enxurrada de eventos que
   * nao mudam numero nenhum.
   */
  it('pedido:status comum NAO vai para o caixa (nao mexe em dinheiro)', async () => {
    const u = await amb.prisma.usuario.create({
      data: { nome: 'C', email: `c${proximaMesa++}@t`, senhaHash: 'x', role: 'COZINHA' },
    });
    const v = await amb.prisma.usuario.create({
      data: { nome: 'X', email: `x${proximaMesa++}@t`, senhaHash: 'x', role: 'CAIXA' },
    });
    const cozinha = await conectarCom(amb.tokenStaff(u.id, 'COZINHA'));
    const caixa = await conectarCom(amb.tokenStaff(v.id, 'CAIXA'));

    const { emitirPedidoStatus } = await import('../../src/realtime/emit.js');
    emitirPedidoStatus({ id: 1, comandaId: 1, status: 'EM_PREPARO' });

    const [naCozinha, noCaixa] = await Promise.all([
      esperar(cozinha, 'pedido:status'),
      esperar(caixa, 'pedido:status'),
    ]);

    expect(naCozinha, 'controle: a cozinha TEM que receber').not.toBeNull();
    // RECEBIDO -> EM_PREPARO nao muda o total. O caixa nao tem o que fazer.
    expect(noCaixa).toBeNull();
  });

  it('cancelamento vai para o caixa: derruba o total', async () => {
    const v = await amb.prisma.usuario.create({
      data: { nome: 'X', email: `x${proximaMesa++}@t`, senhaHash: 'x', role: 'CAIXA' },
    });
    const caixa = await conectarCom(amb.tokenStaff(v.id, 'CAIXA'));

    const { emitirItemCancelado, emitirPedidoCancelado } = await import('../../src/realtime/emit.js');

    emitirItemCancelado({ itemId: 1, pedidoId: 1, comandaId: 1, pedidoCancelado: false });
    expect(
      await esperar(caixa, 'item:cancelado'),
      'estorno de item muda o total do grid',
    ).not.toBeNull();

    emitirPedidoCancelado({ id: 1, comandaId: 1, status: 'CANCELADO' });
    expect(
      await esperar(caixa, 'pedido:cancelado'),
      'cancelar o pedido inteiro tambem',
    ).not.toBeNull();
  });

  it('CAIXA recebe conta:solicitada, COZINHA nao', async () => {
    const u = await amb.prisma.usuario.create({
      data: { nome: 'C', email: `c${proximaMesa++}@t`, senhaHash: 'x', role: 'COZINHA' },
    });
    const v = await amb.prisma.usuario.create({
      data: { nome: 'X', email: `x${proximaMesa++}@t`, senhaHash: 'x', role: 'CAIXA' },
    });

    const cozinha = await conectarCom(amb.tokenStaff(u.id, 'COZINHA'));
    const caixa = await conectarCom(amb.tokenStaff(v.id, 'CAIXA'));

    const { emitirContaSolicitada } = await import('../../src/realtime/emit.js');
    emitirContaSolicitada({ comandaId: 1, mesaNumero: 7, totalParcialCentavos: 4200 });

    expect(await esperar(caixa, 'conta:solicitada')).not.toBeNull();
    expect(await esperar(cozinha, 'conta:solicitada')).toBeNull();
  });

  it('ADMIN entra nas duas rooms', async () => {
    const u = await amb.prisma.usuario.create({
      data: { nome: 'A', email: `a${proximaMesa++}@t`, senhaHash: 'x', role: 'ADMIN' },
    });
    const admin = await conectarCom(amb.tokenStaff(u.id, 'ADMIN'));

    const { emitirPedidoNovo, emitirContaSolicitada } = await import('../../src/realtime/emit.js');
    emitirPedidoNovo(pedido(1));
    expect(await esperar(admin, 'pedido:novo')).not.toBeNull();

    emitirContaSolicitada({ comandaId: 1, mesaNumero: 7, totalParcialCentavos: 4200 });
    expect(await esperar(admin, 'conta:solicitada')).not.toBeNull();
  });

  /**
   * Staff nao entra em room de comanda. O caixa ve o total pelo HTTP
   * (`GET /caixa/comandas/:id`), nao por escuta passiva de todas as mesas.
   */
  it('staff nao recebe comanda:fechada de comanda que nao pediu', async () => {
    const a = await comandaNova();
    const cliente = await conectarCom(a.token); // controle: e o dono da comanda

    const u = await amb.prisma.usuario.create({
      data: { nome: 'C', email: `c${proximaMesa++}@t`, senhaHash: 'x', role: 'COZINHA' },
    });
    const cozinha = await conectarCom(amb.tokenStaff(u.id, 'COZINHA'));

    const { emitirComandaFechada } = await import('../../src/realtime/emit.js');
    emitirComandaFechada(fechada(a.comandaId));

    const [noCliente, naCozinha] = await Promise.all([
      esperar(cliente, 'comanda:fechada'),
      esperar(cozinha, 'comanda:fechada'),
    ]);

    expect(noCliente, 'controle: o dono da comanda TEM que receber').not.toBeNull();
    // comanda:fechada vai para ROOM_CAIXA + room da comanda. Cozinha nao entra:
    // ela nao tem nada a fazer com o total da conta.
    expect(naCozinha).toBeNull();
  });
});
