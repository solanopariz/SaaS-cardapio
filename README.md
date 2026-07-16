# Cardápio Digital Integrado

Pedidos por QR Code na mesa, painel de cozinha em tempo real, fechamento no caixa.

> **Estado:** compila, migra, roda. Testado em Node 22.11 / Postgres 16.
> `npm test` verde: 108 testes (36 em `shared`, 72 de integração no `api`), mais
> 25 E2E em `npm run test:e2e` — e mais 3 que só rodam com `E2E_HOST=<ip>`, na
> origem insegura que o celular do cliente usa de verdade.
> As 5 invariantes SQL da migration 002 foram atacadas direto no banco, por fora
> da aplicação, e todas rejeitam. O isolamento de rooms do socket foi verificado
> com conexões reais — e o teste foi validado reintroduzindo a falha, para provar
> que ele fica vermelho.
>
> Rodar o código achou **oito bugs que compilavam bem**:
>
> | Bug | Sintoma |
> |---|---|
> | `listen` antes de `criarIo` | 500 numa comanda que **foi** criada |
> | Pedido em voo no fechamento | conta fechada por R$ 15 com R$ 30 dentro |
> | Colisão de `seq` | 3 de 4 amigos pedindo junto tomavam erro interno |
> | Chave de idempotência sem conteúdo | item sumia sem erro |
> | Loop do 409 na tela | "toque de novo" → 409 → para sempre |
> | **`@local` no seed** | **ninguém nunca conseguiu logar nos painéis** |
> | `pedido:novo` não ia ao caixa | total do grid congelado o serviço inteiro |
> | `credencial` sobrevivia à sessão | celular seguia amarrado à mesa após pagar |
>
> Nenhum era erro de tipo. O compilador esteve verde durante os oito. Cada um
> nasceu da **costura** entre dois arquivos individualmente corretos.

## Pré-requisitos

```powershell
winget install OpenJS.NodeJS.LTS        # >= 20.6
winget install Docker.DockerDesktop     # ou PostgreSQL.PostgreSQL.16
```

## Subir

```bash
cp .env.example .env          # e troque os dois JWT_SECRET

# Postgres via Docker:
docker run -d --name cardapio-db -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=cardapio postgres:16

npm install
npm run db:migrate            # cria as tabelas (001) + invariantes SQL (002)
npm run db:seed               # 20 mesas, cardápio de exemplo, 3 usuários
npm run qr                    # gera qrcodes/mesa-01.png ...
npm run dev                   # API :3333, web :5173
```

Logins do seed: `admin@cardapio.local`, `cozinha@cardapio.local`,
`caixa@cardapio.local` — senha `trocar123`.

> O domínio **precisa** de um ponto. `loginSchema` valida com `z.string().email()`,
> que exige TLD: `@local` era rejeitado com **400** antes de a senha ser
> conferida, e os painéis da cozinha e do caixa nunca abriram para ninguém.
> [`test/auth.login.test.ts`](apps/api/test/auth.login.test.ts) roda o seed de
> verdade e loga com estas credenciais — se elas quebrarem, o CI reclama.

Cliente: abra `qrcodes/mesa-01.png`, escaneie, ou cole a URL que o `npm run qr` imprimiu.

## Testes

```bash
npm test                          # unitários + integração
npm test --workspace=packages/shared   # puros, sem Docker
npm test --workspace=apps/api          # integração: PRECISA de Docker rodando
npm run test:e2e                       # Postgres → API → Vite → Chromium
npm run test:e2e:ui                    # o mesmo, com o inspetor do Playwright
```

O E2E sobe a stack inteira em **banco e portas próprios** (`cardapio_e2e`,
`:3399`/`:5199`). Ele não toca no seu `npm run dev` nem no banco de dev — sem
isso, rodá-lo derrubaria o seu banco e trocaria o `qr_secret` de todas as mesas,
invalidando qualquer QR já impresso.

