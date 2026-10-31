---
sidebar_position: 999
tags: [architecture, decision, adr, cqrs, event-sourcing, kafka, redpanda, postgres]
---

# Decisão de Arquitetura — Backbone de eventos, event store e contrato do evento de domínio

> **Status: decidido, NÃO implementado.** Fase 6 do roadmap (issue #26). Implementação nas
> issues #27 (broker + infra de event store), #28 (`catalog`), #29 (lado wallet de `reservation`)
> e #30 (checkpoint); a Rodada 2 (#31) mede o resultado. Resolve as questões em aberto "Kafka vs.
> Redpanda", "event store", "formato do evento" e "admissão: RabbitMQ vs. tópico" do
> [Architecture-Decision-Microservices-Split](Architecture-Decision-Microservices-Split.md).

## Contexto

A Fase 5 deixou o monólito em módulos (`identity`, `catalog`, `reservation`, `notification`,
`shared`, `gateway`), mesmo processo e schema `public`. A Fase 6 converte `catalog` e o lado
wallet/order de `reservation` para CQRS + Event Sourcing **ainda dentro do monólito**; `eventcap`
fica relacional com o `UPDATE` condicional (CAS) — a tese do TCC
([Backend-Architecture](Backend-Architecture.md), [Architecture-Decision-Stock-Isolation](Architecture-Decision-Stock-Isolation.md)).

A Rodada 2 (#31) re-executa o braço de controle lendo a **projeção ES real**, com **lag de consumer
de verdade** em vez do timer sintético da Fase 2. A escolha do event store decide o que ela mede.

Restrições que vêm do código atual:

- Reserva = uma transação JDBC manual (`setAutoCommit(false)`): claim da `Idempotency-Key` → CAS em
  `eventcap` → `walletevent`. O evento `SlotReserved` precisa entrar **nessa** transação.
- A decisão de estado da reserva é o `UPDATE` condicional em `walletevent` (`reservePending`,
  `confirm`, `cancelIfActive`, `expireIfStale`, rowcount = 1); é ele que impede devolver a vaga duas
  vezes.
- Contrato `/bff/**` inalterado (`HttpContractTest`): vários testes escrevem e leem em seguida.
- O backend fala com o Postgres pelo Supavisor em transaction mode: nada de estado de sessão.
- FKs atuais para `event`: `eventcap` e `event_availability` com `ON DELETE CASCADE`, `walletevent`
  com `RESTRICT`.

## Decisão

### 1. Broker: **Redpanda**

Redpanda (binário único, API Kafka, sem JVM), um nó no compose, imagem com tag fixa escolhida na #27.
Cliente: `spring-kafka`. Trocar por Apache Kafka (KRaft) depois é troca de imagem, sem mudar código.

**Por quê:** a máquina host já roda Supabase (db, pooler, Studio, meta, kong), backend e frontend
durante a carga; um broker JVM disputaria memória/CPU com o que está sendo medido.

### 2. Event store: **tabela de streams no Postgres + outbox → Redpanda**

**Fonte de verdade = `event_store` no Postgres, imutável** (nenhuma linha é atualizada depois do
append). Colunas do envelope (seção 3) + `UNIQUE (stream_type, stream_id, version)`.

**Append e concorrência otimista.** Mesmo padrão do `claim`/`tryReserve`:
`INSERT ... ON CONFLICT DO NOTHING` + rowcount. A versão esperada vem do estado lido **na mesma
transação** (coluna `version` da projeção inline do agregado). Rowcount 0 = outra transação gravou
essa versão antes:
- na reserva → rollback e a mesma resposta da corrida atual ("Vínculo já existente");
- em comandos de `catalog` → rollback e o command é repetido numa transação nova (o
  `unique_violation` não é usado como controle de fluxo porque aborta a transação inteira, CAS e
  claim inclusive).

Por stream, as versões **comitam em ordem**: a versão n+1 só pode ser calculada depois que a n
comitou, porque a versão esperada é lida do estado comitado. Na reserva, a versão sai da **própria
guarda**: `UPDATE walletevent ... SET version = version + 1 ... RETURNING version` em
`reservePending`/`confirm`/`cancelIfActive`/`expireIfStale`, sem `SELECT` separado. Isso evita que uma
reserva concorrente com a expiração do mesmo par leia uma versão velha, e economiza uma ida ao banco.

**Outbox = tabela `event_outbox`** (só `global_position` do evento), inserida na mesma transação do
append e **apagada** depois de publicar. Mantém o `event_store` imutável e sem `UPDATE` não-HOT na
tabela mais quente. Custo por reserva: +1 `INSERT` em `event_store`, +1 `INSERT` em `event_outbox` na
transação do request, +1 `DELETE` assíncrono no relay. O `INSERT`+`DELETE` contínuo gera tuplas mortas; a #27
configura autovacuum mais agressivo na `event_outbox` (`autovacuum_vacuum_scale_factor` baixo). Entra na seção de latência do
`Backend/CLAUDE.md` e na leitura da #31.

**Relay outbox → Redpanda.** `@Scheduled` com intervalo curto (default **50 ms**), drena até esvaziar.
Uma transação por lote:
1. `pg_try_advisory_xact_lock(<constante>)` — um relay por vez, inclusive com vários contextos Spring
   ou réplicas (lock de **transação**, compatível com o Supavisor em transaction mode); quem não
   pega o lock sai;
2. lê o lote `event_outbox ⋈ event_store ORDER BY global_position LIMIT n` (**sem** `SKIP LOCKED`:
   pular linhas quebraria a ordem por stream);
3. envia ao Redpanda e espera o ack (producer idempotente, `acks=all`, `max.block.ms`/
   `delivery.timeout.ms` curtos para não segurar a conexão do pooler com o broker fora);
4. apaga o lote do `event_outbox` e comita. Falha no envio → rollback, o lote volta no próximo tick.

Publicação **at-least-once** (rollback depois de enviar = reenvio). `LISTEN/NOTIFY` foi descartado
porque exigiria uma conexão de sessão dedicada, fora do pooler, só para isso.

**`global_position` não é cursor.** É alocado na ordem do `INSERT`, não na do commit: com escrita
concorrente, uma posição menor pode comitar depois de uma maior. Ninguém lê o `event_store` "a partir
da posição X" para acompanhar novidades; o acompanhamento é pelo broker e o replay é completo.

**Projeções em duas classes:**

- **inline** — mesma transação do append: as tabelas que o contrato HTTP lê logo depois de escrever
  (`event`, `eventpresenter`, `walletevent`/"minhas reservas"). Read-your-writes; `HttpContractTest`
  sem mudança de expectativa. Em `walletevent`, o `UPDATE` condicional **continua sendo a guarda**: o
  append só acontece quando ele afeta 1 linha, na mesma transação.
- **assíncronas** — consumer do Redpanda: o read model de disponibilidade que o braço
  `reservation.readpath=naive` lê. Consome **só** o tópico `reservation.wallet` e guarda **só o nº de
  reservas ativas por evento** (+ `applied_at` e o `occurredAt` do último evento aplicado). A
  disponibilidade é calculada **na leitura**: `eventcap LEFT JOIN projeção`, com
  `CASE WHEN capacity = -1 THEN -1 ELSE GREATEST(capacity - COALESCE(ativos, 0), 0) END`. Assim um
  evento sem nenhuma reserva já tem disponibilidade, e a mudança de capacidade por `updatePolicy`
  (que faz `UPDATE eventcap SET capacity`) vale na hora; a defasagem fica só em `ativos`, que é o que
  o experimento mede. Nunca lê `quant`, para não virar o CAS. O refresh por timer da Fase 2
  (`ReadModelRefreshService`, `READMODEL_AVAILABILITY_REFRESH_MS`) **sai**: os dados da Rodada 1 já
  estão medidos.

**Consumer idempotente, por stream.** Uma tabela de checkpoint guarda a última `version` aplicada de
cada stream por projeção, e o avanço é atômico, no padrão CAS/rowcount do projeto:
`UPDATE ... SET version = :v WHERE projecao = ? AND stream_id = ? AND version = :v - 1` (para a v1,
`INSERT ... ON CONFLICT DO NOTHING`). A projeção só é aplicada se o rowcount for 1. Com isso, dois
aplicadores concorrentes (rebalance, ou vários contextos de teste) nunca contam o mesmo evento duas
vezes. Para cada mensagem, **antes** do avanço, confere-se que o `eventId` é o que está no
`event_store` em `(stream_type, stream_id, version)`. É uma leitura pelo `UNIQUE` que já existe. Se
o evento não existe ou é outro, a mensagem é descartada; isso elimina, por exemplo, a sobra de um
teste anterior depois do `TRUNCATE ... RESTART IDENTITY`. Depois:
- avanço com rowcount 1 → aplica;
- `version ≤ última` → descarta (reenvio);
- `version > última + 1` → buraco: aplica em ordem as versões que faltam daquele stream **que
  existem no `event_store`** (já comitadas, pela ordem acima). Pela ordem por stream, a mensagem da v n+2 só existe
  depois que a n+1 comitou, então isso não deve faltar. Se ainda assim faltar, o consumer **não
  avança** o checkpoint nem o offset e lança erro para o retry com backoff do `spring-kafka`.
  Esgotado o retry, a mensagem vai para um dead-letter topic e o caso é logado.

**Catch-up** (o "poller ou `pg_cron`" do aceite da #27) = esse consumer: o que ficou para trás vem do broker, e o buraco é preenchido relendo o `event_store`. Para começar do zero, há o replay abaixo. Não há poller nem `pg_cron` à parte.

Checkpoint + projeção na **mesma transação de banco**; o offset só é comitado depois desse commit
(ack manual no `spring-kafka`).

**Replay** = reconstruir a projeção a partir do `event_store` (todos os eventos do tipo, em ordem de
`version` por stream) em **tabelas-sombra** e comparar com a projeção viva. As tabelas-sombra ficam
num schema de replay criado e derrubado pelo próprio replay. Não são `TEMP TABLE` (o
`Backend/CLAUDE.md` proíbe por causa do Supavisor) e ficam fora do `SchemaValidationTest` e do
`GlobalDbTruncator`. Não se reconstrói tabela viva no lugar: as FKs para `event` (`RESTRICT` em
`walletevent`, `CASCADE` em `eventcap`) impedem, e o cascade apagaria o estado do CAS, que não vem do
log. Eventos carregam os valores calculados no command (ex.: `expiresAt`), então o replay não chama
`now()` e é determinístico.

**Snapshots** — tabela `event_snapshot (stream_type, stream_id, version, state jsonb)`, política "a
cada N eventos do stream" com N alto por default (ex.: 100). É **cache descartável**: mudou o formato
do estado → apaga e reconstrói. Não usado nos streams de reserva (2–4 eventos). Teste: snapshot +
cauda == replay completo.

**Isto contraria a inclinação da ADR de microsserviços** ("Kafka como log de verdade casa melhor com o
argumento de throughput/elasticidade"). Decidido assim (confirmado pelo usuário em 2026-10-18) porque:

1. **Atomicidade com o CAS.** CAS + `walletevent` + `SlotReserved` + outbox são uma transação. Com o
   Kafka como verdade, seria dual write e precisaria de saga para "vaga tomada mas evento não
   publicado" — a classe de bug que o TCC isola.
2. **Concorrência otimista por agregado.** O Kafka não faz "grave a versão 7 só se a última é 6" por
   stream; a tabela faz com uma constraint.
3. **O argumento de throughput continua:** fanout e projeções assíncronas passam pelo broker, e a
   Rodada 2 mede o caminho append → relay → tópico → consumer → projeção.
4. **Replay determinístico** a partir do Postgres, sem depender de retenção de tópico.

### 3. Contrato do evento de domínio

Envelope JSON, igual nas colunas do `event_store` e na mensagem do tópico:

| Campo | Tipo | Nota |
|---|---|---|
| `eventId` | UUID | identidade do evento |
| `streamType` | texto | `catalog.event`, `reservation.wallet` |
| `streamId` | texto | id do agregado (id do evento; `userId:eventId` da reserva) |
| `version` | int | versão no stream, começa em 1; base da idempotência do consumer |
| `globalPosition` | bigint | identidade/ordem de alocação no `event_store` (não é ordem de commit) |
| `eventType` | texto | `EventCreated`, `SlotReserved`, ... |
| `schemaVersion` | int | versão do formato do `payload` daquele `eventType` |
| `occurredAt` | timestamptz (ISO-8601) | instante do append; início da medição de lag |
| `payload` | objeto JSON | dados do evento, com os valores já calculados |
| `metadata` | objeto JSON | `correlationId`, `idempotencyKey` quando houver |

- **Sem Avro e sem schema registry**: mais um serviço no compose, sem ganho no monólito. JSON é lido
  no Studio e no `psql`.
- **Versionamento (política):** mudança compatível (campo opcional novo) não muda `schemaVersion`;
  mudança incompatível incrementa e o leitor ganha um *upcaster*. Nada a construir até a primeira
  mudança incompatível. Evento gravado nunca é reescrito.
- **Tópicos:** um por `streamType` (`catalog.event`, `reservation.wallet`). **Chave = `event_id` do
  domínio** (o id do evento do catálogo, coluna `event.event_id`; **não** o `eventId` do envelope, que é
  único por mensagem): as reservas de um mesmo evento caem na mesma partição, em ordem **dentro do tópico**
  (não há ordem entre tópicos — por isso a disponibilidade não depende de `catalog.event`). Efeito
  para a #31: o evento quente fica numa partição e num consumer; o lag dele é limitado a um consumer,
  e mais partições não ajudam.
- O relay acrescenta o header `publishedAt` à mensagem.
- **Sem dado pessoal no `payload`:** o `event_store` é imutável e não dá para apagar o que entra nele.
  Eventos levam ids (`userId`, `event_id`) e dados do domínio do evento, nunca e-mail, telefone,
  senha ou documento. Por isso `identity` não é event-sourced (ver a ADR de microsserviços).

### 4. Medição de lag (para a Rodada 2)

Pontos: `occurredAt` (append) → `publishedAt` (header do relay) → `applied_at` (commit do consumer).
A linha da projeção de disponibilidade guarda `applied_at` e o `occurredAt` do último evento
aplicado. `occurredAt` e `applied_at` são gravados com `clock_timestamp()`, não `now()`. O `now()` é
o início da transação e, no braço `cas`, incluiria a espera pelo lock da linha quente de `eventcap`.
Como o append é o último comando antes do commit, ali `clock_timestamp()` ≈ commit. Métricas:

- **lag por evento** = `applied_at − occurredAt`, separável em relay (`publishedAt − occurredAt`) e
  consumer (`applied_at − publishedAt`), registrado pelo consumer (log/histograma);
- **offset lag** do consumer group (`rpk group describe`) durante a carga.

O antigo `now() − refreshed_at` deixa de servir (sob carga contínua ficaria perto de 0 com eventos
atrasados). Na #31 o lag passa de **variável controlada** (`lag_ms` da matriz) a **variável medida**;
a variável independente é a carga (N concorrentes / RPM).

### 5. Papéis fixados

| Peça | Papel | Quando |
|---|---|---|
| Redpanda (API Kafka) | log/fanout de eventos de domínio; alimenta projeções assíncronas | Fase 6 |
| Postgres `event_store` + `event_outbox` | fonte de verdade dos streams; outbox; replay | Fase 6 |
| RabbitMQ | fila de admissão (ack/nack, TTL, dead-letter) — [Architecture-Decision-Async-Checkout-Queue](Architecture-Decision-Async-Checkout-Queue.md) | Fase 9 |
| Redis | sinal de carga (RPM por evento) | Fase 9 |

Esta ADR fecha a questão "admissão: RabbitMQ vs. tópico Kafka" a favor do RabbitMQ (TTL de mensagem
e dead-letter nativos); o Kafka fica só com eventos de domínio.

## Impacto — o que muda na implementação

- **#27:** serviço `redpanda` no compose (rede `gerenciador-net`); init-script com `event_store`,
  `event_outbox`, `event_snapshot` + migração idempotente; em `shared`: append/read por stream com
  concorrência otimista, relay, base de consumer idempotente (regra de versão acima) e replay em
  tabela-sombra; teste de replay. Tudo em `public` agora; vira uma por schema de serviço na extração
  (Fase 7). `run-tests.sh` passa a exigir `db` **e** `redpanda` no ar.
- **#28:** `catalog` grava `EventCreated`, `EventUpdated`, `PresenterAdded`, `PresenterRemoved`,
  `EventCancelled` e projeta `event`/`eventpresenter` inline (com coluna `version`).
- **#29:** reserva appenda `SlotReserved` na transação do CAS; confirm/expire/cancel emitem
  `ReservationConfirmed`/`ReservationExpired`/`ReservationCancelled` só quando o `UPDATE`
  condicional afeta 1 linha; `walletevent` vira projeção inline; a disponibilidade do braço `naive`
  vira projeção assíncrona com as métricas da seção 4; o `ReadModelRefreshService` sai. Pela regra dos
  3 lados:
  - o schema de `event_availability` muda: sai `refreshed_at`, entram `ativos`, `applied_at` e
    `occurredAt` do último evento. Atualizar `db/CLAUDE.md`, `SchemaValidationTest` e a amostra de lag
    do harness de carga (`Get-AmostraLag` em `Projeto/carga/rodar-matriz.ps1`);
  - `READMODEL_AVAILABILITY_REFRESH_MS` sai do `Backend/CLAUDE.md` e do compose.
- **#30:** checkpoint ponta a ponta e diagrama command → evento → projeção em `docs/`.
- **Testes:**
  - relay e consumer ligados por flag (`events.relay.enabled`, `events.consumer.enabled`) só nos
    contextos que precisam;
  - um único `group.id`: o checkpoint atômico torna seguro um rebalance entre contextos em cache, que
    só custa latência;
  - helper "drenar e aguardar" com timeout no lugar das chamadas diretas a `refresh()`. Ele espera
    primeiro a atribuição de partição (com `auto.offset.reset=latest`, um evento appendado antes
    disso seria pulado);
  - as mensagens que sobram de testes anteriores morrem na conferência do `eventId` contra o
    `event_store`, feita em toda mensagem.
- **Pooler:** a auditoria de estado de sessão no `Backend/CLAUDE.md` ("nenhum advisory lock") passa a
  registrar que o `pg_try_advisory_xact_lock` do relay é permitido, porque é de transação e não de
  sessão.
- Config nova (env var com default de dev): endereço do broker, intervalo e lote do relay, N do
  snapshot, as duas flags. Nada de segredo novo.
- Fica igual: JDBC puro (sem JPA), schema em init-scripts, Tomcat 300 / Hikari 1000 / pool 245,
  virtual threads OFF, contrato `/bff/**`.

## Alternativas descartadas

- **Kafka/Redpanda como log de verdade:** dual write com o CAS, sem concorrência otimista por
  agregado, replay dependente de retenção.
- **`published_at` no próprio `event_store`:** muta a tabela imutável e faz `UPDATE` não-HOT por
  evento na tabela mais quente.
- **Relays concorrentes com `FOR UPDATE SKIP LOCKED`:** um relay pode publicar a v2 de um stream
  enquanto outro ainda segura a v1, e um consumer que descarta "versão ≤ última" perderia a v1.
- **Cursor incremental por `global_position`:** perde eventos que comitam fora da ordem de alocação.
- **Apache Kafka em vez de Redpanda:** mesma API, mais pesado para a máquina de carga.
- **Event store dedicado (EventStoreDB etc.):** mais um banco, e o CAS continuaria no Postgres.
- **Avro + schema registry:** mais infra; o ganho não existe no TCC.

## Relacionado

- [Architecture-Decision-Microservices-Split](Architecture-Decision-Microservices-Split.md) — escopo do ES, ordem "converter antes de extrair".
- [Backend-Architecture](Backend-Architecture.md) — capacidade isolada (CAS) + resto event-sourced.
- [Architecture-Decision-Async-Checkout-Queue](Architecture-Decision-Async-Checkout-Queue.md) — RabbitMQ/Redis da Fase 9.
- [Database-Schema](Database-Schema.md) — impacto de CQRS/ES no schema (schema por serviço na extração).


---

*Sincronizado automaticamente de `Architecture-Decision-Event-Backbone-Event-Store.md` em 2026-10-30T19:11:52.864Z.*
