import { defineConfig, devices } from '@playwright/test';

/**
 * E2E da stack inteira: Postgres -> API -> Vite -> Chromium.
 *
 * PRECISA de Docker (ou um Postgres local) rodando. O `globalSetup` cria o
 * banco `cardapio_e2e` do zero a cada rodada.
 *
 * ISOLAMENTO — o E2E nao toca no seu ambiente de dev:
 *
 *   - banco proprio (`cardapio_e2e`, nao `cardapio`), derramado e resemeado a
 *     cada `npm run test:e2e`;
 *   - portas proprias (3399/5199, nao 3333/5173).
 *
 * Sem isso, rodar o E2E com o `npm run dev` aberto derrubaria o seu banco e
 * trocaria os `qr_secret` de todas as mesas — e os QR ja impressos parariam.
 *
 * O `--env-file` do Node NAO sobrescreve variavel ja presente no ambiente
 * (verificado), entao passar DATABASE_URL/PORT aqui vence o `.env` da raiz.
 */

process.loadEnvFile('.env'); // Node 22. Sem dependencia de dotenv.

const PORTA_API = 3399;
const PORTA_WEB = 5199;

/**
 * `E2E_HOST=192.168.0.10 npm run test:e2e` roda a suite INTEIRA pela rede, na
 * origem que o celular do cliente usa de verdade.
 *
 * Isto nao e sobre a rede: e sobre SECURE CONTEXT. `localhost` e secure context
 * por definicao, e a suite inteira sempre rodou nele — por isso os 128 testes
 * passavam verdes enquanto `crypto.randomUUID` (que so existe em secure
 * context) estourava no primeiro celular real, antes de qualquer requisicao
 * sair. Ver `e2e/origem-insegura.spec.ts` e `packages/shared/src/uuid.ts`.
 *
 * Opt-in porque o IP muda de rede para rede e nao existe em CI. O default
 * continua `localhost`.
 */
const HOST_WEB = process.env.E2E_HOST ?? 'localhost';

function bancoE2E(): string {
  const u = new URL(process.env.DATABASE_URL ?? '');
  u.pathname = '/cardapio_e2e';
  return u.toString();
}

export const E2E = {
  urlWeb: `http://${HOST_WEB}:${PORTA_WEB}`,
  // A API continua em localhost: quem fala com ela e o proxy do Vite, que roda
  // nesta mesma maquina. So a porta do Vite precisa ser alcancavel de fora.
  urlApi: `http://localhost:${PORTA_API}`,
  databaseUrl: bancoE2E(),
  /** Verdadeiro quando a suite esta rodando fora de secure context. */
  origemInsegura: HOST_WEB !== 'localhost',
};

const envApi = {
  ...process.env,
  DATABASE_URL: E2E.databaseUrl,
  PORT: String(PORTA_API),
  CORS_ORIGIN: E2E.urlWeb,
  APP_PUBLIC_URL: E2E.urlWeb,
  NODE_ENV: 'development',
};

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/preparar-banco.ts',
  // Sem paralelismo: os specs compartilham um banco so. Duas mesas diferentes
  // por spec seria possivel, mas o ganho nao paga a chance de flake.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0, // um E2E que so passa na 2a tentativa esta escondendo corrida
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 8_000 },

  use: {
    baseURL: E2E.urlWeb,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      command: 'npm run dev:api',
      url: `${E2E.urlApi}/health`,
      env: envApi,
      reuseExistingServer: false, // JAMAIS reusar: o de dev aponta pro banco de dev
      stdout: 'pipe',
      timeout: 120_000,
    },
    {
      command: 'npm run dev:web',
      url: E2E.urlWeb,
      env: {
        ...process.env,
        WEB_PORT: String(PORTA_WEB),
        API_ALVO: E2E.urlApi,
        // So expoe na rede quando o teste pediu por isso.
        WEB_HOST: E2E.origemInsegura ? '0.0.0.0' : 'localhost',
      },
      reuseExistingServer: false,
      stdout: 'pipe',
      timeout: 120_000,
    },
  ],
});
