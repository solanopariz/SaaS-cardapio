import { afterEach, describe, expect, it, vi } from 'vitest';
import { idempotencyKeySchema } from './schemas.js';
import { uuidV4 } from './uuid.js';

/**
 * O ambiente do CELULAR: `crypto` sem `randomUUID`.
 *
 * Nao adianta testar so o caminho feliz — em `localhost` (e no vitest) o
 * `randomUUID` nativo existe SEMPRE, entao um teste ingenuo passaria verde sem
 * nunca executar o fallback, que e justamente a linha que quebrou no primeiro
 * celular de verdade.
 *
 * `getRandomValues` continua o real: o que se remove aqui e exatamente o que o
 * navegador remove fora de secure context, nada mais.
 */
function simularOrigemInsegura() {
  const real = globalThis.crypto;
  vi.stubGlobal('crypto', {
    getRandomValues: (a: Uint8Array) => real.getRandomValues(a),
    // randomUUID ausente de proposito.
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const FORMATO_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe('uuidV4', () => {
  it('em secure context usa o nativo', () => {
    const espiao = vi.spyOn(globalThis.crypto, 'randomUUID');
    expect(uuidV4()).toMatch(FORMATO_V4);
    expect(espiao, 'tinha randomUUID e nao usou').toHaveBeenCalled();
  });

  /**
   * O caso que o projeto inteiro nao conseguia ver: os 128 testes rodam em
   * localhost, que e secure context por definicao.
   */
  it('SEM randomUUID (o celular) ainda gera v4 valido', () => {
    simularOrigemInsegura();

    // CONTROLE POSITIVO do cenario: se `randomUUID` ainda existisse aqui, este
    // teste passaria pelo caminho nativo e nao provaria nada.
    expect(typeof crypto.randomUUID, 'o stub nao removeu randomUUID').toBe('undefined');

    const id = uuidV4();
    expect(id).toMatch(FORMATO_V4);
    // O consumidor real: se o Zod recusar, a chave de idempotencia vira 400 e o
    // pedido do cliente morre no balcao.
    expect(() => idempotencyKeySchema.parse(id)).not.toThrow();
  });

  it('SEM randomUUID nao repete', () => {
    simularOrigemInsegura();
    const ids = new Set(Array.from({ length: 500 }, () => uuidV4()));
    expect(ids.size).toBe(500);
  });

  it('SEM randomUUID crava versao e variante, nao so bytes aleatorios', () => {
    simularOrigemInsegura();
    for (let i = 0; i < 50; i++) {
      const id = uuidV4();
      expect(id[14], `versao errada em ${id}`).toBe('4');
      expect(['8', '9', 'a', 'b'], `variante errada em ${id}`).toContain(id[19]);
    }
  });

  /**
   * `Math.random()` seria o conserto obvio e errado: chave de idempotencia
   * adivinhavel. Este teste falha se alguem trocar o CSPRNG por conveniencia.
   */
  it('o fallback usa getRandomValues, nao Math.random', () => {
    const real = globalThis.crypto;
    const espiao = vi.fn((a: Uint8Array) => real.getRandomValues(a));
    vi.stubGlobal('crypto', { getRandomValues: espiao });

    uuidV4();
    expect(espiao).toHaveBeenCalled();
  });
});
