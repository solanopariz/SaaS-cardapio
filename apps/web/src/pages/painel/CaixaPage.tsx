import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatarBRL, METODOS_PAGAMENTO, type MetodoPagamento } from '@cardapio/shared';
import { api, ApiError } from '../../api/client.js';
import { useStaff } from '../../auth/StaffContext.jsx';
import { QK, useSocket } from '../../realtime/useSocket.js';

interface MesaResumo {
  id: number;
  numero: number;
  status: 'LIVRE' | 'OCUPADA' | 'AGUARDANDO_FECHAMENTO';
  comandaId: number | null;
  totalParcialCentavos: number;
}

interface ComandaDetalhe {
  id: number;
  mesaNumero: number;
  totalCentavos: number;
  totalPorParticipante: Record<string, number>;
}

export function CaixaPage() {
  const { staff } = useStaff();
  const token = staff!.token;
  const qc = useQueryClient();
  const [aberta, setAberta] = useState<number | null>(null);

  useSocket(token);

  const mesas = useQuery({
    queryKey: QK.mesasCaixa,
    queryFn: () => api<MesaResumo[]>('/caixa/mesas', { token }),
    staleTime: Infinity, // o socket empurra
  });

  const comanda = useQuery({
    queryKey: ['comanda', aberta],
    queryFn: () => api<ComandaDetalhe>(`/caixa/comandas/${aberta}`, { token }),
    enabled: aberta !== null,
  });

  const fechar = useMutation({
    mutationFn: ({ id, metodo }: { id: number; metodo: MetodoPagamento }) =>
      api<{ totalCentavos: number; trocoCentavos: number | null }>(
        `/caixa/comandas/${id}/fechar`,
        {
          method: 'POST',
          token,
          body: {
            metodo,
            // Simplificacao: em DINHEIRO o operador digita o valor recebido.
            valorRecebidoCentavos:
              metodo === 'DINHEIRO' ? (comanda.data?.totalCentavos ?? 0) : null,
          },
        },
      ),
    onSuccess: () => {
      setAberta(null);
      void qc.invalidateQueries({ queryKey: QK.mesasCaixa });
    },
  });

  if (mesas.isLoading) return <p>Carregando mesas...</p>;

  return (
    <main>
      <h1>Caixa</h1>

      <div className="grid-mesas">
        {mesas.data!.map((m) => (
          <button
            key={m.id}
            data-status={m.status}
            disabled={m.comandaId === null}
            onClick={() => setAberta(m.comandaId)}
          >
            <strong>Mesa {m.numero}</strong>
            <span>{m.status === 'AGUARDANDO_FECHAMENTO' ? 'PEDIU A CONTA' : m.status}</span>
            {m.comandaId && <span>{formatarBRL(m.totalParcialCentavos)}</span>}
          </button>
        ))}
      </div>

      {aberta !== null && comanda.data && (
        <dialog open>
          <h2>Mesa {comanda.data.mesaNumero}</h2>

          <h3>Divisao</h3>
          <ul>
            {Object.entries(comanda.data.totalPorParticipante).map(([apelido, centavos]) => (
              <li key={apelido}>
                {apelido}: {formatarBRL(centavos)}
              </li>
            ))}
          </ul>

          <p>
            <strong>Total: {formatarBRL(comanda.data.totalCentavos)}</strong>
          </p>

          <p>Pagamento processado na maquininha. Registre o metodo:</p>
          {METODOS_PAGAMENTO.map((metodo) => (
            <button
              key={metodo}
              disabled={fechar.isPending}
              onClick={() => fechar.mutate({ id: aberta, metodo })}
            >
              {metodo}
            </button>
          ))}

          {/* 409: outro operador fechou esta comanda enquanto o dialogo estava aberto. */}
          {fechar.isError && (
            <p role="alert">
              {fechar.error instanceof ApiError && fechar.error.status === 409
                ? 'Esta comanda ja foi fechada por outro operador.'
                : 'Nao foi possivel fechar. Tente de novo.'}
            </p>
          )}

          <button onClick={() => setAberta(null)}>Voltar</button>
        </dialog>
      )}
    </main>
  );
}
