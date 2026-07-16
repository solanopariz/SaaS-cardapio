/**
 * Erros de dominio com status HTTP. Os services lancam; o error handler do
 * Fastify traduz. Nenhum service toca em `reply`.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const naoEncontrado = (o: string) => new AppError(404, 'NAO_ENCONTRADO', `${o} nao encontrado`);

export const naoAutorizado = (msg = 'credenciais invalidas') =>
  new AppError(401, 'NAO_AUTORIZADO', msg);

export const proibido = (msg = 'sem permissao') => new AppError(403, 'PROIBIDO', msg);

export const conflito = (code: string, msg: string) => new AppError(409, code, msg);

export const requisicaoInvalida = (code: string, msg: string) => new AppError(400, code, msg);

/**
 * 410 Gone: a comanda existia e foi fechada. O front usa exatamente este status
 * para saber que deve limpar o localStorage e voltar a tela de escanear.
 * Nao e 404 — 404 significaria "nunca existiu", e o cliente ficaria tentando.
 */
export const comandaFechada = () =>
  new AppError(410, 'COMANDA_FECHADA', 'esta comanda ja foi fechada');

/** Codigo de unique_violation do Postgres, via Prisma. */
export const PRISMA_UNIQUE_VIOLATION = 'P2002';
