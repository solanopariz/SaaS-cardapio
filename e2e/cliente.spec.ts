import { expect, test } from '@playwright/test';
import { adicionar, mesaLivre, prisma } from './apoio.js';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe('fluxo do cliente', () => {
  test('escaneia, entra, pede — e a URL nunca guarda o segredo', async ({ page }) => {
    const { numero, k } = await mesaLivre();

    await page.goto(`/menu?m=${numero}&k=${k}`);

    // O adesivo carrega o segredo, mas a barra de endereco nao pode: dali ele
    // vaza no historico, em screenshot e num link no WhatsApp.
    await expect(page).toHaveURL(/\/menu$/);
    expect(page.url(), 'o segredo da mesa ficou na URL').not.toContain(k);

    await expect(page.getByRole('heading', { name: `Mesa ${numero}` })).toBeVisible();
    await page.getByPlaceholder(/seu nome/i).fill('Ana');
    await page.getByRole('button', { name: /^entrar$/i }).click();

    await expect(page.getByRole('heading', { name: /padaria/i })).toBeVisible();
    await expect(page.getByText(`Mesa ${numero} · Ana`)).toBeVisible();

    await adicionar(page, 'Coxinha de frango'); // R$ 8,50
    await adicionar(page, 'Cafe expresso'); // R$ 5,00
    await expect(page.getByRole('heading', { name: /carrinho — r\$ 13,50/i })).toBeVisible();

    await page.getByRole('button', { name: /enviar pedido/i }).click();

    await expect(page.getByRole('heading', { name: /seus pedidos/i })).toBeVisible();
    await expect(page.getByText('Pedido #1')).toBeVisible();
    await expect(page.getByText('Total: R$ 13,50')).toBeVisible();

    // O banco concorda com a tela?
    const c = await prisma.comanda.findFirstOrThrow({
      where: { mesa: { numero } },
      include: { pedidos: { include: { itens: true } } },
    });
    expect(c.status).toBe('ABERTA');
    expect(c.totalCentavos, 'total NAO se grava enquanto a comanda esta aberta').toBeNull();
    expect(c.pedidos[0].itens).toHaveLength(2);
  });

  test('F5 nao perde a sessao', async ({ page }) => {
    const { numero, k } = await mesaLivre();
    await page.goto(`/menu?m=${numero}&k=${k}`);
    await page.getByPlaceholder(/seu nome/i).fill('Bruno');
    await page.getByRole('button', { name: /^entrar$/i }).click();
    await expect(page.getByRole('heading', { name: /padaria/i })).toBeVisible();

    // A URL ja perdeu o ?k=. Se o F5 dependesse dela, aqui voltaria para
    // "escaneie o QR" — o token no localStorage e o que sustenta.
    await page.reload();

    await expect(page.getByText(`Mesa ${numero} · Bruno`)).toBeVisible();
    await expect(page.getByPlaceholder(/seu nome/i)).toHaveCount(0);
  });

  test('QR invalido: erro claro, sem entrar', async ({ page }) => {
    const { numero } = await mesaLivre();
    await page.goto(`/menu?m=${numero}&k=0000000000000000`);

    await page.getByPlaceholder(/seu nome/i).fill('Intruso');
    await page.getByRole('button', { name: /^entrar$/i }).click();

    await expect(page.getByRole('alert')).toContainText(/qr code invalido/i);
    await expect(page.getByRole('heading', { name: /padaria/i })).toHaveCount(0);

    const comandas = await prisma.comanda.count({ where: { mesa: { numero } } });
    expect(comandas, 'chave errada nao pode abrir comanda').toBe(0);
  });

  test('sem QR: pede para escanear', async ({ page }) => {
    await page.goto('/menu');
    await expect(page.getByText(/escaneie o qr code/i)).toBeVisible();
  });

  test('dois celulares na mesma mesa: uma comanda, dois participantes', async ({ browser }) => {
    const { numero, k } = await mesaLivre();

    const a = await (await browser.newContext()).newPage();
    const b = await (await browser.newContext()).newPage();

    for (const [page, nome] of [
      [a, 'Ana'],
      [b, 'Bruno'],
    ] as const) {
      await page.goto(`/menu?m=${numero}&k=${k}`);
      await page.getByPlaceholder(/seu nome/i).fill(nome);
      await page.getByRole('button', { name: /^entrar$/i }).click();
      await expect(page.getByRole('heading', { name: /padaria/i })).toBeVisible();
    }

    await adicionar(a, 'Coxinha de frango');
    await a.getByRole('button', { name: /enviar pedido/i }).click();
    await expect(a.getByRole('heading', { name: /seus pedidos/i })).toBeVisible();

    // Conta compartilhada: o Bruno ve o pedido da Ana na comanda da mesa.
    await b.reload();
    await expect(b.getByText('Total: R$ 8,50')).toBeVisible();

    const comandas = await prisma.comanda.count({ where: { mesa: { numero }, status: 'ABERTA' } });
    expect(comandas, 'uniq_comanda_aberta: uma comanda por mesa').toBe(1);
  });
});
