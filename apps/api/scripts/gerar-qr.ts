/**
 * Gera os PNGs para impressao. Um por mesa, uma unica vez na vida do adesivo.
 *
 *   npm run qr
 *
 * Os arquivos saem em `qrcodes/` — que esta no .gitignore, porque cada PNG
 * CONTEM o segredo da mesa. Versionar isso equivale a publicar as chaves.
 *
 * Se um adesivo for comprometido (foto vazada na internet), rotacione so aquela
 * mesa: `UPDATE mesas SET qr_secret = ... WHERE numero = 14`, e reimprima a 14.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join as pathJoin } from 'node:path';
import { PrismaClient } from '@prisma/client';
import QRCode from 'qrcode';

const prisma = new PrismaClient();

const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL ?? 'http://localhost:5173';
const SAIDA = 'qrcodes';

async function main(): Promise<void> {
  await mkdir(SAIDA, { recursive: true });

  const mesas = await prisma.mesa.findMany({ orderBy: { numero: 'asc' } });
  if (mesas.length === 0) {
    console.error('Nenhuma mesa. Rode `npm run db:seed` primeiro.');
    process.exit(1);
  }

  for (const mesa of mesas) {
    const url = `${APP_PUBLIC_URL}/menu?m=${mesa.numero}&k=${mesa.qrSecret}`;
    const png = await QRCode.toBuffer(url, {
      errorCorrectionLevel: 'M', // adesivo em mesa de restaurante vai sujar
      margin: 2,
      width: 800, // grande o bastante para imprimir em ~8cm
    });
    await writeFile(pathJoin(SAIDA, `mesa-${String(mesa.numero).padStart(2, '0')}.png`), png);
    console.log(`mesa ${mesa.numero} -> ${url}`);
  }

  console.log(`\n${mesas.length} QR Codes em ./${SAIDA}/`);
  console.log('Estes arquivos contem os segredos das mesas. Nao versione, nao compartilhe.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
