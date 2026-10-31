# CLAUDE.md — Banco de dados (PostgreSQL)

PostgreSQL 17 (imagem `supabase/postgres`), rodando em container. É a **fonte de verdade do schema** —
não há migração via ORM. Leia também o CLAUDE.md da raiz e o de `Backend/`.

## Container

- Definido em `Projeto/docker-compose.yml` (serviço `db`), imagem `supabase/postgres:17.6.1.136`
  (a mesma do upstream fixado em `Projeto/supabase/README.md`). O antigo `db/Dockerfile`
  (`postgres:16-alpine`, pt_BR) foi removido na issue #18 e fica como fallback no histórico do git.
- **Pré-requisito:** `Projeto/supabase/.env` precisa existir antes do `up` (o `db` lê os segredos
  do Supabase de lá; ver `Projeto/supabase/README.md`).
- Host: `localhost:5433` → dentro da rede Docker: `db:5432`. Container: `gerenciador-db`.
- O usuário do app, a senha e o nome do banco vêm de `Projeto/.env` (`POSTGRES_USER`,
  `POSTGRES_PASSWORD`, `POSTGRES_DB=meu_banco`). Não commitar/imprimir. No container eles entram
  como `APP_DB_USER`/`APP_DB_PASSWORD`/`POSTGRES_DB`: o `POSTGRES_USER` do container fica o
  default da imagem (`supabase_admin`) — definir outro (ex. `admin`) quebra o init por peer auth.
  Por isso o `db` usa `env_file: ./supabase/.env` (segredos das roles internas do Supabase) e não
  mais `./.env`.
