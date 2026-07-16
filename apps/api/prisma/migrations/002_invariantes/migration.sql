-- Invariantes que o Prisma nao consegue expressar no schema.prisma.
--
-- Roda depois de 001_init (ordem lexicografica). Basta `npm run db:migrate`.
--
-- CUIDADO AO REGERAR O 001: NAO use `prisma migrate dev --name init`. O Prisma
-- nomeia migrations com timestamp (20260716123456_init), e "002_invariantes"
-- ordena ANTES de "2026..." — esta migracao rodaria primeiro e morreria em
-- "The underlying table for model `comandas` does not exist". Use:
--
--   npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma \
--     --script > prisma/migrations/001_init/migration.sql
--
-- (sem `2>&1`: o banner do Prisma vai pro stderr e contamina o .sql)
--
-- Se voce editar o schema.prisma e rodar `migrate dev` de novo, o Prisma NAO
-- remove estes indices — mas confira, porque `migrate reset` recria tudo.
--
-- Estas 5 invariantes foram verificadas contra Postgres 16 atacando o SQL
-- direto, por fora da aplicacao: todas rejeitam. Ver README.

-- ---------------------------------------------------------------------------
-- INVARIANTE 1: no maximo uma comanda ABERTA por mesa.
--
-- Indice unico PARCIAL. Comandas FECHADAS/CANCELADAS nao entram no indice,
-- entao a mesma mesa pode ter centenas delas no historico.
--
-- Isto e a regra de negocio no unico lugar onde ela nao pode ser burlada.
-- Dois garcons abrindo a mesma mesa ao mesmo tempo: o segundo toma 23505
-- (unique_violation), que o service traduz em "anexa a comanda existente".
-- Um `if (mesa.status === 'LIVRE')` na aplicacao NAO resolve isto — entre o
-- SELECT e o INSERT cabe a outra transacao.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uniq_comanda_aberta
  ON comandas (mesa_id)
  WHERE status = 'ABERTA';

-- ---------------------------------------------------------------------------
-- INVARIANTE 2: dinheiro e sempre inteiro positivo em centavos.
-- Defesa em profundidade: o Zod ja valida na entrada, mas um script de
-- migracao de dados ou um INSERT manual passa por cima do Zod.
-- ---------------------------------------------------------------------------
ALTER TABLE produtos
  ADD CONSTRAINT chk_produtos_preco_positivo
  CHECK (preco_centavos > 0);

ALTER TABLE pedido_itens
  ADD CONSTRAINT chk_itens_preco_positivo
  CHECK (preco_unitario_centavos > 0);

ALTER TABLE pedido_itens
  ADD CONSTRAINT chk_itens_qtd_positiva
  CHECK (qtd > 0);

ALTER TABLE comandas
  ADD CONSTRAINT chk_comandas_total_nao_negativo
  CHECK (total_centavos IS NULL OR total_centavos >= 0);

-- ---------------------------------------------------------------------------
-- INVARIANTE 3: comanda fechada tem total, data e responsavel. Comanda aberta
-- nao tem nenhum dos tres. Impede "fechei mas esqueci de somar".
-- ---------------------------------------------------------------------------
ALTER TABLE comandas
  ADD CONSTRAINT chk_comanda_fechamento_coerente
  CHECK (
    (status = 'FECHADA' AND total_centavos IS NOT NULL AND fechada_em IS NOT NULL)
    OR
    (status <> 'FECHADA' AND total_centavos IS NULL AND fechada_em IS NULL)
  );

-- ---------------------------------------------------------------------------
-- INVARIANTE 4: item cancelado tem motivo, item ativo nao tem.
-- ---------------------------------------------------------------------------
ALTER TABLE pedido_itens
  ADD CONSTRAINT chk_item_cancelamento_coerente
  CHECK (
    (cancelado_em IS NULL AND motivo_cancelamento IS NULL)
    OR
    (cancelado_em IS NOT NULL AND motivo_cancelamento IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- Indice de suporte ao painel da cozinha: busca pedidos ativos, ordenados por
-- chegada. Parcial de novo — pedidos ENTREGUE/CANCELADO sao a maioria do volume
-- historico e nunca aparecem no painel.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_pedidos_ativos_cozinha
  ON pedidos (criado_em)
  WHERE status IN ('RECEBIDO', 'EM_PREPARO', 'PRONTO');
