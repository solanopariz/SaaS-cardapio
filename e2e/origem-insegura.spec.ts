import { expect, test } from '@playwright/test';
import { E2E } from '../playwright.config.js';
import { adicionar, entrarComoCliente, prisma } from './apoio.js';

/**
 * O celular do cliente, de verdade.
 *
 *   E2E_HOST=192.168.0.10 npm run test:e2e
 *
 * Com `E2E_HOST` a suite INTEIRA muda de origem (ver playwright.config.ts), e
 * este arquivo existe para provar que a mudanca aconteceu e que o app aguenta.
 *
 * POR QUE ISTO PRECISA EXISTIR: `localhost` e secure context por definicao, e a
 * suite sempre rodou nele. `crypto.randomUUID` so existe em secure context —
 * entao os 128 testes ficavam verdes enquanto o primeiro celular real batia num
 * TypeError dentro do `try` do SessionGate, ANTES de qualquer fetch. O usuario
 * via "Nao foi possivel entrar. Tente de novo." e o log da API ficava vazio: o
 * app acusava a rede de um erro que era dele.
 *
 * Pulado por padrao: o IP muda de rede para rede e nao existe em CI.
 */
test.skip(
  !E2E.origemInsegura,
  'defina E2E_HOST=<ip da sua maquina> para rodar na origem do celular',
);

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe('origem insegura (o celular do cliente)', () => {
  /**
   * CONTROLE POSITIVO DA RODADA INTEIRA, e o teste mais importante do arquivo.
   *
   * `E2E_HOST=localhost` ligaria tudo isto e continuaria em secure context —
   * verde, e provando exatamente nada. Se este teste falhar, os outros deste
   * arquivo nao significam nada.
   */
  test('CONTROLE: a suite esta MESMO fora de secure context', async ({ page }) => {
    await page.goto('/');

    expect(
      await page.evaluate(() => window.isSecureContext),
      `${E2E.urlWeb} ainda e secure context — E2E_HOST precisa ser o IP da maquina, nao localhost`,
    ).toBe(false);

    expect(
      await page.evaluate(() => typeof crypto.randomUUID),
      'crypto.randomUUID existe aqui: esta origem nao reproduz o celular',
    ).toBe('undefined');
  });

  /**
   * O fluxo que quebrou. `obterDeviceId()` (join) e a chave de idempotencia
   * (pedido) chamavam `crypto.randomUUID` direto; hoje passam por `uuidV4`.
   */
  test('cliente entra e pede pelo IP, como no restaurante', async ({ page }) => {
    const numero = await entrarComoCliente(page, 'Lia');

    await adicionar(page, 'Prato feito'); // R$ 28,90
    await page.getByRole('button', { name: /enviar pedido/i }).click();

    await expect(page.getByText('Total: R$ 28,90')).toBeVisible();

    // Chegou no banco: sem isto, "a tela mostrou o total" passaria com um
    // pedido que nunca saiu do celular — que e exatamente o bug original.
    await expect
      .poll(async () => {
        const c = await prisma.comanda.findFirst({
          where: { mesa: { numero } },
          include: { pedidos: true },
        });
        return c?.pedidos.length ?? 0;
      })
      .toBe(1);
  });

  test('o deviceId gravado e um UUID valido, nao "undefined"', async ({ page }) => {
    await entrarComoCliente(page, 'Marco');

    const id = await page.evaluate(() => localStorage.getItem('device_id_v1'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
