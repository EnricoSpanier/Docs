---
sidebar_position: 7
sidebar_label: "ADR: Supabase Self-Hosted"
tags: [architecture, decision, adr, infra, docker, supabase, postgres, load-testing]
---

# Decisão de Arquitetura — Supabase self-hosted como camada de banco

> **Status: decidido, NÃO implementado.** Este documento registra a decisão e o
> impacto. A implementação fica para quando o Docker Desktop estiver instalado e houver
> uma sessão para iterar no compose (não dá para testar antes disso).
>
> **Nota (2026-09-02):** decidido depois em conjunto com [Architecture-Decision-Microservices-Split](./Architecture-Decision-Microservices-Split.md).
> O pooler deixou de ser "só" o que torna o teste de carga informativo — virou
> **pré-condição para rodar N serviços** (conexão-por-request sem pool × N serviços é pior
> que o monólito atual). O compose final também sobe **Kafka/Redpanda** (backbone de
> eventos), **RabbitMQ** (admissão) e **Redis** (sinal de carga), além dos serviços de
> aplicação. Fase 4 do roadmap — issues #16–#22 em [Roadmap-e-Issues](./Roadmap-e-Issues.md).

## Contexto

O banco hoje é um contêiner PostgreSQL 16 próprio (`Projeto/Backend/db/Dockerfile` +
`docker-compose.yml`, serviço `db`). O backend Spring abre uma conexão JDBC nova a cada
request (`config/DatabaseConnection` → `DriverManager`, sem pool). Isso vira o gargalo
dominante num teste de carga: satura o `max_connections` do Postgres e mede custo de
handshake de conexão, não o padrão CAS de `eventcap`.

Supabase self-hosted foi avaliado. Conclusão inicial era "não vale" (o Supabase não muda a
semântica do CAS, que é lock de linha do Postgres puro). Reavaliado: o valor não é o CAS, é
a **infra em volta** — pooler e ferramentas — que hoje falta no setup.

## Decisão

Adotar **Supabase self-hosted na forma enxuta**, **substituindo** o serviço `db` do
`docker-compose.yml` (o `db/Dockerfile` atual e o compose original ficam como fallback em
histórico git). Serviços a subir:

| Serviço | Para quê |
|---|---|
| `supabase-db` (`supabase/postgres`) | Postgres + extensões (`pg_stat_statements`, `pgvector`, `pg_cron`, …) + roles do Supabase |
| `supabase-pooler` (Supavisor) | **Connection pooling** — é o motivo principal. Transaction mode na `:6543`, session mode na `:5432` |
| `supabase-studio` (+ `kong`, `meta`, e o que Studio exigir) | GUI do banco — útil pra inspeção e prints no TCC |

**Fora do escopo** (o backend Spring já faz): GoTrue (auth), PostgREST, Realtime, Storage,
imgproxy, edge functions. Não sobem no compose enxuto.

## Por quê

- **Pooler (Supavisor)** resolve estruturalmente o "conexão nova por request" — sem tocar
  ainda no `DatabaseConnection`. Transaction pooling multiplexa poucas conexões reais do
  Postgres entre muitos clientes; é o que torna o teste de carga informativo.
- **`supabase/postgres`** já vem com `pg_stat_statements` (análise de query no teste de
  carga), `pg_cron` (alternativa ao job `@Scheduled` de expiração **e** ao catch-up de
  projeção do CQRS/ES, se quiser puxar do banco), `pgvector` (futuro), tudo sem
  `CREATE EXTENSION` manual.
- **Studio** dá inspeção visual de `eventcap`/`walletevent` durante os testes e material
  visual pro relatório.
- Custo: **$0** self-hosted (open source). Nuvem free tier pausa após 7 dias sem uso e tem
  compute estrangulado (inútil pra carga); Pro é US$ 25/mês.

## Impacto — o que muda quando implementar

- **`Projeto/docker-compose.yml`**: serviço `db` → serviços `supabase-*`. `backend` passa a
  `depends_on: supabase-pooler` (ou `supabase-db`).
