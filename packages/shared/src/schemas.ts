/**
 * Schemas Zod compartilhados entre API e front.
 * A API valida a entrada com eles; o front valida o formulario com os mesmos.
 */

import { z } from 'zod';
import { METODOS_PAGAMENTO, STATUS_PEDIDO } from './status.js';

/** Chave do QR: 16 chars hex, gerada uma vez por mesa. */
export const qrSecretSchema = z
  .string()
  .length(16)
  .regex(/^[0-9a-f]{16}$/, 'chave de mesa invalida');

export const joinSessaoSchema = z.object({
  /** numero da mesa, vindo de ?m= */
  mesa: z.coerce.number().int().positive(),
  /** segredo estatico impresso no QR, vindo de ?k= */
  k: qrSecretSchema,
  apelido: z.string().trim().min(1).max(30),
  /** id estavel do dispositivo, gerado no primeiro acesso e guardado no storage */
  deviceId: z.string().uuid(),
});
export type JoinSessao = z.infer<typeof joinSessaoSchema>;

export const itemPedidoSchema = z.object({
  produtoId: z.number().int().positive(),
  qtd: z.number().int().min(1).max(50),
  observacao: z.string().trim().max(200).nullish().transform((v) => v || null),
  /**
   * Quem vai pagar por este item. Null = compartilhado da mesa.
   * Fica no ITEM, nao no pedido: "uma coca pra mim, uma pro Joao" num envio so.
   */
  participanteId: z.number().int().positive().nullable(),
});

export const criarPedidoSchema = z.object({
  itens: z.array(itemPedidoSchema).min(1).max(50),
});
export type CriarPedido = z.infer<typeof criarPedidoSchema>;

/** Enviado no header `Idempotency-Key`. O celular vai reenviar o POST. */
export const idempotencyKeySchema = z.string().uuid();

export const atualizarStatusPedidoSchema = z.object({
  status: z.enum(STATUS_PEDIDO),
});

export const cancelarSchema = z.object({
  motivo: z.string().trim().min(3).max(200),
});
export type Cancelar = z.infer<typeof cancelarSchema>;

export const fecharComandaSchema = z
  .object({
    metodo: z.enum(METODOS_PAGAMENTO),
    /** So faz sentido em DINHEIRO, para calcular o troco. Em centavos. */
    valorRecebidoCentavos: z.number().int().nonnegative().nullish(),
  })
  .refine((v) => v.metodo !== 'DINHEIRO' || v.valorRecebidoCentavos != null, {
    message: 'valorRecebidoCentavos e obrigatorio quando o metodo e DINHEIRO',
    path: ['valorRecebidoCentavos'],
  });
export type FecharComanda = z.infer<typeof fecharComandaSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(8).max(72), // 72 = limite do bcrypt
});
export type Login = z.infer<typeof loginSchema>;

// --- Admin ---------------------------------------------------------------

export const produtoSchema = z.object({
  categoriaId: z.number().int().positive(),
  nome: z.string().trim().min(1).max(80),
  descricao: z.string().trim().max(300).nullish().transform((v) => v || null),
  precoCentavos: z.number().int().positive(),
  imagemUrl: z.string().url().nullish().transform((v) => v || null),
  disponivel: z.boolean().default(true),
  ordem: z.number().int().nonnegative().default(0),
});

export const categoriaSchema = z.object({
  nome: z.string().trim().min(1).max(60),
  ordem: z.number().int().nonnegative().default(0),
  ativa: z.boolean().default(true),
});

export const mesaSchema = z.object({
  numero: z.number().int().positive(),
});
