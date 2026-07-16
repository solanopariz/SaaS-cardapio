import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import { useComanda } from './ComandaContext.jsx';
import { obterDeviceId, type SessaoComanda } from './storage.js';

interface RespostaJoin {
  token: string;
  comandaId: number;
  participanteId: number;
  apelido: string;
  mesaNumero: number;
}

/**
 * Portao de entrada do cliente. Resolve, nesta ordem:
 *
 *   1. le ?m e ?k da URL (vieram do QR impresso)
 *   2. ja ha token no localStorage? hidrata e segue
 *   3. tem m+k sem token? pede o apelido e chama POST /sessions/join
 *   4. LIMPA A URL — o segredo da mesa nao pode ficar na barra de endereco
 *   5. sem nada: pede para escanear
 *
 * O passo 4 nao e cosmetico. Enquanto `?k=` estiver na URL ele vaza no
 * historico do navegador, em screenshots, e num link compartilhado no WhatsApp.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { sessao, entrar } = useComanda();

  const mesaUrl = params.get('m');
  const chaveUrl = params.get('k');

  // Guardamos m/k em estado no primeiro render, porque vamos apagar a URL logo
  // em seguida e ainda precisamos deles para o join.
  const [credencial] = useState(() =>
    mesaUrl && chaveUrl ? { mesa: Number(mesaUrl), k: chaveUrl } : null,
  );

  useEffect(() => {
    // Passo 4: assim que lemos, a URL some. `replace` para nao poluir o historico.
    if (mesaUrl || chaveUrl) navigate('/menu', { replace: true });
  }, [mesaUrl, chaveUrl, navigate]);

  if (sessao) return <>{children}</>;

  if (credencial) return <TelaApelido credencial={credencial} aoEntrar={entrar} />;

  return <TelaEscaneie />;
}

function TelaEscaneie() {
  return (
    <main className="tela-centro">
      <h1>Cardapio Digital</h1>
      <p>Escaneie o QR Code da sua mesa para comecar.</p>
    </main>
  );
}

function TelaApelido({
  credencial,
  aoEntrar,
}: {
  credencial: { mesa: number; k: string };
  aoEntrar: (s: SessaoComanda) => void;
}) {
  const [apelido, setApelido] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setEnviando(true);
    setErro(null);
    try {
      const r = await api<RespostaJoin>('/sessions/join', {
        method: 'POST',
        body: { ...credencial, apelido: apelido.trim(), deviceId: obterDeviceId() },
      });
      aoEntrar(r);
    } catch (err) {
      setErro(
        err instanceof ApiError && err.status === 401
          ? 'QR Code invalido. Escaneie novamente o codigo da mesa.'
          : 'Nao foi possivel entrar. Tente de novo.',
      );
      setEnviando(false);
    }
  }

  return (
    <main className="tela-centro">
      <h1>Mesa {credencial.mesa}</h1>
      <p>Como podemos te chamar?</p>
      <form onSubmit={enviar}>
        <input
          value={apelido}
          onChange={(e) => setApelido(e.target.value)}
          placeholder="Seu nome"
          maxLength={30}
          autoFocus
          required
        />
        <button type="submit" disabled={enviando || apelido.trim().length === 0}>
          {enviando ? 'Entrando...' : 'Entrar'}
        </button>
      </form>
      {erro && <p role="alert">{erro}</p>}
    </main>
  );
}
