import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

const RAIZ_API = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface Ambiente {
  app: FastifyInstance;
  prisma: PrismaClient;
  /** Token de staff assinado direto, sem passar pelo /login (bcrypt e lento). */
  tokenStaff: (usuarioId: number, role: 'ADMIN' | 'COZINHA' | 'CAIXA') => string;
  parar: () => Promise<void>;
}

/**
 * Postgres de verdade, num container descartavel.
 *
 * Nao da para trocar isto por sqlite nem por mock: o que esta sob teste E o
 * arbitro do banco. `uniq_comanda_aberta` e um indice unico PARCIAL
 * (`WHERE status = 'ABERTA'`) — sqlite nem tem isso, e um mock so devolveria
 * a resposta que o autor do mock ja acreditava.
 */
export async function subirAmbiente(opcoes: { semear?: boolean } = {}): Promise<Ambiente> {
  const container = await new PostgreSqlContainer('postgres:16').start();

  // connection_limit alto de proposito: com pool pequeno as transacoes
  // serializam na fila do Prisma e a corrida vira fila indiana — o teste
  // passaria sem nunca ter colidido.
  const url = `${container.getConnectionUri()}?connection_limit=25`;

  // migrate deploy (nao `dev`): aplica 001 e 002 e nao tenta gerar migration nova.
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: RAIZ_API,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
    shell: true,
  });

  // Roda o seed DE VERDADE, como subprocesso, exatamente como `npm run db:seed`.
  // Nao reimplementar o seed no teste: um seed imitado prova que a imitacao
  // funciona. Foi assim que `cozinha@local` sobreviveu — o login nunca rodou.
  if (opcoes.semear) {
    execFileSync('npx', ['tsx', 'prisma/seed.ts'], {
      cwd: RAIZ_API,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
      shell: true,
    });
  }

  // env.ts valida process.env NA IMPORTACAO e chama process.exit(1) se faltar
  // algo — o que mataria o worker do vitest sem explicacao. Por isso todo o
  // env e setado aqui, ANTES do primeiro import de qualquer coisa que puxe
  // env.ts na cadeia. Dai os imports abaixo serem dinamicos.
  process.env.DATABASE_URL = url;
  process.env.JWT_SECRET_STAFF = randomBytes(32).toString('hex');
  process.env.JWT_SECRET_COMANDA = randomBytes(32).toString('hex');
  process.env.APP_PUBLIC_URL = 'http://localhost:5173';
  process.env.NODE_ENV = 'test';

  const { buildApp } = await import('../../src/app.js');
  const { prisma } = await import('../../src/lib/prisma.js');
  const { criarIo } = await import('../../src/realtime/io.js');
  const { assinarTokenStaff } = await import('../../src/plugins/auth.js');

  const app = buildApp();
  await app.ready();

  // Monta o Socket.IO como o server.ts faz. Sem isto os emits falhariam em
  // silencio (ver REGRA 2 em emit.ts) e os testes passariam verdes sem nunca
  // ter executado o caminho de emissao — que e justamente onde o 500 do boot
  // se escondia.
  criarIo(app.server);

  return {
    app,
    prisma,
    tokenStaff: (usuarioId, role) => assinarTokenStaff({ usuarioId, role }),
    parar: async () => {
      await app.close();
      await prisma.$disconnect();
      await container.stop();
    },
  };
}
