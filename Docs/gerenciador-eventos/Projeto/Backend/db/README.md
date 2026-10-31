# Banco de dados (PostgreSQL)

PostgreSQL 17 (`supabase/postgres`, container `gerenciador-db`, banco `meu_banco`), com o schema **em SQL**, versionado aqui: não
há ORM nem migração automática. Cada serviço é dono de um schema e nenhum lê tabela de outro; não há FK entre schemas. Regras
completas, modelo de dados e decisões: [`CLAUDE.md`](CLAUDE.md). Visão geral do sistema: [`../../../README.md`](../../../README.md).

## Schemas por serviço

| Schema | Dono | Conteúdo |
|---|---|---|
| `identity` | serviço `identity` | `users`, `mywallet`, `pending_verifications`; event store próprio (`identity.notification`, `identity.user`) |
| `catalog` | serviço `catalog` | `event`, `eventpresenter`; event store próprio (stream `catalog.event`) |
| `reservation` | serviço `reservation` | `walletevent`, `idempotency_key` (também o log da saga), projeção `event_availability`; event store próprio (stream `reservation.wallet`) |
| `stock` | serviço `stock` | `eventcap` (capacidade, CAS) e `hold` (ledger da saga); sem event store |
| `notification` | serviço `notification` | `processed_event` (idempotência do consumer) |
| `public` | lib `shared` | só a infra de event store (`event_store`, `event_outbox`, `event_snapshot`, `projection_checkpoint`) |

O `admission` não tem datasource (usa Redis e RabbitMQ). O usuário do app é `admin` (sem superuser, dono de `meu_banco`); o
Supabase mantém os próprios schemas (`auth`, `storage`, `extensions`...) no mesmo banco e eles não são tocados.

## Banco novo: init-scripts

