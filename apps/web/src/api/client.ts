/**
 * Cliente HTTP. Uma unica funcao, um unico lugar que sabe traduzir status.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 410 Gone = a comanda foi fechada pelo caixa. Contrato com o backend. */
export const ehComandaFechada = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 410;

interface Opcoes extends Omit<RequestInit, 'body'> {
  body?: unknown;
  token?: string | null;
  /** Idempotency-Key. Obrigatorio no POST de pedido. */
  idempotencyKey?: string;
}

export async function api<T>(caminho: string, opts: Opcoes = {}): Promise<T> {
  const { body, token, idempotencyKey, headers, ...rest } = opts;

  const res = await fetch(`/api${caminho}`, {
    ...rest,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 204 || res.status === 304) return undefined as T;

  if (!res.ok) {
    const erro = (await res.json().catch(() => null)) as
      | { code?: string; message?: string }
      | null;
    throw new ApiError(
      res.status,
      erro?.code ?? 'DESCONHECIDO',
      erro?.message ?? `HTTP ${res.status}`,
    );
  }

  return res.json() as Promise<T>;
}
