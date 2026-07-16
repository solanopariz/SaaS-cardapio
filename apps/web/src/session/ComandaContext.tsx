import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { limparSessao, lerSessao, salvarSessao, type SessaoComanda } from './storage.js';

interface ComandaContextValor {
  sessao: SessaoComanda | null;
  entrar: (s: SessaoComanda) => void;
  /** Chamado no evento `comanda:fechada` e no 410 de `GET /comandas/me`. */
  sair: () => void;
}

const Ctx = createContext<ComandaContextValor | null>(null);

export function ComandaProvider({ children }: { children: ReactNode }) {
  // Le do localStorage na PRIMEIRA renderizacao. E isto que faz o F5 funcionar:
  // o estado nasce ja hidratado, sem flash de "escaneie o QR".
  const [sessao, setSessao] = useState<SessaoComanda | null>(() => lerSessao());

  const entrar = useCallback((s: SessaoComanda) => {
    salvarSessao(s);
    setSessao(s);
  }, []);

  const sair = useCallback(() => {
    limparSessao();
    setSessao(null);
  }, []);

  const valor = useMemo(() => ({ sessao, entrar, sair }), [sessao, entrar, sair]);

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useComanda(): ComandaContextValor {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useComanda precisa estar dentro de <ComandaProvider>');
  return ctx;
}

/** Para telas que so existem com sessao ativa. Lanca se nao houver. */
export function useSessaoAtiva(): SessaoComanda {
  const { sessao } = useComanda();
  if (!sessao) throw new Error('sem sessao — esta tela deveria estar sob <SessionGate>');
  return sessao;
}
