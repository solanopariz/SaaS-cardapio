import { useMutation, useQuery } from '@tanstack/react-query';
import { proximoStatus, formatarBRL, type PedidoPayload } from '@cardapio/shared';
import { api } from '../../api/client.js';
import { useStaff } from '../../auth/StaffContext.jsx';
import { QK, useSocket } from '../../realtime/useSocket.js';

export function CozinhaPage() {
  const { staff } = useStaff();
  const token = staff!.token;

  // Deltas por socket. O painel nao refaz GET a cada mudanca de status.
  useSocket(token);

  // Bootstrap por HTTP. O socket so aplica deltas em cima disto.
  const pedidos = useQuery({
    queryKey: QK.pedidosCozinha,
    queryFn: () => api<PedidoPayload[]>('/cozinha/pedidos', { token }),
    // Sem refetchInterval: o socket empurra. Polling aqui seria desperdicio.
    staleTime: Infinity,
  });

  const avancar = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api(`/pedidos/${id}/status`, { method: 'PATCH', token, body: { status } }),
    // Sem onSuccess: o evento `pedido:status` volta pelo socket e atualiza o
    // cache. Escrever aqui tambem duplicaria a logica.
  });

  const cancelar = useMutation({
    mutationFn: ({ id, motivo }: { id: number; motivo: string }) =>
      api(`/pedidos/${id}/cancelar`, { method: 'POST', token, body: { motivo } }),
  });

  if (pedidos.isLoading) return <p>Carregando pedidos...</p>;
  if (pedidos.isError) return <p role="alert">Erro ao carregar. Recarregue a pagina.</p>;

  const ativos = pedidos.data!.filter((p) => p.status !== 'CANCELADO' && p.status !== 'ENTREGUE');

  return (
    <main>
      <h1>Cozinha — {ativos.length} pedido(s)</h1>

      {ativos.length === 0 && <p>Nenhum pedido na fila.</p>}

      <div className="grid-pedidos">
        {ativos.map((p) => {
          const prox = proximoStatus(p.status);
          const itensAtivos = p.itens.filter((i) => i.canceladoEm === null);

          return (
            <article key={p.id} data-status={p.status}>
              <header>
                <h2>Mesa {p.mesaNumero}</h2>
                <span>
                  #{p.seq} · {p.status}
                </span>
                <time dateTime={p.criadoEm}>
                  {new Date(p.criadoEm).toLocaleTimeString('pt-BR', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </header>

              <ul>
                {itensAtivos.map((i) => (
                  <li key={i.id}>
                    <strong>
                      {i.qtd}x {i.produtoNome}
                    </strong>
                    {i.observacao && <em> — {i.observacao}</em>}
                    <small>{i.participanteApelido}</small>
                    <span>{formatarBRL(i.qtd * i.precoUnitarioCentavos)}</span>
                  </li>
                ))}
              </ul>

              {prox && (
                <button
                  onClick={() => avancar.mutate({ id: p.id, status: prox })}
                  disabled={avancar.isPending}
                >
                  Marcar como {prox}
                </button>
              )}

              <button
                onClick={() => {
                  const motivo = prompt('Motivo do cancelamento:');
                  if (motivo && motivo.trim().length >= 3) {
                    cancelar.mutate({ id: p.id, motivo: motivo.trim() });
                  }
                }}
              >
                Cancelar pedido
              </button>
            </article>
          );
        })}
      </div>
    </main>
  );
}
