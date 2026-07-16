import { PrismaClient } from '@prisma/client';
import type { Page } from '@playwright/test';
import { E2E } from '../playwright.config.js';

/** Cliente proprio: o E2E le o banco para pegar segredo de mesa e conferir fatos. */
export const prisma = new PrismaClient({ datasources: { db: { url: E2E.databaseUrl } } });

export const SENHA_STAFF = 'trocar123';
export const EMAIL_COZINHA = 'cozinha@cardapio.local';
export const EMAIL_CAIXA = 'caixa@cardapio.local';

/**
 * Cada teste pega uma mesa propria e nunca reusa.
 *
 * Mesas compartilhadas entre specs criariam dependencia de ordem:
 * `uniq_comanda_aberta` so admite uma comanda ABERTA por mesa, entao o segundo
 * teste a usar a mesa 14 anexaria na comanda do primeiro em vez de abrir a sua.
 */
let proxima = 1;
export async function mesaLivre(): Promise<{ numero: number; k: string }> {
  const mesa = await prisma.mesa.findFirstOrThrow({
    where: { numero: { gte: proxima }, status: 'LIVRE' },
    orderBy: { numero: 'asc' },
  });
  proxima = mesa.numero + 1;
  return { numero: mesa.numero, k: mesa.qrSecret };
}

/** Escaneia o QR e entra. Devolve na tela do cardapio, pronta para pedir. */
export async function entrarComoCliente(page: Page, apelido: string): Promise<number> {
  const { numero, k } = await mesaLivre();
  await page.goto(`/menu?m=${numero}&k=${k}`);
  await page.getByPlaceholder(/seu nome/i).fill(apelido);
  await page.getByRole('button', { name: /^entrar$/i }).click();
  await page.getByRole('heading', { name: /padaria/i }).waitFor();
  return numero;
}

export async function logarStaff(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('email').fill(email);
  await page.getByPlaceholder('senha').fill(SENHA_STAFF);
  await page.getByRole('button', { name: /entrar/i }).click();
}

/**
 * Adiciona ao carrinho pelo NOME do produto, nunca por indice.
 *
 * `nth(4)` ja me fez procurar "Prato feito" na cozinha depois de o cliente ter
 * pedido um Omelete — o teste acusou o socket de nao entregar um item que
 * ninguem tinha pedido.
 */
export async function adicionar(page: Page, produto: string): Promise<void> {
  await page.locator('li', { hasText: produto }).getByRole('button', { name: /adicionar/i }).click();
}

/**
 * U+00A0, o espaco NAO-SEPARAVEL.
 *
 * `formatarBRL` usa `toLocaleString('pt-BR', {currency:'BRL'})`, e o Intl poe
 * um NBSP entre "R$" e o numero — nao um espaco comum. Bytes de "R$ 11,00":
 *
 *     0052 0024 00a0 0031 0031 002c 0030 0030
 *          ^R$  ^NBSP
 *
 * Um `/R\$ [\d,]+/` com espaco comum NUNCA casa. E o caractere e invisivel em
 * todo lugar: `JSON.stringify` nao o escapa, entao a string com NBSP e a com
 * espaco imprimem identicas no log. Isso ja me fez diagnosticar "o caixa
 * congelou" quando a medicao e que estava quebrada.
 *
 * Escrito como escape de proposito: um NBSP literal no fonte seria
 * indistinguivel de um espaco na revisao — que e como o bug nasce.
 *
 * O `getByText` do Playwright normaliza sozinho. So os helpers que leem
 * `innerText` cru precisam disto.
 */
const NBSP = / /g;

async function texto(page: Page): Promise<string> {
  return (await page.locator('body').innerText()).replace(NBSP, ' ');
}

/** "Cozinha — 5 pedido(s)" -> 5. Sinal do proprio app, nao contagem de DOM. */
export async function pedidosNaCozinha(page: Page): Promise<number> {
  const m = (await texto(page)).match(/Cozinha\s*—\s*(\d+)\s*pedido/i);
  return m ? Number(m[1]) : -1;
}

/** Total que o grid do caixa mostra para uma mesa, ou null se ela nao tem conta. */
export async function totalNoGrid(page: Page, numeroMesa: number): Promise<string | null> {
  const t = await texto(page);
  const i = t.indexOf(`Mesa ${numeroMesa}\n`);
  if (i < 0) return null;
  // Recorta ate a proxima mesa: sem limite, uma mesa LIVRE (que nao tem total)
  // devolveria o total da mesa seguinte no grid.
  const fim = t.indexOf('Mesa ', i + 5);
  const bloco = fim < 0 ? t.slice(i) : t.slice(i, fim);
  return (bloco.match(/R\$ [\d.,]+/) ?? [null])[0];
}
