import { expect, test } from '@playwright/test';
import { adicionar, entrarComoCliente, prisma } from './apoio.js';

test.afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * ESTE arquivo e a razao de o E2E existir.
 *
 * Uma linha do MenuPage — `disabled={contaPedida || travado}` — impede um loop
 * fechado que travava o cliente. Nenhum teste de backend a alcanca: o servidor
 * esta correto nos dois casos, quem quebrava era a tela.
 *
 * O bug, reproduzido no navegador antes de existir esta correcao:
 *
 *   1. cliente manda picanha; o servidor GRAVA e a resposta se perde no wi-fi
 *   2. a tela diz "Falhou. Toque de novo — nao vai duplicar"
 *   3. o cliente adiciona uma coca e toca de novo
 *   4. mesma chave, conteudo diferente -> 409 (correto: senao a coca sumiria)
 *   5. a tela repete "toque de novo" -> 409 -> para sempre
 *
 * Tres toques, tres 409, e a picanha ja estava na cozinha sem ele saber.
 */
test.describe('retry com a resposta perdida no wi-fi', () => {
  /** Servidor recebe, cliente nao. O cenario que o Idempotency-Key existe para tratar. */
  async function engolirUmaResposta(page: import('@playwright/test').Page) {
    let primeira = true;
    await page.route('**/api/comandas/me/pedidos', async (route) => {
      if (primeira) {
        primeira = false;
        await route.fetch(); // vai ao servidor de verdade: o pedido ENTRA
        await route.abort('connectionfailed'); // o celular nunca recebe
        return;
      }
      await route.continue();
    });
  }

  test('o carrinho congela apos falha — e o reenvio passa', async ({ page }) => {
    await entrarComoCliente(page, 'Ana');
    await engolirUmaResposta(page);

    await adicionar(page, 'Coxinha de frango');
    await page.getByRole('button', { name: /enviar pedido/i }).click();
    await expect(page.getByRole('alert')).toBeVisible();

    // A CORRECAO: sem isto o cliente edita o carrinho e cai no 409 eterno.
    await expect(
      page.locator('li', { hasText: 'Croissant' }).getByRole('button', { name: /adicionar/i }),
      'com envio pendente, "Adicionar" tem que estar travado',
    ).toBeDisabled();
    await expect(page.getByRole('status')).toContainText(/reenvie este pedido/i);

    // O cliente faz o que a tela manda. Payload identico -> 200 com o pedido
    // original -> onSuccess limpa tudo e recarrega a comanda.
    await page.getByRole('button', { name: /enviar pedido/i }).click();

    await expect(page.getByRole('heading', { name: /seus pedidos/i })).toBeVisible();
    await expect(page.locator('aside')).toHaveCount(0); // carrinho sumiu
    await expect(page.getByRole('alert')).toHaveCount(0); // erro sumiu
  });

  test('o pedido perdido e cobrado UMA vez, nao duas', async ({ page }) => {
    const numero = await entrarComoCliente(page, 'Bruno');
    await engolirUmaResposta(page);

    // Croissant: R$ 8,90 no seed. Preco conhecido para conferir o total depois.
    await adicionar(page, 'Croissant');
    await page.getByRole('button', { name: /enviar pedido/i }).click();
    await expect(page.getByRole('alert')).toBeVisible();

    await page.getByRole('button', { name: /enviar pedido/i }).click();
    await expect(page.getByRole('heading', { name: /seus pedidos/i })).toBeVisible();

    // A tela mostra sucesso. O banco concorda? Duplicar aqui seria cobrar duas
    // vezes por um croissant que o cliente pediu uma.
    const pedidos = await prisma.pedido.count({ where: { comanda: { mesa: { numero } } } });
    expect(pedidos, 'a resposta perdida nao pode virar dois pedidos').toBe(1);

    await expect(page.getByText('Total: R$ 8,90')).toBeVisible();
  });
});
