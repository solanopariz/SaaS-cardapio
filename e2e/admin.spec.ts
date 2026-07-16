import { expect, test } from '@playwright/test';
import {
  EMAIL_ADMIN,
  EMAIL_CAIXA,
  adicionar,
  entrarComoCliente,
  logarStaff,
  prisma,
} from './apoio.js';

test.afterAll(async () => {
  await prisma.$disconnect();
});

/** Nome unico por teste: o cardapio e global e um spec nao pode sujar o outro. */
const unico = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

async function criarProduto(page: import('@playwright/test').Page, nome: string, preco: string) {
  const categoria = unico('Cat');
  await page.getByLabel('Nova categoria').fill(categoria);
  await page.getByRole('button', { name: /criar categoria/i }).click();

  const secao = page.locator('section').filter({ hasText: categoria });
  await expect(secao).toBeVisible();

  await secao.getByLabel('Nome do produto').fill(nome);
  await secao.getByLabel('Preco do produto').fill(preco);
  await secao.getByRole('button', { name: /adicionar/i }).click();
  return secao;
}

test.describe('admin edita o cardapio', () => {
  /**
   * O login manda cada role para o seu painel. `DESTINO` levava ADMIN para
   * /painel/caixa — com a tela de admin existindo, o dono logaria e nunca a
   * veria. Mesmo formato do bug do seed: dois arquivos certos, errados na
   * costura.
   */
  test('admin entra e cai na tela de cardapio', async ({ page }) => {
    await logarStaff(page, EMAIL_ADMIN);
    await expect(page).toHaveURL(/\/painel\/admin/);
    await expect(page.getByRole('heading', { name: 'Cardapio' })).toBeVisible();
  });

  test('caixa nao chega na tela de admin', async ({ page }) => {
    await logarStaff(page, EMAIL_CAIXA);
    await expect(page).toHaveURL(/\/painel\/caixa/); // controle positivo: logou
    await page.goto('/painel/admin');
    await expect(page).toHaveURL(/\/login/);
  });

  /**
   * O caminho inteiro, do teclado do dono ate a boca do cliente. E o unico
   * teste que prova que o CRUD serve para alguma coisa.
   */
  test('produto criado pelo admin chega no cardapio do cliente', async ({ browser }) => {
    const admin = await (await browser.newContext()).newPage();
    await logarStaff(admin, EMAIL_ADMIN);
    await expect(admin.getByRole('heading', { name: 'Cardapio' })).toBeVisible();

    const nome = unico('Pastel de vento');
    await criarProduto(admin, nome, '19,90');
    await expect(admin.getByText(nome)).toBeVisible();

    // "19,90" tem que virar 1990 INTEIRO. parseFloat('19.99')*100 e
    // 1998.9999999999998 — o preco iria errado para o banco e ninguem veria.
    await expect
      .poll(async () => (await prisma.produto.findFirst({ where: { nome } }))?.precoCentavos)
      .toBe(1990);

    const cliente = await (await browser.newContext()).newPage();
    await entrarComoCliente(cliente, 'Fabio');
    await expect(cliente.getByText(nome)).toBeVisible();
    await adicionar(cliente, nome);
    await cliente.getByRole('button', { name: /enviar pedido/i }).click();

    // O preco que o admin digitou e o preco que o cliente paga.
    await expect(cliente.getByText('Total: R$ 19,90')).toBeVisible();
  });

  test('marcar esgotado tira do cardapio do cliente', async ({ browser }) => {
    const admin = await (await browser.newContext()).newPage();
    await logarStaff(admin, EMAIL_ADMIN);
    await expect(admin.getByRole('heading', { name: 'Cardapio' })).toBeVisible();

    const nome = unico('Coxinha');
    const secao = await criarProduto(admin, nome, '8,50');
    const linha = secao.locator('li').filter({ hasText: nome });
    await expect(linha).toBeVisible();

    // CONTROLE POSITIVO: visivel ANTES. Sem isto, um produto que nunca apareceu
    // passaria neste teste.
    const antes = await (await browser.newContext()).newPage();
    await entrarComoCliente(antes, 'Gabi');
    await expect(antes.getByText(nome)).toBeVisible();

    await linha.getByRole('button', { name: /marcar esgotado/i }).click();
    await expect(linha.getByText(/esgotado/i)).toBeVisible();

    const depois = await (await browser.newContext()).newPage();
    await entrarComoCliente(depois, 'Hugo');
    await expect(depois.getByRole('heading', { name: /padaria/i })).toBeVisible();
    await expect(depois.getByText(nome)).toHaveCount(0);
  });

  /**
   * A regra da casa, vista pelo cliente: o snapshot em
   * `PedidoItem.precoUnitarioCentavos` congela o preco no instante do pedido.
   * Se isto quebrar, o total sobe sozinho na tela de quem ja pediu — e o
   * cliente descobre no caixa.
   */
  test('mudar o preco nao mexe na comanda ja aberta', async ({ browser }) => {
    const admin = await (await browser.newContext()).newPage();
    await logarStaff(admin, EMAIL_ADMIN);
    await expect(admin.getByRole('heading', { name: 'Cardapio' })).toBeVisible();

    const nome = unico('Pao na chapa');
    const secao = await criarProduto(admin, nome, '10,00');
    const linha = secao.locator('li').filter({ hasText: nome });
    await expect(linha).toBeVisible();

    const cliente = await (await browser.newContext()).newPage();
    await entrarComoCliente(cliente, 'Ines');
    await adicionar(cliente, nome);
    await cliente.getByRole('button', { name: /enviar pedido/i }).click();
    await expect(cliente.getByText('Total: R$ 10,00')).toBeVisible();

    // O dono triplica o preco com a comanda aberta.
    await linha.getByLabel(`Preco de ${nome}`).fill('30,00');
    await linha.getByRole('button', { name: /salvar preco/i }).click();

    // CONTROLE POSITIVO: mudou MESMO no cardapio. Sem isto, um PATCH que falha
    // em silencio faria o teste passar por nao ter mudado nada.
    await expect
      .poll(async () => (await prisma.produto.findFirst({ where: { nome } }))?.precoCentavos)
      .toBe(3000);

    await cliente.reload();
    await expect(cliente.getByText('Total: R$ 10,00')).toBeVisible(); // nao 30,00
  });

  /**
   * `ordem` do teclado do dono ate o celular do cliente.
   *
   * `Categoria.ordem` e `@default(0)` e o seed usa 1..4, entao categoria criada
   * pelo painel nasce ACIMA de tudo — "Sobremesas" antes da Padaria. A tela nao
   * editava o campo: o dono via o erro e nao tinha o que fazer. Mesma forma da
   * `categoria.ativa` — o default era inofensivo ate o painel existir.
   */
  test('admin muda a ordem e o cardapio do cliente reordena', async ({ browser }) => {
    const admin = await (await browser.newContext()).newPage();
    await logarStaff(admin, EMAIL_ADMIN);
    await expect(admin.getByRole('heading', { name: 'Cardapio' })).toBeVisible();

    const categoria = unico('Sobremesas');
    await admin.getByLabel('Nova categoria').fill(categoria);
    await admin.getByRole('button', { name: /criar categoria/i }).click();
    const secao = admin.locator('section').filter({ hasText: categoria });
    await expect(secao).toBeVisible();

    // Categoria sem produto nao aparece no /menu (menu.routes.ts:35).
    await secao.getByLabel('Nome do produto').fill(unico('Pudim'));
    await secao.getByLabel('Preco do produto').fill('12,00');
    await secao.getByRole('button', { name: /adicionar/i }).click();

    /**
     * Contexto NOVO a cada leitura, nao `reload()`: o /menu manda
     * `Cache-Control: max-age=30`, e o mesmo contexto poderia devolver o
     * cardapio velho do cache — eu diagnosticaria "a ordem nao mudou" olhando
     * para uma resposta que o servidor nem chegou a mandar.
     */
    const ordemNoCliente = async (apelido: string) => {
      const cliente = await (await browser.newContext()).newPage();
      await entrarComoCliente(cliente, apelido);
      await expect(cliente.getByRole('heading', { name: /padaria/i })).toBeVisible();
      return cliente.locator('section h2').allTextContents();
    };

    // CONTROLE POSITIVO: nasceu no topo MESMO. Sem isto, "agora esta embaixo"
    // passaria tambem se ela nunca tivesse estado em cima.
    const antes = await ordemNoCliente('Joana');
    expect(
      antes.indexOf(categoria),
      `"${categoria}" (ordem=0) deveria nascer antes da Padaria (ordem=1). Cardapio: ${antes.join(' | ')}`,
    ).toBeLessThan(antes.indexOf('Padaria'));

    // O dono conserta pela tela.
    await secao.getByLabel(`Ordem da categoria ${categoria}`, { exact: true }).fill('99');
    await secao.getByRole('button', { name: `Salvar Ordem da categoria ${categoria}` }).click();

    await expect
      .poll(async () => (await prisma.categoria.findFirst({ where: { nome: categoria } }))?.ordem)
      .toBe(99);

    const depois = await ordemNoCliente('Kelly');
    expect(
      depois.indexOf(categoria),
      `ordem=99 e a maior de todas. Cardapio: ${depois.join(' | ')}`,
    ).toBe(depois.length - 1);
  });

  test('ordem invalida e recusada, e nao vira 0 em silencio', async ({ page }) => {
    await logarStaff(page, EMAIL_ADMIN);
    await expect(page.getByRole('heading', { name: 'Cardapio' })).toBeVisible();

    const categoria = unico('Ordem');
    await page.getByLabel('Nova categoria').fill(categoria);
    await page.getByRole('button', { name: /criar categoria/i }).click();
    const secao = page.locator('section').filter({ hasText: categoria });
    await expect(secao).toBeVisible();

    // `exact`: sem isto o label casa por substring e pega tambem o botao
    // "Salvar Ordem da categoria X".
    const campo = secao.getByLabel(`Ordem da categoria ${categoria}`, { exact: true });
    await campo.fill('5');
    await secao.getByRole('button', { name: `Salvar Ordem da categoria ${categoria}` }).click();
    await expect
      .poll(async () => (await prisma.categoria.findFirst({ where: { nome: categoria } }))?.ordem)
      .toBe(5);

    // Campo apagado: `Number('')` e 0, e 0 e o TOPO do cardapio. Sem o teste de
    // vazio, apagar sem querer mandaria a categoria para cima de tudo.
    await campo.fill('');
    await secao.getByRole('button', { name: `Salvar Ordem da categoria ${categoria}` }).click();
    await expect(secao.getByRole('alert')).toContainText(/inteiro/i);

    await campo.fill('1,5');
    await secao.getByRole('button', { name: `Salvar Ordem da categoria ${categoria}` }).click();
    await expect(secao.getByRole('alert')).toContainText(/inteiro/i);

    // Nada disso pode ter escrito no banco: continua 5.
    expect(
      (await prisma.categoria.findFirst({ where: { nome: categoria } }))?.ordem,
      'uma ordem invalida chegou a gravar',
    ).toBe(5);
  });

  test('preco com ponto de milhar e recusado, nao adivinhado', async ({ page }) => {
    await logarStaff(page, EMAIL_ADMIN);
    await expect(page.getByRole('heading', { name: 'Cardapio' })).toBeVisible();

    const categoria = unico('Vinhos');
    await page.getByLabel('Nova categoria').fill(categoria);
    await page.getByRole('button', { name: /criar categoria/i }).click();
    const secao = page.locator('section').filter({ hasText: categoria });
    await expect(secao).toBeVisible();

    const nome = unico('Tinto');
    await secao.getByLabel('Nome do produto').fill(nome);
    await secao.getByLabel('Preco do produto').fill('1.200,00'); // ambiguo
    await secao.getByRole('button', { name: /adicionar/i }).click();

    await expect(secao.getByRole('alert')).toContainText(/milhar/i);
    expect(await prisma.produto.count({ where: { nome } })).toBe(0);

    // Escrito sem o separador, entra.
    await secao.getByLabel('Preco do produto').fill('1200,00');
    await secao.getByRole('button', { name: /adicionar/i }).click();
    await expect
      .poll(async () => (await prisma.produto.findFirst({ where: { nome } }))?.precoCentavos)
      .toBe(120000);
  });
});
