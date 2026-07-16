import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

export type Role = 'ADMIN' | 'COZINHA' | 'CAIXA';

interface Staff {
  token: string;
  usuario: { id: number; nome: string; role: Role };
}

const CHAVE = 'staff_session_v1';

interface StaffCtx {
  staff: Staff | null;
  entrar: (s: Staff) => void;
  sair: () => void;
}

const Ctx = createContext<StaffCtx | null>(null);

export function StaffProvider({ children }: { children: ReactNode }) {
  const [staff, setStaff] = useState<Staff | null>(() => {
    try {
      const b = sessionStorage.getItem(CHAVE);
      return b ? (JSON.parse(b) as Staff) : null;
    } catch {
      return null;
    }
  });

  const entrar = useCallback((s: Staff) => {
    // sessionStorage, nao localStorage: o token do funcionario morre quando o
    // navegador do balcao fecha. Um tablet compartilhado nao carrega sessao
    // de turno para turno.
    sessionStorage.setItem(CHAVE, JSON.stringify(s));
    setStaff(s);
  }, []);

  const sair = useCallback(() => {
    sessionStorage.removeItem(CHAVE);
    setStaff(null);
  }, []);

  return <Ctx.Provider value={useMemo(() => ({ staff, entrar, sair }), [staff, entrar, sair])}>{children}</Ctx.Provider>;
}

export function useStaff(): StaffCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useStaff fora do <StaffProvider>');
  return c;
}

/**
 * Guard de rota. Isto e conveniencia de UI, nao seguranca — quem garante e o
 * `exigirRole` no backend. Esconder o botao nao protege o endpoint.
 */
export function RotaProtegida({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { staff } = useStaff();
  if (!staff) return <Navigate to="/login" replace />;
  if (staff.usuario.role !== 'ADMIN' && !roles.includes(staff.usuario.role)) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
