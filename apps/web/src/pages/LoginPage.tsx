import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useStaff, type Role } from '../auth/StaffContext.jsx';

const DESTINO: Record<Role, string> = {
  COZINHA: '/painel/cozinha',
  CAIXA: '/painel/caixa',
  ADMIN: '/painel/admin',
};

export function LoginPage() {
  const { entrar } = useStaff();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState(false);

  async function enviar(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErro(false);
    try {
      const r = await api<{ token: string; usuario: { id: number; nome: string; role: Role } }>(
        '/auth/login',
        { method: 'POST', body: { email, senha } },
      );
      entrar(r);
      navigate(DESTINO[r.usuario.role], { replace: true });
    } catch {
      setErro(true);
    }
  }

  return (
    <main className="tela-centro">
      <h1>Entrar</h1>
      <form onSubmit={enviar}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email"
          autoComplete="username"
          required
        />
        <input
          type="password"
          value={senha}
          onChange={(e) => setSenha(e.target.value)}
          placeholder="senha"
          autoComplete="current-password"
          required
        />
        <button type="submit">Entrar</button>
      </form>
      {/* Mensagem generica: nao revela se o email existe. */}
      {erro && <p role="alert">Email ou senha invalidos.</p>}
    </main>
  );
}