O `api` usa Testcontainers: cada arquivo sobe um `postgres:16` descartável e
aplica as migrations nele. Não dá para trocar por sqlite ou mock — o que está sob
teste **é o árbitro do banco**. `uniq_comanda_aberta` é um índice único *parcial*;
sqlite não tem isso, e um mock só devolveria a resposta que o autor do mock já
acreditava.

> Ver `prisma:error ... Unique constraint failed` no output de um teste **verde**
> é esperado: é o Prisma logando o 23505 que o service captura e trata. A ausência
> dessas linhas significaria que a corrida não colidiu e o teste passou à toa.

**Um teste de corrida que não colide passa e não prova nada.** Por isso
`sessao.join.test.ts` tem dois: um dispara 12 requests e torce pela colisão
(pega deadlock, pool esgotado, 500 sob carga); o outro **força** o P2002 segurando
uma transação não-commitada, e é o único que prova que o retry existe.

**Todo teste de negativa tem um controle positivo ao lado.** Em
`rooms.test.ts`, afirmar "a mesa A não recebe o evento da mesa B" passaria também
se o `emit` nunca tivesse saído — e emit que falha não lança, a
[REGRA 2](#o-cliente-nunca-emite-evento-de-socket) engole em silêncio de
propósito. Então todo teste que afirma "não chegou" afirma junto que **chegou em
quem devia**. Sem isso, "isolamento" e "emissor morto" são indistinguíveis.

## Como isto funciona

### O QR Code é uma senha permanente da mesa — e é fraco de propósito

O adesivo impresso carrega `?m=14&k=<16 chars>`. O `k` é o `qr_secret` da mesa,
gerado uma vez no seed e **nunca rotacionado** — rotacionar exigiria reimprimir o
adesivo a cada cliente.

Seja honesto sobre o que ele faz: o `k` prova que você **esteve** na mesa, não que
você **está**. O adesivo é público e imutável. Todo ex-cliente tem o `k` no
histórico do navegador; todo garçom demitido tem os 20; quem fotografou a mesa tem
aquele. São 64 bits de entropia defendendo contra o ataque que ninguém vai fazer
(adivinhar) e zero defesa contra o que é trivial (ler o adesivo).

Então o `k` é **anti-trote casual**, não autorização. Ele para quem chuta URL.
Não para quem jantou aqui semana passada e colou a URL de casa.

Isso deixa uma impossibilidade no `/join`, e ela não é bug:

|  | amigo chegou atrasado | ex-cliente em casa |
|---|---|---|
| `k` | válido | válido |
| comanda | aberta, existente | aberta, existente |
| `deviceId` | novo | novo |

São idênticos. Nenhum `if` separa os dois, porque o que os separa — presença
física *agora* — nunca chega no servidor. O `k` não carrega tempo.

O que segura isso hoje não é criptografia: é que a mesa 14 tem gente sentada nela
que vê a comanda e fala "eu não pedi isso". Por isso `PedidoItem.participanteId`
existe, e no *item*, não no pedido. Atribuição é a defesa real. Ver
[Antes de qualquer piloto](#antes-de-qualquer-piloto).

O que rotaciona é o **JWT de comanda**, emitido no `/join` e morto quando o caixa
fecha a mesa. É ele que vive no `localStorage` e sobrevive ao F5.

`qrcodes/` está no `.gitignore`: cada PNG contém o segredo de uma mesa.

### O cliente nunca emite evento de socket

Toda mutação é HTTP — transacional, validada, idempotente. O socket é canal de
leitura. E todo `emit` acontece **depois do COMMIT**: emitir dentro da transação e
depois dar rollback põe a cozinha a preparar um pedido que não existe.

O corolário só apareceu quando o código rodou pela primeira vez: **se o `emit`
falha, o request não pode falhar.** Quando o emissor roda, o COMMIT já aconteceu
— lançar ali devolveria 500 para uma operação que deu certo, e o cliente acharia
que não tem comanda, tendo. Não há rollback a dar. Então o emit é best-effort:
loga e engole.

Isso não é tolerância a bug, é a mesma premissa de sempre — o socket não é fonte
de verdade, e o cliente já se realinha no refetch. Um emit perdido é um evento
perdido, que é justamente a categoria que o `reconnect` existe para tratar.

Ver [`apps/api/src/realtime/emit.ts`](apps/api/src/realtime/emit.ts) (REGRA 1 e 2)
e [`test/realtime/emit.test.ts`](apps/api/test/realtime/emit.test.ts).

### O total nunca é armazenado enquanto a comanda está aberta

É derivado de `calcularTotalComanda` sobre `preco_unitario_centavos` — um snapshot
do preço no momento do pedido. Subir o preço da coxinha não muda a comanda aberta.
Só o fechamento grava `comandas.total_centavos`, como recibo imutável.

Dinheiro é sempre `INTEGER` em centavos.

### As invariantes vivem no banco, não em `if`

[`002_invariantes/migration.sql`](apps/api/prisma/migrations/002_invariantes/migration.sql):

- `uniq_comanda_aberta` — índice único **parcial**: no máximo uma comanda `ABERTA`
  por mesa. Dois clientes escaneando no mesmo instante: um vence, o outro anexa.
  Um `if (mesa.status === 'LIVRE')` não resolve — entre o `SELECT` e o `INSERT`
  cabe a outra transação.
- `CHECK` de preço positivo, de coerência de fechamento e de cancelamento.

Fechar conta usa `SELECT ... FOR UPDATE`: dois caixas clicando junto, um recebe 409.

**E criar pedido toma o mesmo lock** — isto não estava aqui até os testes rodarem.
O `FOR UPDATE` do fechamento protegia a comanda contra outro *fechamento*, mas
não contra um *pedido*: `criarPedido` lia o status e inseria ~4 queries depois, e
o caixa fechando nessa janela commitava no meio. O pedido entrava numa comanda já
`FECHADA`, fora do total recém-gravado — a cozinha preparava, o cliente comia,
ninguém cobrava. Reproduzido em 5 de 8 tentativas antes do conserto.

Travar a comanda antes de ler o status ordena os dois: ou o fechamento espera e
soma o pedido, ou o pedido relê `FECHADA` e devolve 409. De quebra resolve a
colisão de `seq` — `aggregate(_max) + 1` fora de lock fazia dois pedidos
simultâneos calcularem o mesmo número e estourar em `@@unique([comandaId, seq])`,
que virava **500**. Quatro amigos pedindo junto: três tomavam "erro interno".

A lição não é sobre lock. É que `FOR UPDATE` na linha certa não vale nada se a
decisão for tomada **antes** dele.

**E o lock não protege quem está fora do banco.** O total que o servidor calcula
dentro da transação está sempre certo — mas o operador do caixa decidiu quanto
cobrar olhando a tela, segundos antes. Se um pedido entrar nessa janela, o
servidor cobra R$ 39,90 de uma pessoa que combinou R$ 28,90 e já contou o troco
de uma nota de 50. Ninguém erra; o dinheiro some do mesmo jeito.

Por isso `fecharComandaSchema` exige `totalEsperadoCentavos`: a tela declara o
total que **exibiu**, e o fechamento compara dentro do lock — divergiu, 409
`TOTAL_MUDOU`, e o operador relê a conta em vez de cobrar um número que não é
mais o da mesa. O campo é obrigatório de propósito: opcional, seria um guarda que
uma tela futura esquece em silêncio.

O 409 vem **antes** do `VALOR_INSUFICIENTE`: se a conta mudou, dizer "faltou
dinheiro" manda o operador buscar mais notas em vez de reler a conta.

### A chave de idempotência cobre o carrinho — e o que tem dentro dele

O celular manda `Idempotency-Key` no POST de pedido. A chave nasce com o carrinho,
não com a tentativa de envio ([MenuPage.tsx](apps/web/src/pages/menu/MenuPage.tsx)):
gerar um UUID novo a cada retry anularia o mecanismo. Ela só morre quando o pedido
entra — no erro ela sobrevive, que é justamente quando ela serve.

Isso está certo, e o teste confirma: quatro POSTs simultâneos com a mesma chave
geram **um** pedido, sem 500.

Mas a chave identificava a *tentativa* e não o *conteúdo*, e isso abria uma perda
silenciosa. Rede cai depois de o servidor gravar a picanha; o cliente adiciona uma
coca e reenvia com a mesma chave (o front não a limpou, corretamente). O servidor
achava a chave e devolvia o pedido original com **200**. O front tratava como
sucesso, limpava o carrinho — **e a coca evaporava**. Sem erro, sem log.

Agora o servidor compara os itens recebidos com os do pedido gravado e devolve
**409 `IDEMPOTENCY_KEY_REUSADA`**. A comparação é sobre o que o cliente *pediu*
(`produtoId`, `qtd`, `participanteId`, `observacao`) e deliberadamente ignora:

- **ordem** — o mesmo carrinho embaralhado é o mesmo pedido;
- **preço** — é snapshot do servidor, não vem do cliente;
- **`canceladoEm`** — se a cozinha cancelou o item entre a tentativa e o retry,
  o retry continua sendo o mesmo pedido. Assinar o que aconteceu *depois* faria
  uma ação da cozinha virar 409 na cara de quem só tem rede ruim.

Não há coluna de hash: os itens do pedido **já são** o payload. Uma segunda cópia
divergiria — o mesmo motivo que põe `total.ts` no `shared`.

**E o carrinho congela enquanto a chave viver.** Esse 409 correto criou, na tela,
um loop fechado — verificado no navegador: o cliente adicionava um item, tocava
"Enviar", tomava 409, e a mensagem *"Toque de novo — não vai duplicar"* mandava
repetir a única ação que nunca passaria. Três toques, três 409. E ele não via a
coxinha que já estava na cozinha, porque `pedido:novo` vai só para a cozinha
("o cliente já tem a resposta do POST" — premissa que quebra justo quando a
resposta se perde, que é o caso inteiro do `Idempotency-Key`).

Com `Adicionar` desabilitado enquanto há erro pendente, o payload não pode
divergir: o reenvio carrega os mesmos itens, o servidor devolve o pedido original
com 200, o `onSuccess` limpa o carrinho e recarrega a comanda — e a coxinha
aparece. A mensagem volta a ser verdade em vez de armadilha.

### Socket não é fonte de verdade

Estado inicial sempre por HTTP (`GET /cozinha/pedidos`). O socket só aplica deltas
via `setQueryData` — **não** `invalidateQueries`, senão 40 pedidos virariam 40
refetches na hora do pico. No `reconnect`, aí sim, invalida tudo: os eventos
perdidos durante a queda não existem e nenhuma fila os recupera.

Verificado no navegador: cliente pede → a cozinha vê em **~250ms sem refresh**;
a cozinha marca `EM_PREPARO` → o celular do cliente vê em **~250ms**.

**Quem recebe o quê é decidido pelo dinheiro, não pelo interesse.** O caixa
recebe `pedido:novo`, `item:cancelado` e `pedido:cancelado` — os três que mexem
no total do grid. Não recebe `pedido:status`: `RECEBIDO → EM_PREPARO` não muda
número nenhum na tela dele, e mandar seria tráfego puro.

Isso não estava assim. `pedido:novo` ia só para a cozinha ("só a cozinha
precisa"), enquanto o `useSocket` invalidava as mesas do caixa ao recebê-lo
("é barato, **só o caixa escuta**") e a `CaixaPage` desligava o refetch com
`staleTime: Infinity` ("o socket empurra"). Três decisões defensáveis; juntas,
o total do grid do caixa ficava **congelado o serviço inteiro**. Medido no
navegador: R$ 65,70 na tela contra R$ 69,70 no banco, só corrigindo no F5.

Não era risco de dinheiro — o diálogo de fechamento refaz o fetch e o
`fecharComanda` recalcula no servidor. Era o número que o caixa olha de relance
estar errado o tempo todo.

Ver [`apps/web/src/realtime/useSocket.ts`](apps/web/src/realtime/useSocket.ts) e
[`test/realtime/rooms.test.ts`](apps/api/test/realtime/rooms.test.ts).

## Estrutura

```
packages/shared/    schemas Zod, nomes de evento, máquina de estados, aritmética de dinheiro
apps/api/           Fastify + Prisma + Socket.IO
apps/web/           React + TanStack Query
```

`status.ts` e `total.ts` ficam em `shared` porque o front precisa dos dois: o cliente
vê o total, o painel precisa do próximo status para desenhar o botão. Duas
implementações de cálculo de dinheiro divergiriam na hora de fechar a conta.

## Antes de qualquer piloto

Este código é um exercício. Enquanto for exercício, o `k` fraco está **certo**:
não se otimiza fechadura de casa sem fundação, e isto aqui nunca rodou.

O risco não é o design. É a transição. O convite pra testar não vem com checklist
— vem por WhatsApp numa quinta ("traz aí sexta que a gente testa"), e nessa hora
ninguém reabre esta análise. Por isso ela está escrita aqui e não na memória de
quem escreveu.

**Se a mesa 14 for ter o jantar de estranhos em cima, isto precisa ser verdade:**

- [ ] **O cliente vê quem pediu o quê.** Não só o total. O dado já existe
      (`PedidoItem.participanteId`); falta a UI. Sem isso a defesa real do sistema
      — o cliente estranhar — não existe, e o `k` fraco deixa de ser aceitável.
- [ ] **O caixa confere item a item antes de cobrar.** Isto é controle
      *operacional*, não software. Não assuma: **fale com a pessoa do caixa.**
      Se ela só olha o total, o item acima não salva ninguém.
- [ ] **Entrada em comanda aberta é aprovada por quem já está na mesa.**
      ("Ana quer entrar. Liberar?") — 1 endpoint + 1 evento de socket. É o único
      oráculo de presença física disponível de graça: os celulares que já estão
      sentados ali. O atacante remoto não passa porque ninguém na mesa o conhece.
      Furo conhecido e aceito: mesa `LIVRE` — o primeiro a escanear vira dono, e
      pode ser o cara de casa. Mitiga sozinho: a primeira pessoa real a sentar
      estranha uma comanda que já existe.
- [ ] **Rotação de mesa comprometida é procedimento, não improviso.**
      `UPDATE mesas SET qr_secret = ... WHERE numero = 14` + reimprimir. Já
      documentado em [`scripts/gerar-qr.ts`](apps/api/scripts/gerar-qr.ts).

Alternativas descartadas, pra não serem redescobertas:

- **Rotacionar o `k` por refeição** — exige reimprimir adesivo a cada mesa que
  vira. É operação, não software.
- **Garçom aprova cada entrada** — mata o ponto do produto (pedir sem chamar
  garçom).
- **Código rotativo num display na mesa** — vira outro produto, com hardware.

## O que falta

- [x] ~~Rodar `npm install` e corrigir o que não compilar~~ — compilou limpo.
      Os 23 erros de tipo do `api` eram um só: faltava `prisma generate`, hoje
      no `postinstall`. O que estava quebrado não era código: faltava o
      `.env.example` e a migration `001_init`.
- [x] ~~Testes de integração (Testcontainers): corrida no `/join`~~ —
      [`test/sessao.join.test.ts`](apps/api/test/sessao.join.test.ts). Precisa de
      Docker; sobe um `postgres:16` descartável. Achou um 500 real no boot.
- [x] ~~duplo `/fechar`~~ — [`test/comanda.fechar.test.ts`](apps/api/test/comanda.fechar.test.ts).
      A claim do `FOR UPDATE` era verdadeira. Mas o teste achou dois bugs ao lado
      dela: comida de graça e o 500 do `seq`.
- [x] ~~Idempotência do POST de pedido~~ —
      [`test/pedido.idempotencia.test.ts`](apps/api/test/pedido.idempotencia.test.ts).
      O mecanismo passou de primeira: 4 requests simultâneos com a mesma chave =
      1 pedido, zero 500. Mas o teste achou o buraco ao lado: a chave não cobria
      o **conteúdo**. Ver [A chave de idempotência](#a-chave-de-idempotência-cobre-o-carrinho-e-o-que-tem-dentro-dele).
- [ ] **Front: tratar o 409 `IDEMPOTENCY_KEY_REUSADA`.** Hoje o servidor está
      certo e a tela não sabe disso — o cliente veria um erro genérico. Precisa
      dizer *"sua picanha já foi registrada; a coca ainda não foi enviada"*,
      recarregar a comanda e deixar só o item novo no carrinho, com chave nova.
- [x] ~~Isolamento de rooms do socket~~ —
      [`test/realtime/rooms.test.ts`](apps/api/test/realtime/rooms.test.ts).
      A regra estava certa e agora está guardada. **Passou de primeira** — e o
      teste foi validado reintroduzindo `socket.on('join', ...)` no io.ts: fica
      vermelho com a conta da mesa vizinha, total incluso, chegando no celular
      errado.
- [x] ~~Front: nenhuma tela abriu.~~ — abriu. O fluxo do cliente foi dirigido com
      Chromium de verdade: escanear → apelido → join → cardápio → carrinho →
      pedido. Funcionou de primeira, sem erro de console. A URL perde o `?k=`
      como prometido. **Mas achou o loop do 409** (acima) — corrigido.
- [x] ~~E2E Playwright versionado~~ — [`e2e/`](e2e/), 20 testes em ~41s.
      Guarda o `travado` do MenuPage (verificado removendo a linha: fica
      vermelho), a limpeza do `?k=` da URL, o F5, o tempo real nos dois painéis
      e o fechamento. Achou o `credencial` que sobrevivia ao fim da sessão.
- [x] ~~Painel da cozinha e do caixa: só o fluxo do cliente foi dirigido.~~ —
      dirigidos. Achou que **ninguém conseguia logar** (`@local` sem TLD) e que o
      total do grid do caixa ficava congelado. O tempo real funciona: pedido
      aparece na cozinha em ~250ms, `EM_PREPARO` volta ao celular em ~250ms.
- [ ] E2E Playwright do fluxo inteiro, com três browsers em paralelo
- [x] ~~CRUD de admin (produtos, categorias, mesas)~~ — produtos e categorias, em
      [`/painel/admin`](apps/web/src/pages/painel/AdminPage.tsx). **Mesas ficaram
      de fora de propósito:** criar mesa é gerar `qr_secret` e imprimir adesivo —
      fluxo físico, não CRUD, e merece decisão própria (o que acontece com o QR
      já colado se a mesa for recriada?). Seguem vindo do seed.

      Sem `DELETE`: `PedidoItem.produto` é `onDelete: Restrict`, e apagar produto
      vendido apagaria o passado. Sair do cardápio é `disponivel:false` /
      `ativa:false` — campos que já existiam.

      Achou três coisas ao rodar:
      - **`categoria.ativa` era filtrada no `/menu` e ignorada no `criarPedido`.**
        Inofensivo enquanto nada setava `ativa:false`; a tela de admin é o que
        tornava o caminho alcançável. Desativar categoria escondia mas não
        impedia — celular com o menu aberto pedia e a cozinha imprimia.
      - **`DESTINO['ADMIN']` apontava para `/painel/caixa`**: o dono logaria e
        nunca veria a tela nova. Mesmo formato do bug do seed.
      - **O seed grava categoria com id explícito e a sequence não avança.** O
        primeiro "Criar categoria" no painel dava 500, e o erro se repetia uma
        vez por categoria semeada antes de "passar sozinho" na quinta. Corrigido
        com `setval` no fim do seed. Só apareceu porque o E2E roda o seed de
        verdade — a integração sobe banco vazio, que não tem com o que colidir.
- [x] ~~Ordenação (`ordem`) na tela de admin~~ — e "a tela não edita" escondia dois
      bugs, achados rodando. `ordem` é `@default(0)` e o seed usa 1..4: **toda
      categoria criada pelo painel nascia acima da Padaria** no celular do
      cliente, e o dono não tinha como corrigir. Pior, o `/menu` era a única das
      quatro consultas **sem desempate** — com as categorias do painel todas
      empatadas em 0, o Postgres devolvia a ordem que quisesse, e um `UPDATE`
      reescreve a tupla no fim do heap: **renomear uma categoria reordenava o
      cardápio do cliente** (`Antes: 15,12,14 | Depois: 14,12,15`). Mesma forma da
      `categoria.ativa`: o default era inofensivo enquanto nada criava categoria
      — o painel é que tornou o caminho alcançável. Corrigido com desempate por
      `id` no `/menu` e o campo `ordem` na tela. O default 0 (item novo nasce no
      topo) ficou, agora com saída e documentado na própria tela.
- [x] ~~`crypto.randomUUID` fora de secure context~~ — **o primeiro celular de
      verdade não conseguiu entrar**, e nenhum dos 128 testes podia ver.
      `randomUUID` só existe em secure context (HTTPS ou `localhost`); num
      celular abrindo `http://192.168.x.x` ele é `undefined`. O `TypeError`
      estourava dentro do `try` do `SessionGate`, **antes do fetch** — o `catch`
      genérico mostrava "Não foi possível entrar. Tente de novo." e o log da API
      ficava vazio. O app acusava a rede de um erro que era dele. A suíte inteira
      sempre rodou em `localhost`, que é secure context **por definição**: o
      verde era estrutural, não sorte. Corrigido com `uuidV4()`
      (`packages/shared/src/uuid.ts`), que cai em `crypto.getRandomValues` — que
      existe nos dois contextos e continua CSPRNG. Vale para o piloto também: um
      mini-PC servindo `http://192.168.x.x` na rede do restaurante tem o mesmo
      problema, só HTTPS devolve o `randomUUID` nativo.

      Contra a recaída: teste em `shared` que **remove** `randomUUID` e prova o
      fallback (o caminho nativo passaria verde sem nunca executá-lo), e
      `E2E_HOST=<ip> npm run test:e2e`, que roda a suíte inteira pela rede. O
      primeiro teste de `e2e/origem-insegura.spec.ts` não testa o app: prova que
      a rodada está mesmo fora de secure context. Sem ele, `E2E_HOST=localhost`
      ficaria verde provando nada.
- [ ] `imagemUrl` na tela de admin: existe no schema e na API, a tela não edita.
- [x] ~~Campo de valor recebido em dinheiro no caixa (hoje assume valor exato)~~ —
      `valorRecebidoCentavos` e o cálculo de troco já existiam no `fecharComanda`;
      o que faltava era a **tela**, e a falta não era inofensiva: a `CaixaPage`
      mandava o total exato como valor recebido, então o troco era `R$ 0,00` em
      todo fechamento em dinheiro desde que o projeto existe — e o `onSuccess`
      descartava o número de qualquer jeito. Agora o operador digita o valor
      (via `parsearBRL`), vê o troco enquanto digita, e o recibo mostra o troco
      **que a API devolveu**, num diálogo que não fecha sozinho. Décimo segundo
      bug do mesmo formato: dois lados corretos, ninguém ligando o fio.
- [ ] `@socket.io/redis-adapter` ao passar de uma instância
