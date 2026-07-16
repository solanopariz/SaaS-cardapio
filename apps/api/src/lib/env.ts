import { z } from 'zod';

/**
 * Valida o ambiente no boot. Falhar aqui, alto e cedo, e melhor do que
 * descobrir as 20h de sexta que JWT_SECRET_STAFF era undefined e todo token
 * assinado com "undefined" era valido.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET_STAFF: z.string().min(32, 'use pelo menos 32 chars'),
  JWT_SECRET_COMANDA: z.string().min(32, 'use pelo menos 32 chars'),
  APP_PUBLIC_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3333),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Ambiente invalido:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

/**
 * Segredos distintos por tipo de token. Se fossem o mesmo, um cliente com um
 * token de comanda valido poderia trocar a claim `tipo` para "staff"... nao,
 * nao poderia, porque a assinatura quebraria. Mas segredos separados garantem
 * que um vazamento do segredo do cliente nao derruba o painel do caixa.
 */
if (env.JWT_SECRET_STAFF === env.JWT_SECRET_COMANDA) {
  console.error('JWT_SECRET_STAFF e JWT_SECRET_COMANDA devem ser diferentes.');
  process.exit(1);
}
