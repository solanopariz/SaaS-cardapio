import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatarBRL, parsearBRL } from '@cardapio/shared';
import { api } from '../../api/client.js';
import { useStaff } from '../../auth/StaffContext.jsx';

interface ProdutoAdmin {
  id: number;
  nome: string;
  precoCentavos: number;
  disponivel: boolean;
}

interface CategoriaAdmin {
  id: number;
  nome: string;
  ativa: boolean;
  produtos: ProdutoAdmin[];
}

/**
 * Chave local, nao em `QK`: aquele registro e dos dados que o socket empurra.
 * O cardapio do admin nao tem socket — muda quando ESTA tela edita, e so.
 */
const QK_CARDAPIO = ['admin', 'cardapio'] as const;

export function AdminPage() {
  const { staff, sair } = useStaff();
  const token = staff!.token;
  const qc = useQueryClient();

  const cardapio = useQuery({
    queryKey: QK_CARDAPIO,
    queryFn: () => api<CategoriaAdmin[]>('/admin/cardapio', { token }),
  });

  const recarregar = () => qc.invalidateQueries({ queryKey: QK_CARDAPIO });

  const criarCategoria = useMutation({
    mutationFn: (nome: string) =>
      api('/admin/categorias', { method: 'POST', token, body: { nome } }),
    onSuccess: recarregar,
  });

  const editarCategoria = useMutation({
    mutationFn: ({ id, ...campos }: { id: number } & Partial<CategoriaAdmin>) =>
      api(`/admin/categorias/${id}`, { method: 'PATCH', token, body: campos }),
    onSuccess: recarregar,
  });

  const editarProduto = useMutation({
    mutationFn: ({ id, ...campos }: { id: number } & Partial<ProdutoAdmin>) =>
      api(`/admin/produtos/${id}`, { method: 'PATCH', token, body: campos }),
    onSuccess: recarregar,
  });

  const criarProduto = useMutation({
    mutationFn: (p: { categoriaId: number; nome: string; precoCentavos: number }) =>
      api('/admin/produtos', { method: 'POST', token, body: p }),
    onSuccess: recarregar,
  });

  const [nomeCategoria, setNomeCategoria] = useState('');

  if (cardapio.isLoading) return <p>Carregando cardapio...</p>;
  if (cardapio.isError) return <p role="alert">Nao foi possivel carregar o cardapio.</p>;

  return (
    <main>
      <h1>Cardapio</h1>
      <p>
        <small>
          Tirar do cardapio nao apaga nada: o item some para o cliente e o historico das
          comandas antigas continua intacto. Mudar o preco nao mexe em comanda ja aberta.
        </small>
      </p>

      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          const n = nomeCategoria.trim();
          if (!n) return;
          criarCategoria.mutate(n, { onSuccess: () => setNomeCategoria('') });
        }}
      >
        <input
          aria-label="Nova categoria"
          placeholder="Nova categoria"
          value={nomeCategoria}
          onChange={(e) => setNomeCategoria(e.target.value)}
        />
        <button disabled={criarCategoria.isPending}>Criar categoria</button>
      </form>

      {criarCategoria.isError && <p role="alert">Nao foi possivel criar a categoria.</p>}

      {cardapio.data!.map((c) => (
        <section key={c.id} data-categoria={c.id}>
          <h2>
            {c.nome} {!c.ativa && <small>(fora do cardapio)</small>}
          </h2>

          <button
            onClick={() => editarCategoria.mutate({ id: c.id, ativa: !c.ativa })}
            disabled={editarCategoria.isPending}
          >
            {c.ativa ? 'Tirar categoria do cardapio' : 'Voltar categoria ao cardapio'}
          </button>

          {c.produtos.length === 0 && <p><small>Sem produtos.</small></p>}

          <ul>
            {c.produtos.map((p) => (
              <LinhaProduto
                key={p.id}
                produto={p}
                salvando={editarProduto.isPending}
                onSalvar={(campos) => editarProduto.mutate({ id: p.id, ...campos })}
              />
            ))}
          </ul>

          <NovoProduto
            categoriaId={c.id}
            salvando={criarProduto.isPending}
            onCriar={(p) => criarProduto.mutate(p)}
          />
        </section>
      ))}

      <button onClick={sair}>Sair</button>
    </main>
  );
}

function LinhaProduto({
  produto,
  salvando,
  onSalvar,
}: {
  produto: ProdutoAdmin;
  salvando: boolean;
  onSalvar: (campos: Partial<ProdutoAdmin>) => void;
}) {
  const [preco, setPreco] = useState(() => centavosParaCampo(produto.precoCentavos));
  const [erro, setErro] = useState<string | null>(null);

  const salvarPreco = () => {
    const centavos = parsearBRL(preco);
    if (centavos === null || centavos <= 0) {
      setErro('Preco invalido. Use virgula e nao use ponto de milhar: 1234,56');
      return;
    }
    setErro(null);
    if (centavos !== produto.precoCentavos) onSalvar({ precoCentavos: centavos });
  };

  return (
    <li data-produto={produto.id}>
      <strong>{produto.nome}</strong> — {formatarBRL(produto.precoCentavos)}
      {!produto.disponivel && <small> (esgotado)</small>}
      <input
        aria-label={`Preco de ${produto.nome}`}
        value={preco}
        onChange={(e) => setPreco(e.target.value)}
        onBlur={salvarPreco}
      />
      <button onClick={salvarPreco} disabled={salvando}>
        Salvar preco
      </button>
      <button
        onClick={() => onSalvar({ disponivel: !produto.disponivel })}
        disabled={salvando}
      >
        {produto.disponivel ? 'Marcar esgotado' : 'Voltar ao cardapio'}
      </button>
      {erro && <small role="alert">{erro}</small>}
    </li>
  );
}

function NovoProduto({
  categoriaId,
  salvando,
  onCriar,
}: {
  categoriaId: number;
  salvando: boolean;
  onCriar: (p: { categoriaId: number; nome: string; precoCentavos: number }) => void;
}) {
  const [nome, setNome] = useState('');
  const [preco, setPreco] = useState('');
  const [erro, setErro] = useState<string | null>(null);

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const n = nome.trim();
        const centavos = parsearBRL(preco);
        if (!n) return setErro('Falta o nome.');
        if (centavos === null || centavos <= 0) {
          return setErro('Preco invalido. Use virgula e nao use ponto de milhar: 1234,56');
        }
        setErro(null);
        onCriar({ categoriaId, nome: n, precoCentavos: centavos });
        setNome('');
        setPreco('');
      }}
    >
      <input
        aria-label="Nome do produto"
        placeholder="Novo produto"
        value={nome}
        onChange={(e) => setNome(e.target.value)}
      />
      <input
        aria-label="Preco do produto"
        placeholder="0,00"
        value={preco}
        onChange={(e) => setPreco(e.target.value)}
      />
      <button disabled={salvando}>Adicionar</button>
      {erro && <small role="alert">{erro}</small>}
    </form>
  );
}

/** 1990 -> "19,90". Sem "R$" e sem milhar: o campo e para digitar de volta. */
function centavosParaCampo(centavos: number): string {
  return `${Math.floor(centavos / 100)},${String(centavos % 100).padStart(2, '0')}`;
}
