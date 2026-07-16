import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatarBRL, parsearBRL, METODOS_PAGAMENTO, type MetodoPagamento } from '@cardapio/shared';
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

interface Recibo {
  mesaNumero: number;
  totalCentavos: number;
  trocoCentavos: number | null;
}

export function CaixaPage() {
  const { staff } = useStaff();
  const token = staff!.token;
  const qc = useQueryClient();
  const [aberta, setAberta] = useState<number | null>(null);
  const [recebidoTexto, setRecebidoTexto] = useState('');
  const [recibo, setRecibo] = useState<Recibo | null>(null);

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
    mutationFn: ({
      id,
      metodo,
      valorRecebidoCentavos,
      totalEsperadoCentavos,
    }: {
      id: number;
      metodo: MetodoPagamento;
      valorRecebidoCentavos: number | null;
      totalEsperadoCentavos: number;
    }) =>
      api<{ totalCentavos: number; trocoCentavos: number | null; mesaNumero: number }>(
        `/caixa/comandas/${id}/fechar`,
        {
          method: 'POST',
          token,
          body: { metodo, valorRecebidoCentavos, totalEsperadoCentavos },
        },
      ),
    onSuccess: (r) => {
      // NAO fecha o dialogo: em DINHEIRO o troco so existe aqui, e some junto
      // com a tela. O operador precisa ler o numero antes de abrir a gaveta.
      setRecibo({
        mesaNumero: r.mesaNumero,
        totalCentavos: r.totalCentavos,
        trocoCentavos: r.trocoCentavos,
      });
      void qc.invalidateQueries({ queryKey: QK.mesasCaixa });
    },
    onError: (e) => {
      // A conta mudou embaixo do operador. Puxa o total novo para a tela, senao
      // ele reclica no mesmo botao com o mesmo numero velho, para sempre.
      if (e instanceof ApiError && e.code === 'TOTAL_MUDOU') {
        void qc.invalidateQueries({ queryKey: ['comanda', aberta] });
      }
    },
  });

  function encerrar() {
    setAberta(null);
    setRecebidoTexto('');
    setRecibo(null);
    fechar.reset();
  }

  if (mesas.isLoading) return <p>Carregando mesas...</p>;

  const total = comanda.data?.totalCentavos ?? 0;
  const textoLimpo = recebidoTexto.trim();
  // null = vazio (o operador ainda nao digitou); undefined = digitou algo que
  // nao e dinheiro. Os dois casos merecem mensagens diferentes.
  const recebido = textoLimpo === '' ? null : (parsearBRL(textoLimpo) ?? undefined);
  const faltaDinheiro = typeof recebido === 'number' && recebido < total;
  const podeDinheiro = typeof recebido === 'number' && !faltaDinheiro;

  return (
    <main>
      <h1>Caixa</h1>

      <div className="grid-mesas">
        {mesas.data!.map((m) => (
          <button
            key={m.id}
            data-status={m.status}
            disabled={m.comandaId === null}
            onClick={() => {
              setAberta(m.comandaId);
              setRecebidoTexto('');
              setRecibo(null);
              fechar.reset();
            }}
          >
            <strong>Mesa {m.numero}</strong>
            <span>{m.status === 'AGUARDANDO_FECHAMENTO' ? 'PEDIU A CONTA' : m.status}</span>
            {m.comandaId && <span>{formatarBRL(m.totalParcialCentavos)}</span>}
          </button>
        ))}
      </div>

      {recibo && (
        <dialog open data-testid="recibo">
          <h2>Mesa {recibo.mesaNumero} fechada</h2>
          <p>Total: {formatarBRL(recibo.totalCentavos)}</p>
          {recibo.trocoCentavos !== null && (
            <p data-testid="troco-final">
              <strong>Troco: {formatarBRL(recibo.trocoCentavos)}</strong>
            </p>
          )}
          <button onClick={encerrar}>Concluir</button>
        </dialog>
      )}

      {!recibo && aberta !== null && comanda.data && (
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
            <strong>Total: {formatarBRL(total)}</strong>
          </p>

          <label>
            Valor recebido em dinheiro
            <input
              inputMode="decimal"
              value={recebidoTexto}
              placeholder="0,00"
              data-testid="valor-recebido"
              onChange={(e) => setRecebidoTexto(e.target.value)}
            />
          </label>

          {/* Preview local: o operador separa as notas ANTES de confirmar. O
              numero que vale e o que a API devolve — mas o guarda de
              TOTAL_MUDOU garante que os dois nao podem discordar. */}
          {recebido === undefined && (
            <p role="alert" data-testid="valor-invalido">
              Valor invalido. Sem ponto de milhar: escreva 1000 ou 1000,00.
            </p>
          )}
          {faltaDinheiro && (
            <p role="alert">Falta {formatarBRL(total - (recebido as number))}.</p>
          )}
          {podeDinheiro && (
            <p data-testid="troco-preview">Troco: {formatarBRL((recebido as number) - total)}</p>
          )}

          <p>Registre o metodo:</p>
          {METODOS_PAGAMENTO.map((metodo) => (
            <button
              key={metodo}
              disabled={fechar.isPending || (metodo === 'DINHEIRO' && !podeDinheiro)}
              onClick={() =>
                fechar.mutate({
                  id: aberta,
                  metodo,
                  valorRecebidoCentavos: metodo === 'DINHEIRO' ? (recebido as number) : null,
                  totalEsperadoCentavos: total,
                })
              }
            >
              {metodo}
            </button>
          ))}

          {fechar.isError && <p role="alert">{mensagemDeErro(fechar.error)}</p>}

          <button onClick={encerrar}>Voltar</button>
        </dialog>
      )}
    </main>
  );
}

/**
 * Cada erro precisa dizer o que FAZER. "Tente de novo" num VALOR_INSUFICIENTE
 * e mentira: reclicar com o mesmo valor falha para sempre.
 */
function mensagemDeErro(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Nao foi possivel fechar. Tente de novo.';
  switch (e.code) {
    case 'COMANDA_JA_FECHADA':
      return 'Esta comanda ja foi fechada por outro operador.';
    case 'COMANDA_CANCELADA':
      return 'Esta comanda foi cancelada.';
    case 'TOTAL_MUDOU':
      return 'A conta mudou: entrou pedido novo nesta mesa. Confira o total e cobre de novo.';
    case 'VALOR_INSUFICIENTE':
      // Backstop: o botao ja fica desabilitado neste caso. Se chegou aqui, a
      // tela e o servidor discordam — reconferir e a unica saida que funciona.
      return 'Valor recebido menor que o total. Confira as notas e digite de novo.';
    default:
      return 'Nao foi possivel fechar. Tente de novo.';
  }
}
