import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import {
  EV,
  type ComandaFechadaPayload,
  type ItemCanceladoPayload,
  type PedidoPayload,
  type PedidoStatusPayload,
  type ServerToClientEvents,
} from '@cardapio/shared';

type TypedSocket = Socket<ServerToClientEvents>;

export const QK = {
  pedidosCozinha: ['pedidos', 'cozinha'] as const,
  mesasCaixa: ['mesas', 'caixa'] as const,
  minhaComanda: ['comanda', 'me'] as const,
};

/**
 * Conexao unica, autenticada no handshake.
 *
 * PONTO DE PERFORMANCE: cada evento escreve no cache do TanStack Query via
 * `setQueryData`. Nao chamamos `invalidateQueries`.
 *
 * Um painel de cozinha com 40 pedidos, num almoco movimentado, recebe dezenas
 * de eventos por minuto. Se cada um disparasse refetch, o servidor levaria uma
 * enxurrada de `GET /cozinha/pedidos` justamente na hora de pico — e o painel
 * piscaria a cada resposta. O evento ja traz o delta; aplique o delta.
 *
 * `invalidateQueries` fica reservado para o `reconnect`, onde de fato nao
 * sabemos o que perdemos.
 */
export function useSocket(token: string | null, aoFecharComanda?: () => void): void {
  const qc = useQueryClient();
  const fecharRef = useRef(aoFecharComanda);
  fecharRef.current = aoFecharComanda;

  useEffect(() => {
    if (!token) return;

    const socket: TypedSocket = io({ auth: { token } });

    socket.on(EV.PEDIDO_NOVO, (p: PedidoPayload) => {
      // O payload traz o pedido inteiro: aplica o delta, sem refetch.
      qc.setQueryData<PedidoPayload[]>(QK.pedidosCozinha, (prev) =>
        prev ? [...prev, p] : [p],
      );
      // Ja o total parcial da mesa e derivado no servidor e nao vem no payload.
      // Aqui invalidar e correto — e barato, so o caixa escuta.
      void qc.invalidateQueries({ queryKey: QK.mesasCaixa });
    });

    socket.on(EV.PEDIDO_STATUS, (p: PedidoStatusPayload) => {
      aplicarStatus(qc, p);
    });

    socket.on(EV.PEDIDO_CANCELADO, (p: PedidoStatusPayload) => {
      aplicarStatus(qc, p);
    });

    socket.on(EV.ITEM_CANCELADO, (p: ItemCanceladoPayload) => {
      qc.setQueryData<PedidoPayload[]>(QK.pedidosCozinha, (prev) =>
        prev?.map((pedido) =>
          pedido.id === p.pedidoId
            ? {
                ...pedido,
                itens: pedido.itens.map((i) =>
                  i.id === p.itemId ? { ...i, canceladoEm: new Date().toISOString() } : i,
                ),
              }
            : pedido,
        ),
      );
      // O total da comanda mudou. Aqui invalidar E o certo: o total e derivado
      // no servidor e o payload do evento nao o carrega.
      void qc.invalidateQueries({ queryKey: QK.minhaComanda });
    });

    socket.on(EV.COMANDA_FECHADA, (_p: ComandaFechadaPayload) => {
      fecharRef.current?.();
    });

    socket.on(EV.CONTA_SOLICITADA, () => {
      void qc.invalidateQueries({ queryKey: QK.mesasCaixa });
    });

    socket.on(EV.MESA_STATUS, () => {
      void qc.invalidateQueries({ queryKey: QK.mesasCaixa });
    });

    /**
     * O socket NAO e fonte de verdade. Os eventos emitidos enquanto estavamos
     * offline nao existem — nenhuma fila os guarda. Ao reconectar, jogamos fora
     * o cache e refazemos o bootstrap por HTTP.
     */
    socket.io.on('reconnect', () => {
      void qc.invalidateQueries();
    });

    return () => {
      socket.disconnect();
    };
  }, [token, qc]);
}

function aplicarStatus(qc: QueryClient, p: PedidoStatusPayload): void {
  qc.setQueryData<PedidoPayload[]>(QK.pedidosCozinha, (prev) =>
    prev?.map((pedido) => (pedido.id === p.id ? { ...pedido, status: p.status } : pedido)),
  );
  qc.setQueryData<{ pedidos: PedidoPayload[] } | undefined>(QK.minhaComanda, (prev) =>
    prev
      ? {
          ...prev,
          pedidos: prev.pedidos.map((pedido) =>
            pedido.id === p.id ? { ...pedido, status: p.status } : pedido,
          ),
        }
      : prev,
  );
}
