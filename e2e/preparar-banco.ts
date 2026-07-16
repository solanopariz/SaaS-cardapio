import { execFileSync } from 'node:child_process';
import { E2E } from '../playwright.config.js';

/**
 * Roda UMA vez, antes do webServer subir. Derruba e recria `cardapio_e2e`,
 * aplica as migrations e roda o seed DE VERDADE — o mesmo `prisma/seed.ts` que
 * o `npm run db:seed` usa.
 *
 * `migrate reset` cria o banco se ele nao existir, entao a primeira rodada
 * numa maquina nova funciona sem passo manual.
 *
 * Nao reimplementar o seed aqui: um seed imitado prova que a imitacao funciona.
 * Foi exatamente assim que `cozinha@local` sobreviveu — nada nunca logou.
 */
export default function preparar(): void {
  execFileSync(
    'npx',
    ['prisma', 'migrate', 'reset', '--force', '--skip-generate'],
    {
      cwd: 'apps/api',
      env: { ...process.env, DATABASE_URL: E2E.databaseUrl },
      stdio: 'pipe',
      shell: true,
    },
  );
}
