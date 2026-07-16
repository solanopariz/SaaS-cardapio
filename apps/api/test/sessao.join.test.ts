import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { subirAmbiente, type Ambiente } from './helpers/ambiente.js';

let amb: Ambiente;

// Subir container + migrar leva dezenas de segundos na primeira vez.
beforeAll(async () => {
  amb = await subirAmbiente();
}, 180_000);

afterAll(async () => {
  await amb?.parar();
});

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Cada teste usa uma mesa propria: nada de ordem de execucao virar dependencia. */
async function criarMesa(numero: number): Promise<{ id: number; k: string }> {
  const k = randomBytes(8).toString('hex'); // 16 chars hex, igual ao qrSecretSchema
  const mesa = await amb.prisma.mesa.create({ data: { numero, qrSecret: k } });
  return { id: mesa.id, k };
}

function join(mesa: number, k: string, apelido: string, deviceId = randomUUID()) {
  return amb.app.inject({
    method: 'POST',
    url: '/api/sessions/join',
    payload: { mesa, k, apelido, deviceId },
  });
}

describe('POST /sessions/join', () => {
  /**
   * O teste realista. Vale pouco sozinho: ele afirma so o RESULTADO, que e o
   * mesmo com ou sem colisao. Se o escalonador serializar os 12, ele passa
   * verde sem ter testado nada. O que prova o caminho da corrida e o teste
   * seguinte, deterministico. Este aqui existe para pegar o que o outro nao
   * pega: pool esgotado, deadlock, 500 sob concorrencia real.
   */
  it('12 celulares no mesmo instante: uma comanda, 12 participantes', async () => {
    const numero = 901;
    const { k } = await criarMesa(numero);

    const rs = await Promise.all(
      Array.from({ length: 12 }, (_, i) => join(numero, k, `Cliente${i + 1}`)),
    );

    const criou = rs.filter((r) => r.statusCode === 201);
    const anexou = rs.filter((r) => r.statusCode === 200);

    // Exatamente um abriu a comanda. Dois 201 = duas comandas abertas na mesma
    // mesa = a conta do cliente partida em duas.
    expect(criou).toHaveLength(1);
    expect(anexou).toHaveLength(11);

    const corpos = rs.map((r) => r.json());
    const comandaIds = new Set(corpos.map((c) => c.comandaId));
    const participanteIds = new Set(corpos.map((c) => c.participanteId));

    expect(comandaIds.size).toBe(1);
    expect(participanteIds.size).toBe(12); // ninguem sobrescreveu ninguem

    // E o banco concorda com a API.
    const abertas = await amb.prisma.comanda.count({
      where: { mesa: { numero }, status: 'ABERTA' },
    });
    expect(abertas).toBe(1);
  });

  /**
   * ESTE e o teste que importa. Ele nao torce para o escalonador colidir — ele
   * FORCA a colisao e prova que o `catch (P2002) -> tentar()` de
   * sessao.service.ts executa e anexa.
   *
   * Como: abre uma transacao que cria a comanda e NAO commita. Enquanto ela
   * vive, o INSERT do /join bloqueia no indice unico. Ao commit, o /join toma
   * 23505 -> P2002 -> retry -> encontra a comanda -> anexa (200, nao 201).
   *
   * Se alguem trocar o retry por um `if (mesa.status === 'LIVRE')`, este teste
   * fica vermelho. O de cima, nao necessariamente.
   */
  it('perdedor da corrida anexa em vez de estourar (caminho P2002)', async () => {
    const numero = 902;
    const { id: mesaId, k } = await criarMesa(numero);

    let liberar!: () => void;
    const bloqueio = new Promise<void>((r) => {
      liberar = r;
    });

    const txPendente = amb.prisma.$transaction(
      async (tx) => {
        await tx.comanda.create({ data: { mesaId } });
        await bloqueio; // segura a transacao aberta, sem commitar
      },
      { timeout: 30_000 },
    );

    await espera(300); // a tx pendente pega o indice

    const promessaJoin = join(numero, k, 'Atrasado');
    await espera(300); // o join chega e BLOQUEIA no indice unico

    liberar();
    await txPendente; // commit -> o join bloqueado toma 23505

    const r = await promessaJoin;

    // 200 = anexou na comanda do vencedor. 201 significaria que ele abriu uma
    // segunda comanda; 500 significaria que o P2002 vazou sem tratamento.
    expect(r.statusCode).toBe(200);
    expect(r.json().comandaNova).toBe(false);

    const abertas = await amb.prisma.comanda.count({
      where: { mesaId, status: 'ABERTA' },
    });
    expect(abertas).toBe(1);
  });

  it('mesmo celular reentrando (F5) reaproveita o participante', async () => {
    const numero = 903;
    const { k } = await criarMesa(numero);
    const device = randomUUID();

    const primeira = await join(numero, k, 'Ana', device);
    const segunda = await join(numero, k, 'Ana', device);

    expect(primeira.statusCode).toBe(201);
    expect(segunda.statusCode).toBe(200);
    // Mesmo device na mesma comanda = mesmo participante. Senao a comanda
    // enche de "Ana", "Ana", "Ana" a cada F5.
    expect(segunda.json().participanteId).toBe(primeira.json().participanteId);
  });

  it('chave errada e mesa inexistente devolvem 401 identico', async () => {
    const numero = 904;
    await criarMesa(numero);

    const chaveErrada = await join(numero, randomBytes(8).toString('hex'), 'Intruso');
    const mesaFantasma = await join(9999, randomBytes(8).toString('hex'), 'Intruso');

    expect(chaveErrada.statusCode).toBe(401);
    expect(mesaFantasma.statusCode).toBe(401);
    // Mensagens identicas: confirmar que a mesa 9999 nao existe entrega o mapa
    // do salao para quem esta chutando URL.
    expect(mesaFantasma.json()).toEqual(chaveErrada.json());
  });
});
