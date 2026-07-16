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

  /**
   * DINHEIRO ponta a ponta. A API sempre soube calcular troco; a tela mandava o
   * valor exato do total, entao `trocoCentavos` era 0,00 em todo fechamento em
   * dinheiro desde que o projeto existe — e o `onSuccess` jogava o numero fora
   * de qualquer jeito. Dois lados corretos, ninguem ligando o fio.
   */
  test('DINHEIRO: preview do troco enquanto digita, e o recibo confirma', async ({ browser }) => {
    const cliente = await (await browser.newContext()).newPage();
    const numero = await entrarComoCliente(cliente, 'Fabio');
    await adicionar(cliente, 'Prato feito'); // R$ 28,90
    await cliente.getByRole('button', { name: /enviar pedido/i }).click();
    await expect(cliente.getByText('Total: R$ 28,90')).toBeVisible();

    const caixa = await (await browser.newContext()).newPage();
    await logarStaff(caixa, EMAIL_CAIXA);
    await caixa.getByRole('button', { name: new RegExp(`Mesa ${numero}\\b`) }).click();
    await expect(caixa.getByText('Total: R$ 28,90')).toBeVisible();

    const valor = caixa.getByTestId('valor-recebido');
    const dinheiro = caixa.getByRole('button', { name: 'DINHEIRO', exact: true });

    // Nota de 50 na mao do cliente: o troco aparece ANTES de confirmar, que e
    // quando o operador precisa dele para separar as notas.
    await valor.fill('50');
    await expect(caixa.getByTestId('troco-preview')).toHaveText('Troco: R$ 21,10');

    await dinheiro.click();

    // O RECIBO. Este numero vem da API, nao do preview — e o dialogo nao some
    // sozinho, senao o troco ia embora antes de o operador ler.
    await expect(caixa.getByTestId('troco-final')).toHaveText('Troco: R$ 21,10');

    await expect
      .poll(async () => {
        const c = await prisma.comanda.findFirst({ where: { mesa: { numero } } });
        return { status: c?.status, total: c?.totalCentavos, metodo: c?.metodoPagamento };
      })
      .toEqual({ status: 'FECHADA', total: 2890, metodo: 'DINHEIRO' });
  });

  test('DINHEIRO: valor que nao cobre a conta nao fecha nada', async ({ browser }) => {
    const cliente = await (await browser.newContext()).newPage();
    const numero = await entrarComoCliente(cliente, 'Gisele');
    await adicionar(cliente, 'Prato feito'); // R$ 28,90
    await cliente.getByRole('button', { name: /enviar pedido/i }).click();

    const caixa = await (await browser.newContext()).newPage();
    await logarStaff(caixa, EMAIL_CAIXA);
    await caixa.getByRole('button', { name: new RegExp(`Mesa ${numero}\\b`) }).click();
    await expect(caixa.getByText('Total: R$ 28,90')).toBeVisible();

    const valor = caixa.getByTestId('valor-recebido');
    const dinheiro = caixa.getByRole('button', { name: 'DINHEIRO', exact: true });

    await valor.fill('20');
    await expect(caixa.getByText('Falta R$ 8,90.')).toBeVisible();
    await expect(dinheiro).toBeDisabled();

    // `parsearBRL` recusa ponto de milhar de proposito ("1.500" e mil e
    // quinhentos ou um e cinquenta?). A DECISAO foi que quem chama avisa o
    // usuario — este teste e o cumprimento dessa parte do contrato.
    await valor.fill('1.500');
    await expect(caixa.getByTestId('valor-invalido')).toBeVisible();
    await expect(dinheiro).toBeDisabled();

    // CONTROLE POSITIVO: o mesmo valor sem o separador destrava. Sem este par,
    // "o botao fica desabilitado" passaria tambem se ele estivesse SEMPRE
    // desabilitado — e ai o caixa nunca receberia dinheiro.
    await valor.fill('1500');
    await expect(dinheiro).toBeEnabled();
    await expect(caixa.getByTestId('troco-preview')).toHaveText('Troco: R$ 1.471,10');

    const c = await prisma.comanda.findFirst({ where: { mesa: { numero } } });
    expect(c?.status, 'nada disso pode ter fechado a conta').not.toBe('FECHADA');
  });

  /**
   * A conta muda com o dialogo aberto. O caixa leu R$ 28,90; o amigo pede uma
   * cerveja pelo celular; o caixa clica em DINHEIRO com 50 na mao achando que
   * devolve 21,10. A API cobraria o total NOVO — o dela sempre esteve certo — e
   * a diferenca sairia do bolso de alguem, em silencio.
   */
  test('conta muda com o dialogo aberto: recusa em vez de cobrar o valor novo', async ({
    browser,
  }) => {
    const cliente = await (await browser.newContext()).newPage();
    const numero = await entrarComoCliente(cliente, 'Helena');
    await adicionar(cliente, 'Prato feito'); // R$ 28,90
    await cliente.getByRole('button', { name: /enviar pedido/i }).click();

    const caixa = await (await browser.newContext()).newPage();
    await logarStaff(caixa, EMAIL_CAIXA);
    await caixa.getByRole('button', { name: new RegExp(`Mesa ${numero}\\b`) }).click();
    await expect(caixa.getByText('Total: R$ 28,90')).toBeVisible();
    await caixa.getByTestId('valor-recebido').fill('50');
    await expect(caixa.getByTestId('troco-preview')).toHaveText('Troco: R$ 21,10');

    // O amigo pede mais uma coisa AGORA, com o dialogo do caixa aberto.
    await adicionar(cliente, 'Suco de laranja 300ml'); // + R$ 11,00
    await cliente.getByRole('button', { name: /enviar pedido/i }).click();
    await expect(cliente.getByText('Total: R$ 39,90')).toBeVisible();

    await caixa.getByRole('button', { name: 'DINHEIRO', exact: true }).click();

    await expect(caixa.getByRole('alert')).toContainText(/a conta mudou/i);
    // E a tela ja mostra o total novo: sem isto o operador reclica no mesmo
    // botao com o mesmo numero velho, para sempre.
    await expect(caixa.getByText('Total: R$ 39,90')).toBeVisible();

    const c = await prisma.comanda.findFirst({ where: { mesa: { numero } } });
    expect(c?.status, 'a conta nao pode ter fechado pelo valor errado').not.toBe('FECHADA');

    // CONTROLE POSITIVO: com o total novo na tela, o fechamento passa. R$ 50
    // ainda cobrem R$ 39,90 — o troco agora e outro, e e esse que vale.
    await expect(caixa.getByTestId('troco-preview')).toHaveText('Troco: R$ 10,10');
    await caixa.getByRole('button', { name: 'DINHEIRO', exact: true }).click();
    await expect(caixa.getByTestId('troco-final')).toHaveText('Troco: R$ 10,10');
  });
});