No primeiro `up` com o volume `supabase-db-data` vazio, o `db` roda [`supabase-app-init.sql`](https://github.com/endydragonn/GerenciadorEventos/blob/main/Projeto/Backend/db/supabase-app-init.sql), que cria a role do
app e inclui, em ordem, os scripts de [`init-scripts/`](https://github.com/endydragonn/GerenciadorEventos/blob/main/Projeto/Backend/db/init-scripts/) (montados em `/app-init`):

| Ordem | Script | Cria |
|---|---|---|
| 1 | `11-event-store.sql` | infra de event store em `public` |
| 2 | `12-notification.sql` | schema `notification` |
| 3 | `13-reservation.sql` | schema `reservation` |
| 4 | `14-catalog.sql` | schema `catalog` |
| 5 | `15-identity.sql` | schema `identity` (com as funções e triggers da carteira) |
| 6 | `16-stock.sql` | schema `stock` |
| 7 | `99-tests.sql` | suíte de sanidade em blocos `DO` (trigger, CAS, CHECKs, event store); **apaga os dados** de todas as tabelas do app, ver abaixo |

**Script novo em `init-scripts/` precisa de um `\i` em `supabase-app-init.sql`.** Os scripts só rodam na **primeira** criação do
volume; para recomeçar do zero (apaga todos os dados e a chave do JWT):

```bash
docker compose -f Projeto/docker-compose.yml down -v
docker compose -f Projeto/docker-compose.yml up -d --build --wait
```

Pré-requisito: `Projeto/supabase/.env` existir (ver [`../../supabase/README.md`](../../supabase/README.md)).

## Banco existente: migrações

[`migrations/`](https://github.com/endydragonn/GerenciadorEventos/blob/main/Projeto/Backend/db/migrations/) guarda os scripts idempotentes para quem já tem um volume antigo; aplique **em ordem**, só as que ainda
faltam, a quente, com o usuário e o comando indicados **no cabeçalho de cada arquivo**. A maioria roda como `supabase_admin` (por isso as tabelas
criadas levam `OWNER TO admin` explícito); `20260901` e `20260903` usam `-U admin` e a `20261020` copia o arquivo para o container com `docker cp`.
Forma geral:

```bash
docker exec -i gerenciador-db psql -h localhost -U supabase_admin -d meu_banco -v ON_ERROR_STOP=1 \
  < Projeto/Backend/db/migrations/<arquivo>.sql
```

O cabeçalho de cada arquivo traz as precondições, o comando de backup, o de aplicação e o rollback. As migrações de **schema** de
serviço exigem os serviços afetados parados e um backup `pg_dump` antes (o backup vale só até reabrir o tráfego e deve ficar fora do repo):

| Migração | O que faz | Precondição |
|---|---|---|
| `20260901-eventcap-isolation.sql` | isola `eventcap` e cria a máquina de estados de `walletevent` (a semântica de `quant` inverte) | - |
| `20260903-event-availability.sql` | **superada** pela `20261023`; fica como histórico | não aplicar depois da `20261023` |
| `20261018-idempotency-key.sql` | tabela `idempotency_key` | - |
| `20261019-idempotency-key-pk-por-usuario.sql` | chave de idempotência por usuário | `20261018` |
| `20261020-idempotency-key-created-at-index.sql` | índice para o job de retenção | `20261018` |
| `20261021-event-store.sql` | infra de event store | - |
| `20261022-catalog-event-version.sql` | coluna `event.version` e backfill do `EventCreated` | `20261021` |
| `20261023-wallet-es-projecao.sql` | `walletevent.version` e projeção assíncrona `event_availability` | backend parado |
| `20261024-notification-schema.sql` | schema `notification` | - |
| `20261025-reservation-schema.sql` | move a reserva para o schema `reservation` e o seu event store | backend e `reservation` parados |
| `20261026-catalog-schema.sql` | move `event`/`eventpresenter` e o stream `catalog.event` para `catalog` | `20261025`; backend e `catalog` parados; backup do `public` |
| `20261027-reservation-timestamptz.sql` | instantes em `timestamptz`, índice por evento, `capacity = -1 OR >= 1` | `20261025`; backend e `reservation` parados; backup do `reservation`; aborta se houver `capacity = 0` |
| `20261028-identity-schema.sql` | move `users`, `mywallet`, `pending_verifications` e o stream `identity.notification` para `identity` | `20261025` e `20261026`; backend e `identity` parados; backup do `public` |
| `20261029-stock-schema.sql` | move `eventcap` para `stock`, cria `stock.hold`, colunas da saga e backfill dos holds | `20261025` e `20261027`; backend, `reservation`, `catalog` e `stock` parados; backup do `reservation` |

As migrações `20260901` e `20261026` a `20261029` vêm com um harness `verify-<data>-migration.sh` (+ `.sql`) que a prova num banco
**descartável**, sem tocar em `meu_banco` (por exemplo `migrations/verify-20261029-migration.sh`); `legacy-fixtures/` guarda o estado
anterior usado por eles. As demais não têm harness.

Depois de truncar `identity.users` fora de um teste (limpeza manual, carga), apague também a chave do JWT do volume `identity-keys`
e reinicie `identity` e `backend`: o `user_id` é reciclado e um token antigo passaria a valer para o usuário novo
(`Projeto/Backend/run-tests.sh` e `Projeto/carga/limpar-banco.sh` já fazem isso).

## Dados de exemplo e sanidade

```bash
# dados de exemplo (INSERTs com ON CONFLICT DO NOTHING)
docker exec -i gerenciador-db psql -h localhost -U admin -d meu_banco < Projeto/Backend/db/seed-data.sql
```

**Atenção com o `99-tests.sql`:** ele dá `TRUNCATE ... RESTART IDENTITY CASCADE` em todas as tabelas do app (`identity`, `catalog`, `reservation`, `stock`
e a infra de event store). No primeiro `up` de um volume novo ele roda no init e é inofensivo; **não o rode contra um banco com dados que você queira manter**.
Para executá-lo à mão, use um banco descartável criado com os init-scripts atuais. É também o que o `TEST_DB_NAME` do `run-tests.sh`
espera: o banco precisa ser **criado antes** (o script não o cria, só o usa) e, nele, os testes é que dão o `TRUNCATE`.

O `seed-data.sql` insere eventos direto na tabela, sem passar pelo `catalog`: depois dele, reaplique a
`20261022-catalog-event-version.sql` (idempotente) para criar o stream de cada evento. A alternativa por API é `POST /bff/seed`, que
só existe com `SEED_ENABLED=true` (override de carga; ver [`../../README.md`](../../README.md)).

Inspeção visual: Supabase Studio em `http://localhost:8000` (login com `DASHBOARD_USERNAME` e `DASHBOARD_PASSWORD` de `Projeto/supabase/.env`).
