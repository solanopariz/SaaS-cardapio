import { buildApp } from './app.js';
import { env } from './lib/env.js';
import { prisma } from './lib/prisma.js';
import { configurarLogEventos } from './realtime/emit.js';
import { criarIo } from './realtime/io.js';

const app = buildApp();

async function main(): Promise<void> {
  // ANTES do listen. `app.server` existe desde a construcao do Fastify — nao
  // e preciso esperar o listen para monta-lo.
  //
  // Montar DEPOIS abria uma janela entre `listen()` e `criarIo()` em que a API
  // ja aceitava request com `io` ainda null: um /join ali commitava a comanda
  // e so entao estourava no emit, devolvendo 500 para uma operacao que deu
  // certo. Milissegundos — mas exatamente no boot, que e a hora do deploy e a
  // hora em que o salao inteiro reconecta.
  criarIo(app.server);
  configurarLogEventos(app.log);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });

  app.log.info(`API em :${env.PORT} — Socket.IO no mesmo servidor`);
}

/**
 * Encerramento limpo: para de aceitar conexoes, espera as em voo, fecha o
 * pool do Prisma. Sem isto, um deploy no meio de um `fecharComanda` deixa a
 * transacao pendurada ate o timeout do Postgres.
 */
for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sinal, () => {
    void (async () => {
      app.log.info(`${sinal} recebido, encerrando`);
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    })();
  });
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
