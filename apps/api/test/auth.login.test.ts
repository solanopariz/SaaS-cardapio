import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SENHA_SEED, USUARIOS_SEED } from '../prisma/seed-dados.js';
import { subirAmbiente, type Ambiente } from './helpers/ambiente.js';

/**
 * O caminho mais banal do sistema — o que 100% do staff usa 100% dos dias — era
 * o unico sem teste. E estava quebrado desde sempre:
 *
 *   seed:         email: 'cozinha@local'
 *   loginSchema:  email: z.string().email()      // exige TLD
 *   resultado:    400 VALIDACAO, antes de conferir a senha
 *
 * Os paineis da cozinha e do caixa eram inacessiveis. Os dois arquivos estavam
 * certos sozinhos; ninguem nunca tinha chamado POST /auth/login.
 *
 * Este teste roda o seed DE VERDADE (subprocesso, igual ao `npm run db:seed`) e
 * loga com as credenciais que ele anuncia. Nao valida um email escolhido a dedo:
 * prova que as credenciais DOCUMENTADAS entram.
 */

let amb: Ambiente;

beforeAll(async () => {
  amb = await subirAmbiente({ semear: true });
}, 180_000);

afterAll(async () => {
  await amb?.parar();
});

const login = (email: string, senha: string) =>
  amb.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, senha } });

describe('POST /auth/login com as credenciais do seed', () => {
  // Um caso por usuario: se o seed ganhar um role novo, ele entra aqui sozinho.
  it.each(USUARIOS_SEED.map((u) => [u.email, u.role] as const))(
    '%s entra e recebe role %s',
    async (email, role) => {
      const r = await login(email, SENHA_SEED);

      // 400 aqui = o Zod recusou o email antes de olhar o banco. Foi o bug.
      expect(r.statusCode, `esperava 200, veio ${r.statusCode}: ${r.body}`).toBe(200);
      expect(r.json().usuario.role).toBe(role);
      expect(r.json().token).toBeTruthy();
    },
  );

  it('o token do seed abre a rota protegida do painel', async () => {
    const cozinha = USUARIOS_SEED.find((u) => u.role === 'COZINHA')!;
    const { token } = (await login(cozinha.email, SENHA_SEED)).json();

    // Login que devolve token mas nao abre porta nenhuma nao serve para nada.
    const r = await amb.app.inject({
      method: 'GET',
      url: '/api/cozinha/pedidos',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(r.statusCode).toBe(200);
    expect(Array.isArray(r.json())).toBe(true);
  });

  it('a cozinha nao abre a rota do caixa', async () => {
    const cozinha = USUARIOS_SEED.find((u) => u.role === 'COZINHA')!;
    const { token } = (await login(cozinha.email, SENHA_SEED)).json();

    const r = await amb.app.inject({
      method: 'GET',
      url: '/api/caixa/mesas',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(r.statusCode).toBe(403);
  });

  it('o ADMIN abre as duas', async () => {
    const admin = USUARIOS_SEED.find((u) => u.role === 'ADMIN')!;
    const { token } = (await login(admin.email, SENHA_SEED)).json();
    const auth = { authorization: `Bearer ${token}` };

    expect((await amb.app.inject({ method: 'GET', url: '/api/cozinha/pedidos', headers: auth })).statusCode).toBe(200);
    expect((await amb.app.inject({ method: 'GET', url: '/api/caixa/mesas', headers: auth })).statusCode).toBe(200);
  });

  it('senha errada: 401, nao 400', async () => {
    const r = await login(USUARIOS_SEED[0].email, 'senhaerrada123');

    // A distincao importa para diagnosticar: 400 significa "o payload nem foi
    // aceito"; 401 significa "as credenciais nao batem". Confundir os dois foi
    // o que fez o bug do @local parecer "senha errada" na tela.
    expect(r.statusCode).toBe(401);
  });

  it('email que nao existe: 401 com a mesma mensagem da senha errada', async () => {
    const inexistente = await login('ninguem@cardapio.local', SENHA_SEED);
    const senhaErrada = await login(USUARIOS_SEED[0].email, 'senhaerrada123');

    expect(inexistente.statusCode).toBe(401);
    // Mensagens identicas: nao confirmamos quais emails existem.
    expect(inexistente.json()).toEqual(senhaErrada.json());
  });

  /**
   * O bug, virado em teste. Se alguem devolver um email sem TLD ao seed — ou
   * apertar o schema de novo — isto pega antes de chegar num restaurante.
   */
  it('todo email do seed passa no loginSchema (o bug do @local)', async () => {
    const { loginSchema } = await import('@cardapio/shared');

    for (const u of USUARIOS_SEED) {
      const r = loginSchema.safeParse({ email: u.email, senha: SENHA_SEED });
      expect(r.success, `${u.email} nao passa no loginSchema — o painel dele nao abre`).toBe(true);
    }
  });
});
