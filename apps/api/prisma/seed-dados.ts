/**
 * Constantes do seed, separadas do `seed.ts` porque ele executa `main()` no
 * topo do modulo: importar de la para ler uma constante dispararia o seed
 * inteiro contra qualquer DATABASE_URL que estivesse setada no momento.
 *
 * Aqui nao ha efeito colateral — `seed.ts` e os testes importam com seguranca.
 */

export const SENHA_SEED = 'trocar123';

/**
 * Contas de desenvolvimento.
 *
 * O dominio E `cardapio.local` e nao `local`: `loginSchema` valida com
 * `z.string().email()`, que exige TLD, e `@local` (sem ponto) era REJEITADO com
 * 400 antes de a senha sequer ser conferida. Isso deixou os paineis da cozinha
 * e do caixa inacessiveis desde que o projeto existe — os dois arquivos estavam
 * certos sozinhos, e ninguem nunca tinha chamado POST /auth/login.
 *
 * `.local` e TLD reservado para rede local: continua obviamente falso, e passa.
 *
 * `test/auth.login.test.ts` roda o seed DE VERDADE e loga com estas credenciais.
 */
export const USUARIOS_SEED = [
  { nome: 'Administrador', email: 'admin@cardapio.local', role: 'ADMIN' },
  { nome: 'Cozinha', email: 'cozinha@cardapio.local', role: 'COZINHA' },
  { nome: 'Caixa', email: 'caixa@cardapio.local', role: 'CAIXA' },
] as const;