- **Banco `meu_banco`, não `postgres`** (decisão da issue #18): `POSTGRES_DB=meu_banco` faz a
  imagem criar o banco já com esse nome e rodar o init do Supabase nele (schemas `auth`,
  `storage`, `extensions`, `pgbouncer`). Assim o backend, o `run-tests.sh` e o gerador de carga
  (`PGDATABASE=meu_banco`) não mudam, e o tenant do Supavisor (#19) aponta para um banco só, que
  já tem o `pgbouncer.get_auth` e as tabelas do app (tenant criado em `supabase/volumes/pooler/pooler-upsert.exs`, #19).
- Role do app: `admin` (de `APP_DB_USER`) é criada por `supabase-app-init.sql` como
  `LOGIN` **sem superuser** (menor privilégio) e vira **dona do banco** `meu_banco` — no PG15+
  o schema `public` pertence ao dono do banco, então isso lhe dá `CREATE` no `public` e no banco
  (o `TestSchemasTest` cria um schema temporário). É dona das tabelas (os testes dão `TRUNCATE`
  como dona). Tarefa que exija superuser: `docker exec gerenciador-db psql -U supabase_admin`
  (trust no socket). Os init-scripts têm `OWNER TO admin` fixo, então `POSTGRES_USER` do
  `Projeto/.env` precisa continuar `admin`.
- Locale/encoding: UTF-8, locale `en_US.UTF-8` (ICU) da imagem — antes era pt_BR. Postgres 17.6
  (antes 16).
- Volumes: `supabase-db-data` (PGDATA; novo — o `db-data` antigo é PG16 e não sobe no PG17, fica
  órfão, não apagar) e `db-config` (`/etc/postgresql-custom`, guarda a chave do pgsodium).
- Acesso: no socket do container só `supabase_admin` entra (trust); `admin` por socket falha
  (peer). Use `-h localhost` (127.0.0.1 é trust) ou TCP de fora com senha. O healthcheck usa
  `pg_isready -U postgres -h localhost`.

## Inspeção visual (Supabase Studio)

Com a stack no ar, o Studio fica em `http://localhost:8000` (via Kong; login com `DASHBOARD_USERNAME` e
`DASHBOARD_PASSWORD` de `Projeto/supabase/.env`). Table Editor → schemas `identity` (`users`, `mywallet`...; #36), `catalog` (`event`, `eventpresenter`; #35) e `reservation` (`eventcap`,
`walletevent`...) mostram as tabelas do app; o SQL Editor roda consultas em `meu_banco`. Studio e `meta` conectam como
`supabase_admin`, não como `admin`: é leitura/edição manual de apoio, o backend continua usando só JDBC.
Detalhes e limites (sem GoTrue/PostgREST/Realtime/Storage/functions) em `Projeto/supabase/README.md`.

## Como os init-scripts rodam (imagem `supabase/postgres`)

O `migrate.sh` da imagem roda `init-scripts/*.sql` como `postgres` e depois `migrations/*.sql`
como `supabase_admin` (um `psql` por arquivo, ordem lexical, no `POSTGRES_DB`). No compose:

- `Backend/db/supabase-app-init.sql` → `/docker-entrypoint-initdb.d/migrations/99-app.sql`. O
  prefixo `99` roda depois de todas as migrations do Supabase. Ele cria a role do app, faz
  `SET ROLE` para ela (tabelas nascem com dono `admin`) e inclui com `\i` os scripts abaixo,
  montados read-only em `/app-init` (fora de `/docker-entrypoint-initdb.d`, para a imagem não
  rodá-los sozinhos com o dono errado). **Script novo em `init-scripts/` precisa de um `\i` lá.**
- `supabase/volumes/db/roles.sql` → `init-scripts/99-roles.sql` (senhas das roles internas) e
  `supabase/volumes/db/functions-role.sql` → `init-scripts/98-functions-role.sql` (cria a role
  `supabase_functions_admin` que o `roles.sql` altera; ver `supabase/README.md`).
- `supabase/volumes/db/_supabase.sql` → `migrations/97-_supabase.sql` e
  `supabase/volumes/db/pooler.sql` → `migrations/99-pooler.sql` (issue #19): criam o banco
  **`_supabase`** (dono `supabase_admin`) e o schema **`_supavisor`** dentro dele. É o estado interno do
  Supavisor (tenants, métricas, `schema_migrations` do Ecto), **não** o schema do app: o app só usa o
  `meu_banco`. O `99-pooler.sql` ordena depois do `99-app.sql` (lexical) e termina com `\c postgres`;
  não depende dele. O Supavisor conecta no `_supabase` como `supabase_admin` e, no `meu_banco`, como o
  usuário do cliente (`admin`, via `pgbouncer.get_auth`, role `pgbouncer` do init do Supabase).
  O `db` **não** é mais o endpoint do backend em Docker: o backend usa `supabase-pooler:6543` (ver
  `Backend/CLAUDE.md`, "Pooler"); `5433` do host e os testes seguem direto no `db`.

## Scripts de init — `db/init-scripts/` (ordem por prefixo numérico)

(O antigo `00-create-db.sql` foi removido na issue #18: o banco já nasce `meu_banco`. Está no histórico do git.)

| Arquivo | Conteúdo |
|---|---|
| `11-event-store.sql` | `event_store`, `event_outbox`, `event_snapshot`, `projection_checkpoint` em `public` — infra de event sourcing da Fase 6 (#27), sem FK (desde a #36 só a infra da lib `shared`: cada serviço tem o seu conjunto) |
| `13-reservation.sql` | schema **`reservation`** (dono `admin`; #33, Fase 7) — `eventcap` (`capacity = -1 OR >= 1`, CHECK `0<=quant<=capacity`, `buy_time_limit` `timestamptz`), `walletevent` (PK composta, `status`, `expires_at` `timestamptz`, índice `idx_walletevent_event_id`, `version` do stream `reservation.wallet`), `event_availability` (projeção assíncrona, `ativos` por evento, lida pelo braço `naive`), `idempotency_key` e o event store do serviço (`event_store`, `event_outbox`, `event_snapshot`, `projection_checkpoint`). **Sem nenhuma FK.** Substituiu os antigos `04-eventcap`, `07-walletevent`, `09-event-availability` e `10-idempotency-key` (no histórico do git) |
| `16-stock.sql` | schema **`stock`** (dono `admin`; #47) — `eventcap` (saiu do `13-reservation.sql`, mesmos CHECKs: `capacity = -1 OR >= 1`, `0 <= quant <= capacity`, `buy_time_limit` `timestamptz`) e `hold` (`hold_id uuid` PK, `event_id`, `user_id`, `decremented`, `status` `held`/`released`, índice `(event_id, status)`): o ledger da saga. Sem event store (o `stock` só consome) e sem FK para o schema `reservation`. Entra na lista explícita do `supabase-app-init.sql` (`\i /app-init/16-stock.sql`). Banco existente: migração `20261029-stock-schema.sql` |
| `12-notification.sql` | schema **`notification`** (dono `admin`) + `notification.processed_event` — checkpoint de idempotência do serviço `notification` (#32, Fase 7) |
| `14-catalog.sql` | schema **`catalog`** (dono `admin`; #35) — `event` (só metadados + `version`, projeção inline do stream `catalog.event`; `creator_id` integer **sem FK**, índice `idx_event_creator_id`), `eventpresenter` (`eventpresenter_event_id_fkey` → `catalog.event` `ON DELETE CASCADE`, a única FK) e o event store do serviço. Substituiu o `03-event.sql` e o `05-eventpresenter.sql` (no histórico do git; saíram no cutover, fatia 3). Idempotente (só `IF NOT EXISTS`), mas é para banco NOVO: banco existente usa a migração `20261026-catalog-schema.sql` (move de `public`; ver `Backend/CLAUDE.md`, "Serviço catalog"), verificada por `migrations/verify-20261026-migration.sh` |
| `15-identity.sql` | schema **`identity`** (dono `admin`; #36) — `users`, `mywallet` (`mywallet_user_id_fkey` → `identity.users` `ON DELETE CASCADE`, a única FK), `pending_verifications`, as funções/triggers com `identity.` fixo (`create_wallet_for_user`, `cleanup_expired_verifications`, `trigger_cleanup_on_insert`) e o event store do serviço (`event_store`, `event_outbox`, `event_snapshot`, `projection_checkpoint`). Substituiu o `01-functions`, `02-users`, `06-mywallet` e `08-pending-verifications` (no histórico do git; saíram no cutover). Idempotente (só `IF NOT EXISTS`/`CREATE OR REPLACE`), mas é para banco NOVO: banco existente usa a migração `20261028-identity-schema.sql` (move de `public`: users/mywallet/pending_verifications com ids e identity preservados, recria funções/triggers, move os streams `identity.notification` com a `global_position`; aborta se qualquer das 7 tabelas `identity.*` tiver linha ou houver FK de fora), verificada por `migrations/verify-20261028-migration.sh`; o `run-tests.sh` NÃO o aplica (só confere o estado). Nada de FK cross-schema |
| `99-tests.sql` | suíte de sanidade em `DO $$ ... $$` (trigger, CAS, CHECK, N:N, cascata de `eventpresenter`, projeção de disponibilidade, `walletevent.version`, event store/outbox/checkpoint, TRUNCATE; as tabelas de reserva em `reservation.*` e as de evento em `catalog.*`, #35) |

`db/migrations/` guarda scripts de migração idempotentes para bancos já existentes
(ex.: `20260901-eventcap-isolation.sql`), aplicáveis a quente via `psql` sem recriar o volume.
Nessa migração, a semântica de `quant` **inverte**: no modelo antigo `event.quant` = ingressos
vendidos, no novo `eventcap.quant` = vagas disponíveis, então a etapa 2 converte
`quant = GREATEST(capacity - vendidos, 0)` (e `capacity IS NULL` do modelo antigo vira o
sentinela `-1/-1` de evento ilimitado). Coberto, ponta a ponta, pelo harness `migrations/verify-20260901-migration.sh` (o
`EventCapMigrationTest` saiu na #35: o estado-alvo dele, `public.event` com as colunas antigas, não existe mais em banco nenhum).

`migrations/verify-20260901-migration.sh` (harness da issue #6, cross-platform como
`run-tests.sh`): cria um banco **descartável** `eventcap_mig_check` no container, aplica os
fixture legado (`legacy-fixtures/public-identity-pre-20261028.sql`: users/mywallet/pending_verifications em `public`, o que o `01/02/06/08` criavam) e os init-scripts do schema novo (`11`, `13`, `14`, `15`), roda `99-tests.sql`, depois roda o harness SQL
`verify-20260901-migration.sql` — que reconstrói o schema ANTIGO **com dados** (desde a #33 inclui recriar a `public.walletevent` legada
e apagá-la no fim, e afastar o nome da constraint de `reservation.walletevent`; desde a #35, recriar a `public.event` legada), aplica a
migração **2×** (idempotência) e checa colunas removidas/criadas, constraints, índice parcial,
conversão de `quant` (limitado / esgotado-piso-0 / ilimitado) e **preservação dos dados**
(contagem + identidade das linhas). Não toca em `meu_banco`. Exit `!= 0` se algo falhar.

**Migração `20261027-reservation-timestamptz.sql` (issue #58)**, para banco existente, **com o backend e o reservation parados** e depois do backup
`pg_dump -h localhost -U admin --clean --if-exists -n reservation meu_banco` (backup, aplicação e rollback no cabeçalho): `eventcap.buy_time_limit` e
`walletevent.expires_at` viram `timestamptz` (`USING ... AT TIME ZONE 'UTC'` explícito: o Postgres e as JVMs do projeto rodam em UTC; um `mvn
spring-boot:run` no host Windows grava em UTC-3 e exigiria trocar o fuso na migração), cria `idx_walletevent_event_id` e troca `eventcap_capacity_valid` para
`capacity = -1 OR capacity >= 1` (aborta com a contagem se houver linha com `capacity = 0`). Idempotente (o 2º run só emite NOTICEs); roda como `supabase_admin`.
O código Java não mudou (`LocalDateTime` ↔ `Timestamp` na JVM em UTC já roda contra `timestamptz`, como em `idempotency_key.expires_at`).
`migrations/verify-20261027-migration.sh` (+ `verify-20261027-migration.sql`; harness da issue #59, cross-platform como os outros): cria bancos **descartáveis**
`meu_banco_mig27` e `meu_banco_mig27_init` no container (não toca em `meu_banco`), monta o schema `reservation` ANTERIOR (`timestamp`, CHECK `capacity >= -1`, sem o índice)
**com linhas** (horários conhecidos, `NULL`, microssegundos e um horário que não existe em `America/New_York`) e prova: (1) com `capacity = 0` a migração aborta
com a contagem e nada muda; (2) a 1ª aplicação, em sessão **não-UTC** (`America/Sao_Paulo`), dá `novo = antigo AT TIME ZONE 'UTC'` linha a linha, com tipos, CHECK (definição e
regra), índice e dono `admin`; (3) a 2ª aplicação (sessão `America/New_York`) só emite NOTICEs e não muda valor; (4) o estado migrado tem a mesma forma (colunas, constraints, índices,
donos) de um banco novo montado pelo `13-reservation.sql`; (5) o rollback do cabeçalho da migração (extraído do próprio arquivo) devolve tipos, CHECK, índice e os valores originais.
Exit `!= 0` se algo falhar.

**Migração `20261029-stock-schema.sql` (issue #47)**, para banco existente, **com o backend, o reservation, o catalog e o stock parados** e **depois do backup `pg_dump -h localhost -U admin --clean --if-exists -n reservation meu_banco`** (backup, aplicação e rollback no cabeçalho do arquivo; pré-requisito: `20261027` aplicada, porque `buy_time_limit` tem de ser `timestamptz`): cria o schema `stock`, move `reservation.eventcap` para ele (`ALTER TABLE ... SET SCHEMA`; aborta se as duas existirem), cria `stock.hold`, acrescenta `hold_id` a `walletevent` e `hold_id`/`saga_status`/`updated_at`/`resolved_at`/`resolved_by` a `idempotency_key` (as linhas existentes ficam `reserved`), deixa `idempotency_key.expires_at` aceitar nulo, cria o índice parcial do reaper e faz o **backfill dos holds**: para cada `walletevent` `pending`/`confirmed` sem `hold_id`, um `stock.hold` `held`, e por evento limitado **exatamente `capacity − quant`** deles (os mais antigos) com `decremented = true` (reservas antigas do braço naive não se distinguem das do cas; marcar todas devolveria vagas nunca tiradas); ilimitado: todos `false`. ABORTA, sem alterar nada, se `capacity − quant` passar das ativas de algum evento (dado já inconsistente; lista os eventos). `lock_timeout` de 5 s, transação única, idempotente (a 2ª aplicação só emite NOTICEs). Rollback (com tudo parado e as sagas em voo resolvidas): `ALTER TABLE stock.eventcap SET SCHEMA reservation`, `DROP TABLE stock.hold`, `DROP` das colunas novas e `DROP SCHEMA stock` — o `quant` não precisa de ajuste. `migrations/verify-20261029-migration.sh` (+ `.sql`; bancos descartáveis `meu_banco_mig47*`, não toca em `meu_banco`; o schema de antes vem de `git show 35955ef:...`) prova: o cenário S9 (capacidade 10 com 7 cas + 3 naive → `capacity − quant` holds debitados e a invariante), as guardas, a 2ª aplicação, migrado == banco novo (`13-reservation.sql` + `16-stock.sql`) e o rollback do cabeçalho == o schema anterior com os dados. O `run-tests.sh` NÃO a aplica: só confere o estado (e `TEST_DB_NAME` aponta para um banco criado com os init scripts atuais).

**Migração `20261028-identity-schema.sql` (issue #36)**, para banco existente, **com o backend e o identity parados** (reservation, catalog e notification podem ficar de pé) e **depois do backup
`pg_dump -h localhost -U admin --clean --if-exists -n public meu_banco`** (backup, aplicação e rollback no cabeçalho do arquivo; pré-requisito: `20261025` e `20261026` já aplicadas, senão há FK de `walletevent`/`event`
para `users` e a migração ABORTA sem alterar nada): cria o schema `identity` e move para ele `users`, `mywallet` e `pending_verifications` (`ALTER TABLE ... SET SCHEMA`: dados, índices, constraints e a identity de
`user_id`/`id` vão juntos, **sem `setval`**: `max+1` reciclaria ids apagados e o usuário novo herdaria eventos e reservas antigos), recria as 3 funções (`create_wallet_for_user`,
`cleanup_expired_verifications`, `trigger_cleanup_on_insert`) com `identity.` fixo e reaponta os 2 triggers, move os streams `identity.notification` do event store de `public` para o do serviço
preservando `global_position` (event_store, outbox ainda não publicado, checkpoint, snapshot) e ajusta só a sequence de `global_position`. ABORTA se houver FK de fora de `identity` para as 3 tabelas ou
se QUALQUER das 7 tabelas `identity.*` criadas pelo `15-identity.sql` (3 de usuário + 4 do event store) já tiver linha (as de usuário vazias são derrubadas, as do event store reaproveitadas); `lock_timeout`
de 5 s; idempotente; roda como `supabase_admin`. Depois dela o monólito não tem mais `public.users`/`mywallet`/`pending_verifications`, e o `identity` (guarda de boot `PublicSchemaGuard`) e o `run-tests.sh` recusam
subir/rodar se `public.users` ainda existir. `migrations/verify-20261028-migration.sh` (+ `verify-20261028-migration.sql`; cross-platform, bancos descartáveis `meu_banco_mig28*`, não toca em `meu_banco`) prova:
[A] banco pré-cutover populado, migração 2×, ids/identity preservados, funções e triggers em `identity`, streams movidos com `global_position`, e o rollback do cabeçalho; [B] o mesmo banco com o `15` já aplicado (vazio);
[C] as guardas; [D] o init completo num banco vazio (sem `public.users`, trigger criando a carteira em `identity.mywallet`). O estado pré-cutover vem do fixture
`migrations/legacy-fixtures/public-identity-pre-20261028.sql` (o `01/02/06/08` saíram do repo).

**`uid` reciclado:** `TRUNCATE ... RESTART IDENTITY` em `identity.users` (testes, limpeza entre blocos da carga) devolve o `user_id` a 1, e o JWT é validado sem estado (claim `uid`): um token emitido antes
passaria a valer como o usuário novo com o mesmo id. Por isso, **sempre que truncar `identity.users` fora de um teste unitário**, apague também a chave de assinatura do volume `identity-keys` (com o identity
parado) e reinicie o identity e o backend (o gateway guarda o JWKS em cache por até 24 h). O `run-tests.sh` apaga a chave ao fim da rodada; a limpeza entre blocos da carga (`Projeto/carga/limpar-banco.sh`) faz o roteiro inteiro.

**Os scripts de init só rodam na PRIMEIRA criação do volume `supabase-db-data`** (inclusive o `_supabase`/`_supavisor` do pooler; num volume antigo, recrie-o). Depois disso são
ignorados. Para reaplicar do zero:

```bash
docker compose -f Projeto/docker-compose.yml down -v
docker compose -f Projeto/docker-compose.yml up -d --build
```

`db/seed-data.sql` popula dados de exemplo (`ON CONFLICT DO NOTHING`); rode manualmente:
`docker exec -i gerenciador-db psql -h localhost -U admin -d meu_banco < Projeto/Backend/db/seed-data.sql`.

## Modelo atual

- **`users`** — (schema `identity` desde a #36) PK `user_id` (identity). `email`, `fone`, `user_name` são `UNIQUE` e
  `NOT NULL`. Flags de papel: `admin` e **`Host`** — DDL declara `Host boolean` **sem aspas**
  (`db/init-scripts/15-identity.sql`; antes `02-users.sql`), então o Postgres dobra o identificador para minúsculas:
  a coluna real é `host`, acessada sem aspas em SQL (igual `isactive`). Campos de MFA de
  reset de senha: `password_reset_mfa_code`,
  `password_reset_mfa_expiration`. `created_at` / `updated_at` com default.
  - Lido e escrito SÓ pelo serviço `identity`; qualificar sempre com `identity.` nas queries. Trigger `trigger_create_wallet` (`AFTER INSERT`): cria automaticamente a linha em
    `mywallet`. A aplicação **nunca** insere carteira à mão.
- **`event`** — (schema `catalog` desde a #35) PK `event_id`. `creator_id` integer **sem FK** para `users` (referência solta; a
  `Event_creator_id_fkey` caiu na migração `20261026`; quem confere o criador é o gateway). Migração a quente
  `db/migrations/20261026-catalog-schema.sql`: com o `backend` e o `catalog` parados e depois do `pg_dump -n public` (backup, aplicação e
  rollback no cabeçalho do arquivo); move `event`/`eventpresenter` e os streams `catalog.event` para o schema `catalog`. Lido e escrito SÓ
  pelo serviço `catalog`; qualificar sempre com `catalog.` nas queries.
  `event_name` `UNIQUE`, `ead` (bool), `image_data bytea`. **Só metadados** — capacidade/venda
  saíram daqui para `eventcap`.
  - **`version integer NOT NULL DEFAULT 0`** (issue #28): é a **projeção inline** do stream `catalog.event` (ver
    `Backend/CLAUDE.md`, "Catalog em CQRS + Event Sourcing"); `version` = versão do último evento aplicado na linha e a
    versão esperada do próximo append (lida com `FOR NO KEY UPDATE` na transação do command; a projeção a grava com o valor
    do envelope). `0` = evento "pré-ES", sem stream. `image_data` **não** vem do log (blob fora do ES), e `created_at`/
    `updated_at` são carimbos do banco: o replay compara `event_id, creator_id, event_name, ead, address, event_date,
    description, version`. `event_id` é `GENERATED ALWAYS`: a projeção insere com `OVERRIDING SYSTEM VALUE` (o id sai da
    sequence antes do append, é o `streamId`). Migração a quente: `db/migrations/20261022-catalog-event-version.sql`
    (idempotente; roda como `supabase_admin`; `ADD COLUMN IF NOT EXISTS` + **backfill**: cada evento com `version = 0` ganha um
    `EventCreated` v1 no `event_store` (estado atual, sem imagem) + a linha do `event_outbox`, e só essa linha passa a
    `version = 1`). **O backend recusa alterar/cancelar evento com `version = 0`** (erro "é pré-ES"): depois de carregar o
    `seed-data.sql`, que insere em `event` direto (aviso no topo do arquivo), reaplique a migração. Coberta por `SchemaValidationTest`,
    `CatalogEventSourcingTest` e o passo 8d do `99-tests.sql`.
- **Schema `reservation`** (issue #33, Fase 7 — o segundo schema por serviço): `eventcap`, `walletevent`, `event_availability`,
  `idempotency_key` e o event store do serviço (`reservation.event_store`/`event_outbox`/`event_snapshot`/`projection_checkpoint`, mesmo
  desenho de `public`) moram aqui e são lidos e escritos SÓ pelo serviço `reservation`. **Nenhuma FK cross-schema — e nenhuma FK nas tabelas
  do schema** (nem para `users` nem para `event`): o que `ON DELETE CASCADE` (eventcap) e `ON DELETE RESTRICT` (walletevent) garantiam virou
  chamada: o catalog remove o `eventcap` por `DELETE /internal/eventcaps/{id}`, que recusa (409) se existe `walletevent` do evento; e o gateway
  confere o evento antes de reservar (a carteira nasce com o usuário e o `uid` vem assinado no token). `mywallet` NÃO veio para cá (extensão 1:1 de `users`, FK + trigger): mora no schema `identity` (#36). `event_store` e
  cia. existem em cada schema de serviço: `identity.*` guarda `identity.notification` (congelado) e `identity.user` (#36); `public.*` ficou só com a infra da lib `shared` (testes); `reservation.*` guarda `reservation.wallet`;
  `catalog.*` guarda `catalog.event` (#35).
  Migração a quente: `db/migrations/20261025-reservation-schema.sql` (idempotente; `docker exec -i gerenciador-db psql -h localhost -U
  supabase_admin -d meu_banco < ...`; **pare o backend e o reservation**: `lock_timeout` de 5 s no `SET SCHEMA`) — move as quatro tabelas
  (dados e índices), derruba as FKs, cria o event store do serviço e **move para ele os streams `reservation.wallet`** que estavam no
  `public.event_store` (event_store com a `global_position` preservada, outbox pendente, checkpoint, snapshot) e reposiciona a sequence. Coberta
  por `SchemaValidationTest` (nos dois módulos), `TestSchemasTest` (o default do harness agora é `public,notification,reservation`) e o
  passo 9 do `99-tests.sql` (apagar o evento não mexe no `eventcap`). Qualificar sempre com `reservation.` nas queries. A migração
  `20261022-catalog-event-version.sql` (já aplicada em bancos existentes, **editada na #33**) passou a ler a capacidade de
  `reservation.eventcap` quando existe e senão de `public.eventcap` (SQL dinâmico): o comportamento depende do estado do banco, e continua
  idempotente nos dois (o fluxo "carregar o `seed-data.sql` e reaplicar" segue valendo).
- **`eventcap`** — (schema `reservation`) agregado ISOLADO de capacidade. PK `event_id`, **sem FK** (antes `→ event ON DELETE
  CASCADE`, até a #33). `capacity` (`NOT NULL`; CHECK `eventcap_capacity_valid`: `-1` ou `>= 1`, **0 é recusado** desde a #58, igual à regra
  `lot_quantity >= 1 ou -1` do catalog), `quant` = vagas disponíveis (`NOT NULL`), `buy_time_limit`
  (`timestamptz`, nullable; `timestamp` até a #58), `max_time_in_line` (segundos, default 120).
  - **`capacity = -1` ⇒ sem limite de vendas** (evento ilimitado); nesse caso `quant = -1`
    também, o CHECK `eventcap_quant_bounds` (`capacity = -1 OR 0 <= quant <= capacity`) não
    restringe, e a reserva **não** passa pelo CAS — o serviço libera direto.
  - Limitado: reserva = `UPDATE eventcap SET quant = quant - 1 WHERE event_id = ? AND
    capacity <> -1 AND quant >= 1` (CAS atômico; `rowcount = 0` ⇒ lotado). Liberação =
    `+ 1 ... WHERE capacity <> -1 AND quant < capacity`.
- **`eventpresenter`** — (schema `catalog` desde a #35) apresentadores por evento. PK composta `(event_id, presenter_name)`,
  FK `→ catalog.event` `ON DELETE CASCADE` (a única FK do schema). Substitui o antigo campo único `presenters`.
- **`mywallet`** — (schema `identity` desde a #36, junto com `users`: a FK e o trigger 1:1 não cruzam schema) PK `user_id`, FK `→ identity.users` `ON DELETE CASCADE`.
- **`walletevent`** — (schema `reservation`) inscrição/reserva N:N. PK composta `(user_id, event_id)`. **Sem FK** (antes para
  `users`/`event`, `ON DELETE RESTRICT`, até a #33). `status` (`confirmed`|`pending`|`expired`|
  `cancelled`, default `confirmed`, CHECK) + `expires_at` (`timestamptz`, só quando `pending`; `timestamp` até a #58). Índice parcial
  `idx_walletevent_pending_expires` para o job de expiração e `idx_walletevent_event_id` (btree em `event_id`, #58: a PK não serve busca só por evento). **`version`** (issue #29; `integer NOT NULL DEFAULT 0`):
  projeção inline do stream `reservation.wallet`; a versão do evento sai da própria guarda
  (`UPDATE ... SET version = version + 1 ... RETURNING version`; a 1ª reserva do par é a v1, `INSERT ... VALUES (..., 1)`) e o
  evento só é appendado quando a guarda afeta 1 linha, na mesma transação. Reservar de novo uma cancelada/expirada continua o
  mesmo stream. `0` = linha anterior ao ES (sem eventos no log). Não aparece no JSON de `EventWallet`. Migração a quente:
  `db/migrations/20261023-wallet-es-projecao.sql`.
- **`pending_verifications`** — (schema `identity` desde a #36) cadastro pré-confirmação (`email` `UNIQUE`, `password_hash`,
  `verification_code`, `expires_at`, `attempts`/`max_attempts`). Trigger
  `trigger_cleanup_on_create_verification` (chama `identity.trigger_cleanup_on_insert()`) + função `identity.cleanup_expired_verifications()`
  removem expirados a cada INSERT e no startup.
- **`event_availability`** — (schema `reservation`) **projeção assíncrona** (issue #29; ADR "Event-Backbone-Event-Store") alimentada pelo consumer
  do tópico `reservation.wallet`; lida só pelo "caminho ingênuo" de reserva (`reservation.readpath=naive`), braço de
  controle do experimento. **NÃO é fonte de verdade** (`eventcap` + CAS continuam sendo). Colunas: PK `event_id`,
  `ativos` (nº de reservas ativas: `SlotReserved` +1; `ReservationExpired`/`ReservationCancelled` −1; `ReservationConfirmed` 0),
  `last_occurred_at` (`occurredAt` do último evento aplicado: o maior visto) e `applied_at` (`clock_timestamp()` do commit do
  consumer; não `now()`, que seria o início da transação). A disponibilidade **não é gravada**: é calculada na leitura
  (`eventcap LEFT JOIN` esta tabela; `CASE WHEN capacity = -1 THEN -1 ELSE GREATEST(capacity - GREATEST(COALESCE(ativos, 0), 0), 0) END`;
  nunca lê `eventcap.quant`), então um evento sem reserva já tem disponibilidade e a mudança de capacidade vale na hora. O
  lag do último evento aplicado é `applied_at − last_occurred_at`. **Sem FK para `event` e sem CHECK em `ativos`, de
  propósito**: qualquer violação no consumer é `SQLException`, retentada sem limite pela política de erro, e travaria a
  partição; `ativos` pode ficar negativo (um `Cancelled` sem `SlotReserved`, de uma linha anterior ao ES) e a leitura trata
  `ativos` negativo como 0 (`GREATEST(ativos, 0)`; sem isso a disponibilidade passaria da capacidade). O schema antigo (`available`, `refreshed_at`, `created_at`, FK com `CASCADE`, refresh por timer) saiu.
  Usa `timestamptz` (como todo instante do schema `reservation` desde a #58).
  Migração a quente (histórica; roda ANTES da `20261025`, quando as tabelas ainda estão em `public`): `db/migrations/20261023-wallet-es-projecao.sql` (idempotente: cria `walletevent.version` e, **só se a
  tabela ainda tem o schema antigo**, derruba e recria `event_availability` com o baseline de `ativos` = reservas ativas que
  já existem em `walletevent`; roda como `supabase_admin`; pare o `gerenciador-backend` antes de migrar (a imagem antiga ainda faz `INSERT` nas colunas que a migração derruba; o `ALTER TABLE walletevent` tem `lock_timeout` de 5 s); a antiga `20260903-event-availability.sql` fica como histórico (superada: aplicada depois desta, falha, pois a tabela já não tem `available`). Coberta por
  `SchemaValidationTest`, `EventWalletNaivePathTest`, `EventAvailabilityProjectionTest`, `ReservationReplayTest` e os passos
  6b/6c do `99-tests.sql`. **Replay:** vale para streams nascidos depois da migração.
- **`idempotency_key`** (issue #24; schema `reservation` desde a #33) — PK composta `(user_id, idempotency_key)` (a chave tem escopo por
  usuário, issue #129; `idempotency_key` é text, até 255 caracteres validado no backend),
  `event_id` (**sem FK** para `users`/`event`, de propósito: fronteira de módulo, schema por
  serviço é Fase 7), `expires_at` (o da reserva original, devolvido na repetição), `created_at`
  (`timestamptz`). Uma linha por reserva **bem-sucedida**: o `INSERT ... ON CONFLICT DO NOTHING` entra na
  MESMA transação JDBC do CAS em `eventcap` + `walletevent`, então falha faz rollback e não deixa chave;
  a PK serializa duas requisições do mesmo usuário com a mesma chave. **Retenção** (issue #130): o job
  `IdempotencyKeyRetentionService` apaga, em lotes, as linhas com `created_at` mais antigo que
  `idempotency.retention.hours` (default 24h); o índice `idx_idempotency_key_created_at` (btree em `created_at`)
  serve esse filtro (a PK não serve; sem ele cada rodada faria seq scan da tabela inteira). Migração a quente: `db/migrations/20261018-idempotency-key.sql` (idempotente; roda como
  `supabase_admin`, por isso o `OWNER TO admin` explícito) e, para trocar a PK antiga `(idempotency_key)`
  pela composta, `db/migrations/20261019-idempotency-key-pk-por-usuario.sql` (idempotente: só troca se as
  colunas da PK ainda forem as antigas) e `db/migrations/20261020-idempotency-key-created-at-index.sql` (índice
  de `created_at`, `CREATE INDEX IF NOT EXISTS`; independe da `20261019-...`; pré-requisito: a tabela existir). Coberta por `SchemaValidationTest`,
  `IdempotencyKeyTest`, `IdempotencyRetentionTest` e o passo 8b do `99-tests.sql`.

- **Schema `notification`** (issue #32, Fase 7 — o primeiro schema por serviço; o `notification` não lê nenhuma tabela de
  `public`) — `notification.processed_event`: PK `event_id` (uuid, o `eventId` do envelope), `event_type`, `processed_at`
  (`timestamptz`, `clock_timestamp()`). Uma linha por e-mail JÁ enviado; o consumer faz `INSERT ... ON CONFLICT DO NOTHING` na
  mesma transação do envio (rowcount 0 = reentrega). Sem dado pessoal. Sem limpeza ainda (pendência no `Backend/CLAUDE.md`). A role
  `admin` (dona do banco) cria o schema; o `OWNER TO admin` explícito é para a migração a quente, que roda como `supabase_admin`:
  `db/migrations/20261024-notification-schema.sql` (idempotente; `docker exec -i gerenciador-db psql -h localhost -U supabase_admin
  -d meu_banco < ...`). Coberta por `SchemaValidationTest`, `TestSchemasTest` (o default do harness agora é `public,notification`)
  e `NotificationConsumerTest`. O harness de migração `verify-20260901-migration.sh` não aplica o `12` (não toca no
  `notification`). Qualificar sempre com `notification.` nas queries (não há `search_path`, o Supavisor em transaction mode proíbe).
- **Event sourcing (issue #27; ADR "Event-Backbone-Event-Store")** — infra genérica, sem domínio, sem FK (um conjunto por schema de serviço desde a #33:
  `public.*`, `reservation.*` e, desde a #35, `catalog.*`; o texto abaixo descreve o de `public`, os outros são iguais) (as #28/#29
  só appendam eventos com o seu `stream_type`; a #28 usa `catalog.event`). Código em `Backend/.../shared/events` (ver `Backend/CLAUDE.md`,
  "Event store e backbone de eventos"). Migração a quente: `db/migrations/20261021-event-store.sql` (idempotente; roda como
  `supabase_admin`, por isso o `OWNER TO admin` explícito). Cobertas por `SchemaValidationTest`, pelos testes de
  `shared/events` e pelo passo 8c do `99-tests.sql`.
  - **`event_store`** — log **imutável** (nenhuma linha é atualizada depois do append) e fonte de verdade dos streams.
    PK `global_position` (`bigint GENERATED ALWAYS AS IDENTITY`: ordem de **alocação**, não de commit, então não serve de
    cursor), `UNIQUE (stream_type, stream_id, version)` (concorrência otimista: `INSERT ... ON CONFLICT DO NOTHING`,
    rowcount 0 = outra transação gravou a versão), `CHECK (version >= 1)`. Colunas do envelope: `event_id` (uuid),
    `stream_type`, `stream_id`, `version`, `event_type`, `schema_version`, `occurred_at` (`timestamptz`, default
    `clock_timestamp()`: instante do append, não o início da transação), `payload`/`metadata` (`jsonb`; **sem dado
    pessoal**: a tabela é imutável por convenção. Única exceção, decisão do usuário de 2026-10-21 (#32): o stream
    `identity.notification` leva e-mail e código, e o `NotificationEventRetentionService` do `identity` (antes do monólito) apaga essas linhas
    quando o código venceu há mais de 30 s e a linha já saiu do `event_outbox`) e `partition_key` (chave da mensagem no tópico: o id do evento de domínio).
  - **`event_outbox`** — só `global_position` (PK), sem FK de propósito. Inserida na mesma transação do append e **apagada**
    pelo relay depois do ack do broker. `INSERT`+`DELETE` contínuo = tuplas mortas, por isso
    `autovacuum_vacuum_scale_factor = 0.01` e `autovacuum_vacuum_threshold = 100`.
  - **`event_snapshot`** — PK `(stream_type, stream_id)` (um snapshot por stream, o mais novo vence), `version`, `state
    jsonb`. **Cache descartável**: mudou o formato do estado → apaga e reconstrói.
  - **`projection_checkpoint`** — PK `(projecao, stream_type, stream_id)`, `version` = última aplicada por projeção; o avanço
    atômico (`UPDATE ... WHERE version = v-1`, `INSERT ... ON CONFLICT DO NOTHING` na v1) é a idempotência do consumer.
  - O replay usa um **schema-sombra** criado e derrubado pelo próprio código (nada de `TEMP TABLE`), numa transação
    `REPEATABLE READ`; fica fora do `SchemaValidationTest` e do `GlobalDbTruncator`.

## Regras ao alterar o schema

- Edite o `.sql` correspondente em `init-scripts/`. Se a mudança precisar valer para bancos
  já existentes (o volume não vai ser recriado), escreva também um script idempotente
  (`ALTER TABLE ... IF NOT EXISTS`, `CREATE OR REPLACE`) e rode manualmente via `psql`.
- Reflita a mudança no repository JDBC correspondente do backend (nome de coluna, tipo,
  nullability) e ajuste `SchemaValidationTest`.
- Atualize `99-tests.sql` se a mudança afetar trigger/relacionamento.
- Depois de mexer, valide com `down -v` + `up` e rode `Projeto/Backend/run-tests.sh`.
- SQL sempre parametrizado no lado da aplicação; identificadores com maiúscula entre aspas.
