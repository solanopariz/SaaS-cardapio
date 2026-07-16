/**
 * UUID v4 que funciona FORA de secure context.
 *
 * `crypto.randomUUID` so existe em secure context — HTTPS, ou `http://localhost`.
 * Um celular abrindo `http://192.168.0.10:5173` (o QR na mesa, o notebook no
 * balcao, um mini-PC na rede do restaurante) NAO tem a funcao: ela e
 * `undefined`, e chama-la e um TypeError.
 *
 * Isto nao e teorico. Foi assim que o primeiro celular de verdade nao conseguiu
 * entrar: `obterDeviceId()` estourava dentro do `try` do SessionGate, ANTES do
 * fetch. O `catch` mostrava "Nao foi possivel entrar. Tente de novo." e o log
 * da API ficava vazio — o app acusava a rede de um erro que era dele. Os 128
 * testes passavam verdes porque todos rodam em `localhost`, que e secure
 * context por definicao.
 *
 * `crypto.getRandomValues` existe nos dois contextos. Continua CSPRNG: o
 * fallback NAO e `Math.random()`, que seria trocar um erro barulhento por
 * chaves de idempotencia adivinhaveis.
 */
export function uuidV4(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const b = crypto.getRandomValues(new Uint8Array(16));

  // Os dois campos que fazem disto um v4 de verdade, e nao 16 bytes aleatorios
  // com hifens. `idempotencyKeySchema` e `z.string().uuid()`, que confere isto.
  b[6] = ((b[6] as number) & 0x0f) | 0x40; // versao 4
  b[8] = ((b[8] as number) & 0x3f) | 0x80; // variante RFC 4122

  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
