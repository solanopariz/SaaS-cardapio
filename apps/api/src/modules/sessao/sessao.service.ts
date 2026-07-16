import { Prisma } from '@prisma/client';
import type { JoinSessao } from '@cardapio/shared';
import { prisma } from '../../lib/prisma.js';
import { naoAutorizado, PRISMA_UNIQUE_VIOLATION } from '../../lib/errors.js';
import { assinarTokenComanda, segredoQrConfere } from '../../plugins/auth.js';
import { emitirMesaStatus } from '../../realtime/emit.js';

export interface ResultadoJoin {
  token: string;
  comandaId: number;
  participanteId: number;
  apelido: string;
  mesaNumero: number;
  /** true se esta comanda foi aberta agora (primeiro da mesa) */
  comandaNova: boolean;
}

/**
 * Cliente escaneou o QR. Valida o segredo da mesa, abre ou anexa a comanda,
 * cria o participante e devolve o JWT de comanda.
 *
 * CORRIDA: dois celulares escaneiam a mesa 14 no mesmo instante, ambos veem
 * `status = LIVRE`, ambos tentam criar comanda. Um `if (livre) create()` NAO
 * resolve — entre o SELECT e o INSERT cabe a outra transacao.
 *
 * Quem resolve e o indice unico parcial `uniq_comanda_aberta` (migration 002).
 * O perdedor toma P2002 e nos reagimos anexando a comanda que o vencedor criou.
 * O banco e o arbitro; a aplicacao so interpreta o resultado.
 */
export async function join(input: JoinSessao): Promise<ResultadoJoin> {
  const mesa = await prisma.mesa.findUnique({ where: { numero: input.mesa } });

  // Mesma mensagem para mesa inexistente e chave errada: nao confirmamos a
  // existencia da mesa 999 para quem esta chutando URLs.
  if (!mesa || !segredoQrConfere(input.k, mesa.qrSecret)) {
    throw naoAutorizado('mesa ou chave invalida');
  }

  const tentar = async (): Promise<Omit<ResultadoJoin, 'token'>> =>
    prisma.$transaction(async (tx) => {
      let comanda = await tx.comanda.findFirst({
        where: { mesaId: mesa.id, status: 'ABERTA' },
      });

      const comandaNova = comanda === null;

      if (!comanda) {
        // Pode lancar P2002 se outra transacao criou primeiro.
        comanda = await tx.comanda.create({ data: { mesaId: mesa.id } });
        await tx.mesa.update({ where: { id: mesa.id }, data: { status: 'OCUPADA' } });
      }

      // Mesmo celular reentrando (F5, ou voltou depois) reaproveita o participante
      // em vez de criar "Ana", "Ana", "Ana" na comanda.
      const participante = await tx.participante.upsert({
        where: { comandaId_deviceId: { comandaId: comanda.id, deviceId: input.deviceId } },
        create: { comandaId: comanda.id, deviceId: input.deviceId, apelido: input.apelido },
        update: { apelido: input.apelido },
      });

      return {
        comandaId: comanda.id,
        participanteId: participante.id,
        apelido: participante.apelido,
        mesaNumero: mesa.numero,
        comandaNova,
      };
    });

  let r: Omit<ResultadoJoin, 'token'>;
  try {
    r = await tentar();
  } catch (e) {
    const perdeuACorrida =
      e instanceof Prisma.PrismaClientKnownRequestError && e.code === PRISMA_UNIQUE_VIOLATION;
    if (!perdeuACorrida) throw e;
    // A comanda agora existe: a segunda tentativa cai no ramo "anexar".
    r = await tentar();
  }

  const token = assinarTokenComanda({
    comandaId: r.comandaId,
    participanteId: r.participanteId,
    mesaId: mesa.id,
    mesaNumero: mesa.numero,
  });

  // Pos-commit. Painel do caixa ve a mesa acender.
  if (r.comandaNova) {
    emitirMesaStatus({
      mesaId: mesa.id,
      numero: mesa.numero,
      status: 'OCUPADA',
      comandaId: r.comandaId,
    });
  }

  return { token, ...r };
}