- **Init scripts** (`Projeto/Backend/db/init-scripts/*.sql`): montar em
  `/docker-entrypoint-initdb.d/migrations/` do `supabase-db` (convenção do Supabase), com
  prefixo numérico **alto** para rodar DEPOIS do init do próprio Supabase (`roles.sql`,
  schemas `auth`/`storage`/`extensions`). Reordenar `00`…`99` conforme.
- **Nome do banco**: Supabase usa `postgres` por padrão. Ou manter `meu_banco` (o
  `00-create-db.sql` ainda cria) e ajustar `SPRING_DATASOURCE_URL`, ou migrar tudo para
  `postgres`. Decidir na implementação.
- **Conexão do backend**: `SPRING_DATASOURCE_URL` → `jdbc:postgresql://supabase-pooler:6543/…`.
  Transaction pooling **não suporta prepared statements nomeados nem estado de sessão**.
  O `DatabaseConnection` usa `PreparedStatement` simples (não nomeado) — provável OK — mas:
  - adicionar `?prepareThreshold=0` na URL (PgJDBC usa prepared statements não nomeados), **ou**
  - usar session mode (`:5432`) se aparecer incompatibilidade.
  - conferir que não há `SET`/`SET LOCAL`/advisory locks dependentes de sessão no código.
  - as transações do fluxo de reserva (`EventWalletService`, `EventCapRepository.tryReserve`)
    são curtas e num único `Connection` — compatíveis com transaction pooling.
- **`.env`**: Supabase exige muitos segredos (`POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`,
  `SERVICE_ROLE_KEY`, `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD`, `SECRET_KEY_BASE`,
  `VAULT_ENC_KEY`, …). Gerar com `supabase/docker/utils/generate-keys.sh`.
  **⚠️ `Projeto/.env` já está commitado no git com segredos reais** — resolver isso
  (`git rm --cached`, `.gitignore`, rotacionar) ANTES de adicionar mais segredos.
- **Volumes**: Supabase espera a estrutura `./volumes/db/`, `./volumes/api/` etc. — vem do
  repo `supabase/supabase` (`docker/`). Vendorizar essa pasta ou referenciá-la.
- **Testes** (`run-tests.sh`, `GlobalDbTruncator`, `SchemaValidationTest`): mesmo Postgres,
  devem continuar passando. `SchemaValidationTest` filtra `table_schema='public'` e os
  `TRUNCATE` são `public.*` — os schemas extras do Supabase não atrapalham. Rodar contra o
  `supabase-db` direto (`:5432`), não pelo pooler, nos testes. **Mas** com schema-per-service
  ([Architecture-Decision-Microservices-Split](./Architecture-Decision-Microservices-Split.md)) esses dois deixam de poder assumir `public`
  — issue #21 do [Roadmap-e-Issues](./Roadmap-e-Issues.md).

## Questões em aberto (resolver na implementação)

- Conjunto mínimo de serviços para o Studio subir (cadeia Studio → meta → kong → analytics/vector).
- Transaction (`:6543`) vs session (`:5432`) pooling para o backend.
- Manter `meu_banco` ou migrar para `postgres`.
- Vendorizar `supabase/docker/` no repo ou usar como submódulo / script de setup.
- Um Postgres com **schema por serviço** vs. um banco por serviço (Supavisor faz os dois).
- Se o **event store** for tabela de streams no Postgres (em vez de Kafka como log de
  verdade), ela vive aqui — ver [Architecture-Decision-Microservices-Split](./Architecture-Decision-Microservices-Split.md) "Questões em
  aberto".

## Relacionado

- [_Event-Management-System](./visao-geral.md)
- [Contexto: microsserviços + backbone Kafka](./Architecture-Decision-Microservices-Split.md)
- [Fase 4 — issues #16–#22](./Roadmap-e-Issues.md)
- [Backend-Architecture](./Backend-Architecture.md)
- [Database-Schema](./Database-Schema.md)
- [Implementacao-EventCap-e-Reserva-CAS](./Implementacao-EventCap-e-Reserva-CAS.md)
- [Architecture-Decision-Async-Checkout-Queue](./Architecture-Decision-Async-Checkout-Queue.md) — a camada de alta carga (RabbitMQ/Redis) é ortogonal a isto


---

*Sincronizado automaticamente de `Architecture-Decision-Supabase-Self-Host.md` em 2026-10-30T19:11:52.866Z.*
