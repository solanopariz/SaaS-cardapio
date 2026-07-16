import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../lib/env.js';
import { naoAutorizado, proibido } from '../lib/errors.js';

// --- Payloads -------------------------------------------------------------

export interface TokenStaff {
  tipo: 'staff';
  usuarioId: number;
  role: Role;
}

export interface TokenComanda {
  tipo: 'comanda';
  comandaId: number;
  participanteId: number;
  mesaId: number;
  mesaNumero: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    staff?: TokenStaff;
    comanda?: TokenComanda;
  }
}

// --- Emissao --------------------------------------------------------------

export function assinarTokenStaff(p: Omit<TokenStaff, 'tipo'>): string {
  return jwt.sign({ ...p, tipo: 'staff' } satisfies TokenStaff, env.JWT_SECRET_STAFF, {
    expiresIn: '12h', // um turno
  });
}

/**
 * Sem `expiresIn`. O token de comanda nao expira por tempo — ele morre quando
 * o caixa fecha a mesa, e a verificacao disso e feita contra o banco em
 * `GET /comandas/me` (410 Gone). Uma refeicao pode durar 20min ou 4h; qualquer
 * TTL que eu escolhesse aqui estaria errado para metade das mesas.
 */
export function assinarTokenComanda(p: Omit<TokenComanda, 'tipo'>): string {
  return jwt.sign({ ...p, tipo: 'comanda' } satisfies TokenComanda, env.JWT_SECRET_COMANDA);
}

// --- Verificacao ----------------------------------------------------------

export function verificarTokenStaff(token: string): TokenStaff {
  try {
    const p = jwt.verify(token, env.JWT_SECRET_STAFF) as TokenStaff;
    if (p.tipo !== 'staff') throw new Error('tipo errado');
    return p;
  } catch {
    throw naoAutorizado('token de staff invalido');
  }
}

export function verificarTokenComanda(token: string): TokenComanda {
  try {
    const p = jwt.verify(token, env.JWT_SECRET_COMANDA) as TokenComanda;
    if (p.tipo !== 'comanda') throw new Error('tipo errado');
    return p;
  } catch {
    throw naoAutorizado('token de comanda invalido');
  }
}

function extrairBearer(req: FastifyRequest): string {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw naoAutorizado('faltou o header Authorization');
  return h.slice('Bearer '.length);
}

// --- Guards (use em `preHandler`) ----------------------------------------

export async function exigirComanda(req: FastifyRequest): Promise<void> {
  req.comanda = verificarTokenComanda(extrairBearer(req));
}

export async function exigirStaff(req: FastifyRequest): Promise<void> {
  req.staff = verificarTokenStaff(extrairBearer(req));
}

/** ADMIN passa em qualquer guard de role. */
export function exigirRole(...roles: Role[]) {
  return async (req: FastifyRequest): Promise<void> => {
    await exigirStaff(req);
    const role = req.staff!.role;
    if (role !== 'ADMIN' && !roles.includes(role)) {
      throw proibido(`requer role: ${roles.join(' ou ')}`);
    }
  };
}

// --- Comparacao do segredo do QR -----------------------------------------

/**
 * Comparacao em tempo constante. Um `===` vaza, pelo tempo de resposta, quantos
 * chars iniciais do segredo estao certos — o que reduz a quebra de 16^16 para
 * ~16*16 tentativas. Improvavel de explorar sobre HTTP com ruido de rede, mas
 * o custo de fazer certo e uma linha.
 */
export function segredoQrConfere(informado: string, armazenado: string): boolean {
  const a = Buffer.from(informado, 'utf8');
  const b = Buffer.from(armazenado, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export default fp(async () => {
  // Plugin sem estado: existe so para o `declare module` acima ser carregado.
});
