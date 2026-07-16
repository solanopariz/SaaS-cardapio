import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatarBRL, type PedidoPayload } from '@cardapio/shared';
import { api, ApiError, ehComandaFechada } from '../../api/client.js';
import { QK, useSocket } from '../../realtime/useSocket.js';
import { useComanda } from '../../session/ComandaContext.jsx';

interface Produto {
  id: number;
  nome: string;
  descricao: string | null;
  precoCentavos: number;
  imagemUrl: string | null;
}
interface Categoria {
  id: number;
  nome: string;
  produtos: Produto[];
}
interface ComandaDetalhe {
  id: number;
  mesaNumero: number;
  status: string;
  pedidos: PedidoPayload[];
  totalCentavos: number;
}

interface ItemCarrinho {
  produtoId: number;
  nome: string;
  precoCentavos: number;
  qtd: number;
  observacao: string | null;
}

export function MenuPage() {
  const { sessao, sair } = useComanda();
  const qc = useQueryClient();
  const [carrinho, setCarrinho] = useState<ItemCarrinho[]>([]);

  // Se o caixa fechar a mesa, o socket avisa e o app volta ao inicio.
  useSocket(sessao?.token ?? null, sair);

  const menu = useQuery({
    queryKey: ['menu'],
    queryFn: () => api<Categoria[]>('/menu'),
    staleTime: 60_000, // o cardapio nao muda durante o almoco
  });

  const comanda = useQuery({
    queryKey: QK.minhaComanda,
    queryFn: () => api<ComandaDetalhe>('/comandas/me', { token: sessao!.token }),
    enabled: !!sessao,
    retry: (falhas, err) => !ehComandaFechada(err) && falhas < 2,
  });

  // 410 Gone: a comanda acabou enquanto o celular estava offline.
  if (comanda.isError && ehComandaFechada(comanda.error)) {
    sair();
    return null;
  }

  /**
   * A chave de idempotencia pertence ao CARRINHO, nao a tentativa de envio.
   *
   * Gerar `crypto.randomUUID()` dentro do mutationFn seria inutil: cada retry
   * mandaria uma chave nova e o backend criaria um pedido novo. A chave nasce
   * junto com a intencao de enviar aquele carrinho e so morre quando o pedido
   * entra. Rede caiu, usuario clicou 3x? Mesma chave, um pedido so.
   */
  const chaveEnvio = useRef<string | null>(null);

  const enviarPedido = useMutation({
    mutationFn: (itens: ItemCarrinho[]) => {
      chaveEnvio.current ??= crypto.randomUUID();
      return api<PedidoPayload>('/comandas/me/pedidos', {
        method: 'POST',
        token: sessao!.token,
        idempotencyKey: chaveEnvio.current,
        body: {
          itens: itens.map((i) => ({
            produtoId: i.produtoId,
            qtd: i.qtd,
            observacao: i.observacao,
            participanteId: sessao!.participanteId,
          })),
        },
      });
    },
    onSuccess: () => {
      chaveEnvio.current = null; // proximo carrinho, chave nova
      setCarrinho([]);
      void qc.invalidateQueries({ queryKey: QK.minhaComanda });
    },
    onError: (err) => {
      /**
       * 409 IDEMPOTENCY_KEY_REUSADA: o servidor recusou porque esta chave ja
       * entrou com OUTROS itens. Ou seja, o pedido original FOI registrado — o
       * que se perdeu foi so a resposta.
       *
       * Isto nao deveria acontecer pela UI: `travado` abaixo impede o carrinho
       * de mudar enquanto a chave vive. Se chegou aqui, foi por um caminho que
       * nao previmos — entao recarrega a comanda para o cliente ao menos VER o
       * que ja entrou, em vez de ficar tocando num botao que nunca vai passar.
       *
       * A chave NAO e limpa aqui de proposito: limpar convidaria o cliente a
       * reenviar o carrinho inteiro com chave nova e duplicar o que ja entrou.
       */
      if (err instanceof ApiError && err.code === 'IDEMPOTENCY_KEY_REUSADA') {
        void qc.invalidateQueries({ queryKey: QK.minhaComanda });
      }
    },
    // Fora do 409, nao limpa a chave: e justamente no erro que ela precisa
    // sobreviver — o proximo toque tem que ser o MESMO pedido, nao um novo.
  });

  /**
   * Envio falhou e a chave continua viva. O carrinho fica CONGELADO ate o
   * reenvio passar.
   *
   * Sem isto: o cliente adiciona um item, toca de novo, e o servidor ve a mesma
   * chave com conteudo diferente. Ele recusa (409, corretamente — senao o item
   * novo sumiria calado), e a tela diz "toque de novo", e tocar de novo da 409
   * de novo. Loop fechado, verificado no navegador.
   *
   * Congelando o carrinho, o reenvio carrega o payload identico: o servidor
   * devolve o pedido original com 200, `onSuccess` limpa tudo e recarrega a
   * comanda. Ai sim o cliente ve o que pediu e pode pedir mais.
   */
  const travado = enviarPedido.isError;

  const pedirConta = useMutation({
    mutationFn: () => api('/comandas/me/conta', { method: 'POST', token: sessao!.token }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QK.minhaComanda }),
  });

  if (menu.isLoading) return <p>Carregando cardapio...</p>;
  if (menu.isError) return <p role="alert">Nao foi possivel carregar o cardapio.</p>;

  const adicionar = (p: Produto) =>
    setCarrinho((c) => {
      const existe = c.find((i) => i.produtoId === p.id);
      return existe
        ? c.map((i) => (i.produtoId === p.id ? { ...i, qtd: i.qtd + 1 } : i))
        : [...c, { produtoId: p.id, nome: p.nome, precoCentavos: p.precoCentavos, qtd: 1, observacao: null }];
    });

  const totalCarrinho = carrinho.reduce((a, i) => a + i.qtd * i.precoCentavos, 0);
  const contaPedida = comanda.data?.status === 'AGUARDANDO_PAGAMENTO';

  return (
    <main>
      <header>
        <strong>Mesa {sessao!.mesaNumero}</strong> · {sessao!.apelido}
      </header>

      {contaPedida && (
        <p role="status">Conta solicitada. Um atendente vai ate voce.</p>
      )}

      {menu.data!.map((cat) => (
        <section key={cat.id}>
          <h2>{cat.nome}</h2>
          <ul>
            {cat.produtos.map((p) => (
              <li key={p.id}>
                <div>
                  <strong>{p.nome}</strong>
                  {p.descricao && <small>{p.descricao}</small>}
                  <span>{formatarBRL(p.precoCentavos)}</span>
                </div>
                <button onClick={() => adicionar(p)} disabled={contaPedida || travado}>
                  Adicionar
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {carrinho.length > 0 && (
        <aside>
          <h2>Carrinho — {formatarBRL(totalCarrinho)}</h2>
          <ul>
            {carrinho.map((i) => (
              <li key={i.produtoId}>
                {i.qtd}x {i.nome}
              </li>
            ))}
          </ul>
          <button onClick={() => enviarPedido.mutate(carrinho)} disabled={enviarPedido.isPending}>
            {enviarPedido.isPending ? 'Enviando...' : 'Enviar pedido'}
          </button>
          {enviarPedido.isError && (
            <p role="alert">
              {enviarPedido.error instanceof ApiError &&
              enviarPedido.error.code === 'IDEMPOTENCY_KEY_REUSADA'
                ? 'Este pedido ja foi registrado — veja em "Seus pedidos" abaixo. ' +
                  'Para pedir mais, chame o atendente.'
                : 'Falhou. Toque de novo — nao vai duplicar.'}
            </p>
          )}
          {travado && (
            <p role="status">
              Reenvie este pedido antes de adicionar outros itens — assim ele nao duplica.
            </p>
          )}
        </aside>
      )}

      {comanda.data && comanda.data.pedidos.length > 0 && (
        <section>
          <h2>Seus pedidos</h2>
          <ul>
            {comanda.data.pedidos.map((p) => (
              <li key={p.id}>
                Pedido #{p.seq} — <strong>{p.status}</strong>
              </li>
            ))}
          </ul>
          <p>Total: {formatarBRL(comanda.data.totalCentavos)}</p>
          <button onClick={() => pedirConta.mutate()} disabled={contaPedida || pedirConta.isPending}>
            Pedir a conta
          </button>
        </section>
      )}
    </main>
  );
}
