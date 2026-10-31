# Etapa 03: Supabase Postgres + Supavisor

## O que estava implementado

- Monólito Spring Boot (JDBC puro, HikariCP com 1000 conexões).
- Banco: `supabase/postgres:17.6.1.136` (PG 17.6, locale en_US) no lugar do `postgres:16-alpine`
  (issue #18, `c959440`).
- Pooler: Supavisor (`supabase/supavisor:2.9.13`) em **transaction mode** entre o backend e o Postgres
  (issue #19, `051fb64`).
  - O backend conecta em `supabase-pooler:6543` com o usuário `<role>.gerenciador-eventos` e `prepareThreshold=0`.
  - O Hikari só enfileira no pooler.
- Pool real no Postgres: `POOLER_DEFAULT_POOL_SIZE` = `max_connections − 55`.
  - Padrão: 45, com `max_connections` 100.
  - Teste de taxa: 245, com `max_connections` 300 (`carga/rpm/docker-compose.rpm.yml`).
- A role `admin` do app não é superuser e é dona do banco (`91c807c`).
- Código: a partir de `66a46b4` (merge do PR #119); as rodadas da #22 rodaram na branch `Issue-22`.

## Período

A partir de 2026-10-16.

## Arquivos

- `matriz.csv`: matriz CAS × ingênuo depois do pooler (#22), 50 linhas (10 CAS + 40 ingênuo; commit `12fc154`),
  no mesmo protocolo da `../02-hikari/matriz-prepooler-20261016.csv`. Rodadas de 2026-10-16, no commit `8ba01b4`.
  Condições: banco limpo, `max_connections` 300 e pool do Supavisor de 245. É o ponto 1 da série.
- Rodadas de 2026-10-17 (host na `main` `a8fc86a`, braço `cas`, Hikari 1000, banco novo em cada bloco, Studio/meta/kong parados;
  commit `7f30308`):
  - `matriz-isola-pool300.csv`: matriz CAS (10 linhas) com pool do Supavisor de 300 e `max_connections` 355; isola o teto de conexões.
  - `matriz-isola-sem-pooler.csv`: matriz CAS (10 linhas) com PG 17 sem pooler (backend direto em `db:5432`, override local não versionado); isola o Supavisor.
  - `degraus-28082.csv` e `summary-degraus-28082.json`: escada pelo pooler de 20k a 55k, passo 5k, sem `netsh`; o degrau de 55k está contaminado por erros de porta do cliente.
  - `degraus-32105.csv` e `summary-degraus-32105.json`: escada pelo pooler de 50k a 130k, passo 10k, com `netsh`; satura em 80k.
  - `degraus-33459.csv` e `summary-degraus-33459.json`: refinamento de 70k a 80k, passo 1k; o 1º degrau é aquecimento. X pelo pooler ≈ 78k RPM.
  - Escadas com pool de 245, `max_connections` 300, `MAX_VUS` 3000 e 200 usuários.

## Análise

- [`docs/carga/resultados-isolamento-escada-pospooler-2026-10-17.md`](/testes/ponto-1/resultados-isolamento-escada-pospooler-2026-10-17):
  isolamento do pooler (pool 300 e PG 17 sem pooler) e escada X pelo pooler.
- [`docs/carga/resultados-matriz-pospooler-2026-10-16.md`](/testes/ponto-1/resultados-matriz-pospooler-2026-10-16):
  resultados e comparação com o pré-pooler.
- [`docs/artigo/experimento-monolito.md`](/testes/artigo/experimento-monolito): texto do artigo, subseção
  "Ponto 1 (pós-pooler)".
- Pré-pooler (referência): [`docs/carga/resultados-matriz-2026-10-16.md`](/testes/pre-serie/resultados-matriz-2026-10-16).
- Threads do backend (2026-10-17, mesma condição do ponto 1; detalhes em
  [`resultados-isolamento-escada-pospooler-2026-10-17.md`](/testes/ponto-1/resultados-isolamento-escada-pospooler-2026-10-17)):
  - `matriz-virtual-threads.csv`, `degraus-38530.*`: virtual threads ligadas.
  - `matriz-tomcat300.csv`, `degraus-39710.*`: Tomcat com 300 threads.
  - `matriz-tomcat400.csv`, `degraus-40664.*`: Tomcat com 400 threads.
