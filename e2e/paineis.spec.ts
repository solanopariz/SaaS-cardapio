import { expect, test } from '@playwright/test';
import {
  EMAIL_CAIXA,
  EMAIL_COZINHA,
  adicionar,
  entrarComoCliente,
  logarStaff,
  pedidosNaCozinha,
  prisma,
  totalNoGrid,
} from './apoio.js';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe('login do staff', () => {
  /**
   * As credenciais que o README anuncia tem que entrar. Elas NAO entravam:
   * o seed criava `cozinha@local`, o `loginSchema` valida com
   * `z.string().email()` (exige TLD) e o Zod devolvia 400 antes de olhar a
   * senha. Os dois paineis eram inacessiveis desde que o projeto existe.
   */
  test('cozinha entra e ve o painel', async ({ page }) => {
    await logarStaff(page, EMAIL_COZINHA);
    await expect(page).toHaveURL(/\/painel\/cozinha/);
    await expect(page.getByRole('heading', { name: /cozinha/i })).toBeVisible();
  });

  test('caixa entra e ve o grid de mesas', async ({ page }) => {
    await logarStaff(page, EMAIL_CAIXA);
    await expect(page).toHaveURL(/\/painel\/caixa/);
    await expect(page.getByRole('heading', { name: 'Caixa' })).toBeVisible();
    await expect(page.getByText('Mesa 20')).toBeVisible(); // o seed cria 20
  });

  test('rota de painel sem login manda para /login', async ({ page }) => {
    await page.goto('/painel/caixa');
    await expect(page).toHaveURL(/\/login/);
  });

  test('senha errada nao entra', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('email').fill(EMAIL_COZINHA);
    await page.getByPlaceholder('senha').fill('senhaerrada');
    await page.getByRole('button', { name: /entrar/i }).click();
    await expect(page.getByRole('alert')).toContainText(/invalidos/i);
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('tempo real', () => {
  /**
   * A claim central do useSocket: o painel aplica DELTAS via setQueryData, sem
   * refetch. Nenhum reload acontece aqui — se o numero muda, foi o socket.
   */
  test('cliente pede -> cozinha e caixa veem sem refresh', async ({ browser }) => {
    const cozinha = await (await browser.newContext()).newPage();
    const caixa = await (await browser.newContext()).newPage();
    await logarStaff(cozinha, EMAIL_COZINHA);
    await logarStaff(caixa, EMAIL_CAIXA);
    await expect(cozinha.getByRole('heading', { name: /cozinha/i })).toBeVisible();
    await expect(caixa.getByRole('heading', { name: 'Caixa' })).toBeVisible();

    const antes = await pedidosNaCozinha(cozinha);

    const cliente = await (await browser.newContext()).newPage();
    const numero = await entrarComoCliente(cliente, 'Carla');

    // CONTROLE POSITIVO: so entrar ja acende a mesa no caixa, via `mesa:status`.
    // Sem isto, um "o total nao chegou" nao distinguiria socket quebrado de
    // socket funcionando — e um teste de negativa vazio ja me enganou hoje.
    await expect
      .poll(() => totalNoGrid(caixa, numero), { message: 'a mesa nao acendeu no caixa ao entrar' })
      .toBe('R$ 0,00');

    await adicionar(cliente, 'Suco de laranja 300ml'); // R$ 11,00
    await cliente.getByRole('button', { name: /enviar pedido/i }).click();

    // Sem reload em nenhum dos dois painéis.
    await expect
      .poll(() => pedidosNaCozinha(cozinha), { message: 'a cozinha nao recebeu o pedido' })
      .toBe(antes + 1);
    await expect(cozinha.getByText('Suco de laranja 300ml')).toBeVisible();

    // O caixa so atualiza o total do grid por socket (`staleTime: Infinity`).
    // Enquanto `pedido:novo` ia so para a cozinha, este numero ficava congelado
    // o servico inteiro.
    await expect
      .poll(() => totalNoGrid(caixa, numero), { message: 'o total do grid do caixa congelou' })
      .toBe('R$ 11,00');
  });

  test('cozinha marca EM_PREPARO -> o celular do cliente ve', async ({ browser }) => {
    const cozinha = await (await browser.newContext()).newPage();
    await logarStaff(cozinha, EMAIL_COZINHA);
    await expect(cozinha.getByRole('heading', { name: /cozinha/i })).toBeVisible();

    const cliente = await (await browser.newContext()).newPage();
    await entrarComoCliente(cliente, 'Diego');
    await adicionar(cliente, 'Omelete');
    await cliente.getByRole('button', { name: /enviar pedido/i }).click();
    await expect(cliente.getByText('Pedido #1')).toBeVisible();

    await cozinha
      .locator('li, article')
      .filter({ hasText: 'Omelete' })
      .getByRole('button', { name: /EM_PREPARO/i })
      .first()
      .click();

    // Sem reload no celular.
    await expect(cliente.getByText(/EM_PREPARO/)).toBeVisible();
  });
});

test.describe('fechamento no caixa', () => {
  test('caixa fecha a conta e a mesa volta a LIVRE', async ({ browser }) => {
    const cliente = await (await browser.newContext()).newPage();
    const numero = await entrarComoCliente(cliente, 'Elisa');
    await adicionar(cliente, 'Prato feito'); // R$ 28,90
    await cliente.getByRole('button', { name: /enviar pedido/i }).click();
    await expect(cliente.getByText('Total: R$ 28,90')).toBeVisible();

    const caixa = await (await browser.newContext()).newPage();
    await logarStaff(caixa, EMAIL_CAIXA);
    await expect(caixa.getByRole('heading', { name: 'Caixa' })).toBeVisible();

    await caixa.getByRole('button', { name: new RegExp(`Mesa ${numero}\\b`) }).click();
    await expect(caixa.getByText('Total: R$ 28,90')).toBeVisible();
    await expect(caixa.getByText('Elisa: R$ 28,90')).toBeVisible(); // divisao por participante
    await caixa.getByRole('button', { name: 'PIX', exact: true }).click();

    // O recibo so existe apos o fechamento — enquanto aberta, o total e derivado.
    await expect
      .poll(async () => {
        const c = await prisma.comanda.findFirst({ where: { mesa: { numero } } });
        return { status: c?.status, total: c?.totalCentavos };
      })
      .toEqual({ status: 'FECHADA', total: 2890 });

    const mesa = await prisma.mesa.findFirstOrThrow({ where: { numero } });
    expect(mesa.status, 'a mesa tem que liberar para o proximo cliente').toBe('LIVRE');

    // O celular do cliente recebe comanda:fechada, limpa o storage e volta.
    await expect(cliente.getByText(/escaneie o qr code/i)).toBeVisible();
  });
});
