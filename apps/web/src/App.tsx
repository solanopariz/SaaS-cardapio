import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StaffProvider, RotaProtegida } from './auth/StaffContext.jsx';
import { ComandaProvider } from './session/ComandaContext.jsx';
import { SessionGate } from './session/SessionGate.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { MenuPage } from './pages/menu/MenuPage.jsx';
import { CozinhaPage } from './pages/painel/CozinhaPage.jsx';
import { CaixaPage } from './pages/painel/CaixaPage.jsx';

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      // O socket empurra as atualizacoes. Refetch ao focar a janela so geraria
      // trafego redundante — e no painel da cozinha, um pisca-pisca.
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        {/*
          StaffProvider envolve TODAS as rotas, nao cada painel: o LoginPage
          precisa de `entrar()`, e um provider por rota daria a cada painel um
          estado proprio — sair da cozinha nao deslogaria do caixa.
        */}
        <StaffProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />

            {/* Cliente: SessionGate resolve ?m/?k, localStorage e limpeza da URL. */}
            <Route
              path="/menu"
              element={
                <ComandaProvider>
                  <SessionGate>
                    <MenuPage />
                  </SessionGate>
                </ComandaProvider>
              }
            />

            {/* Guard aqui e UI; quem protege de verdade e o `exigirRole` no backend. */}
            <Route
              path="/painel/cozinha"
              element={
                <RotaProtegida roles={['COZINHA']}>
                  <CozinhaPage />
                </RotaProtegida>
              }
            />
            <Route
              path="/painel/caixa"
              element={
                <RotaProtegida roles={['CAIXA']}>
                  <CaixaPage />
                </RotaProtegida>
              }
            />

            <Route path="*" element={<Navigate to="/menu" replace />} />
          </Routes>
        </StaffProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
