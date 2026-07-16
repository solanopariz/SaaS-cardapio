import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { SENHA_SEED, USUARIOS_SEED } from './seed-dados.js';

const prisma = new PrismaClient();

/** 16 chars hex = 64 bits. Nao se adivinha por forca bruta sobre HTTP. */
const novoSegredo = () => randomBytes(8).toString('hex');

const CARDAPIO = [
  {
    nome: 'Padaria',
    ordem: 1,
    produtos: [
      { nome: 'Pao francesa (un)', precoCentavos: 90, descricao: 'Assado a cada 2h' },
      { nome: 'Pao de queijo', precoCentavos: 550, descricao: 'Porcao com 4 unidades' },
      { nome: 'Croissant', precoCentavos: 890, descricao: null },
      { nome: 'Bolo de fuba (fatia)', precoCentavos: 700, descricao: null },
    ],
  },
  {
    nome: 'Salgados',
    ordem: 2,
    produtos: [
      { nome: 'Coxinha de frango', precoCentavos: 850, descricao: 'Com catupiry' },
      { nome: 'Empada de palmito', precoCentavos: 900, descricao: null },
      { nome: 'Esfiha de carne', precoCentavos: 750, descricao: null },
    ],
  },
  {
    nome: 'Pratos',
    ordem: 3,
    produtos: [
      { nome: 'Prato feito', precoCentavos: 2890, descricao: 'Arroz, feijao, bife e salada' },
      { nome: 'Filé de frango grelhado', precoCentavos: 3250, descricao: 'Acompanha arroz e legumes' },
      { nome: 'Omelete', precoCentavos: 1990, descricao: 'Queijo, presunto e tomate' },
    ],
  },
  {
    nome: 'Bebidas',
    ordem: 4,
    produtos: [
      { nome: 'Cafe expresso', precoCentavos: 500, descricao: null },
      { nome: 'Cafe com leite', precoCentavos: 700, descricao: null },
      { nome: 'Suco de laranja 300ml', precoCentavos: 1100, descricao: 'Natural, sem acucar' },
      { nome: 'Refrigerante lata', precoCentavos: 700, descricao: null },
      { nome: 'Agua mineral 500ml', precoCentavos: 400, descricao: null },
    ],
  },
];

async function main(): Promise<void> {
  const senhaHash = await bcrypt.hash(SENHA_SEED, 10);

  await prisma.usuario.createMany({
    data: USUARIOS_SEED.map((u) => ({ ...u, senhaHash })),
    skipDuplicates: true,
  });

  /**
   * `qrSecret` so e gerado na CRIACAO da mesa. Rodar o seed de novo nao troca o
   * segredo — se trocasse, todos os adesivos ja impressos parariam de funcionar.
   */
  for (let numero = 1; numero <= 20; numero++) {
    await prisma.mesa.upsert({
      where: { numero },
      create: { numero, qrSecret: novoSegredo() },
      update: {}, // de proposito: nao mexe no segredo de mesa existente
    });
  }

  for (const cat of CARDAPIO) {
    const categoria = await prisma.categoria.upsert({
      where: { id: cat.ordem },
      create: { id: cat.ordem, nome: cat.nome, ordem: cat.ordem },
      update: { nome: cat.nome, ordem: cat.ordem },
    });

    for (const [i, p] of cat.produtos.entries()) {
      const existe = await prisma.produto.findFirst({
        where: { categoriaId: categoria.id, nome: p.nome },
      });
      if (!existe) {
        await prisma.produto.create({
          data: { ...p, categoriaId: categoria.id, ordem: i },
        });
      }
    }
  }

  const mesas = await prisma.mesa.count();
  const produtos = await prisma.produto.count();
  console.log(`Seed pronto: ${mesas} mesas, ${produtos} produtos.`);
  console.log(`Logins: ${USUARIOS_SEED.map((u) => u.email).join(' / ')} — senha: ${SENHA_SEED}`);
  console.log('Rode `npm run qr` para gerar os QR Codes das mesas.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
