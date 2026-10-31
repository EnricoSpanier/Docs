# Etapa 02: monólito + HikariCP, Postgres direto

## O que estava implementado

- Monólito Spring Boot (JDBC puro) + Postgres 16 (`postgres:16-alpine`; 16.15 em 2026-10-16). Não havia pooler:
  o backend conectava direto em `db:5432`.
- `DatabaseConnection` usa o `DataSource` do Spring (HikariCP) com `maximum-pool-size` 1000 e `minimum-idle` 5
  (o pool cresce sob demanda). Tomcat com 200 threads.
- `max_connections`:
  - 1000 em 2026-10-04;
  - em 2026-10-16, 100 nas escadas até a `959190`, 1000 nas `959765`/`962591`/`963487` e 300 na matriz.

  A coluna `max_connections` dos CSVs é só um rótulo: vale o `SHOW max_connections` do host.
- Código:
  - início: `5beb1b7`/`37384ba` (issue #96, PR #97; o host rodou `275d587`);
  - fim: a última rodada entrou em `1fbe12b`, e a etapa vai até antes da troca para `supabase/postgres` (`c959440`);
  - commits testados em 2026-10-16: `5120412` nas escadas e `569d1be` na matriz.

## Período

2026-10-04, das 15:30 às 20:22, e 2026-10-16, das 16:24 às 19:57.

## Arquivos

- `ANALISE.md`: análise das rodadas de 2026-10-04 (antes e depois do pool; `cas` × `naive`).
- `resultados.csv`, `resultados-rpm.csv` e `resultados-aleatorio.csv`: uma linha por rodada dos testes 1, 2 e 3
  de 2026-10-04. **Misturam etapas**: as linhas anteriores a 15:12 são da etapa 01 (sem pool, invalidadas).
- `verificacoes.log`: overselling conferido no banco, uma entrada por rodada. As 3 primeiras entradas
  (14:18–14:31) são da etapa 01.
- `sockstat.log`: 5 amostras de `TIME_WAIT` às 15:42, em repouso, já com o pool.
- `summary-cas-n*-913009/913030/913055.json`: disputa CAS depois do pool.
- `summary-cas-n*-917405/917424/917450.json`: disputa CAS com 100% de confirmação.
- `summary-cas-n*-918157/918177/918201.json`: disputa CAS realista (60% de confirmação).
- `summary-naive-n*-924310/924330/924354.json` e `-924401/924420/924445.json`: disputa `naive` (100% e 60%).
- `summary-rpm10000-913181.json` e `-913395.json`: 10k RPM depois do pool.
- `summary-rpm10000-917602.json` (100%) e `-918245.json` (60%): 10k RPM com confirmação.
- `summary-rpm10000-924492.json` (100%) e `-924628.json` (60%): 10k RPM `naive`.
- `summary-ale-913561.json` + perfil: aleatório de 45 min depois do pool.
- `summary-ale-919068.json` + perfil: aleatório realista (60%).
- `summary-ale-924767.json` (100%) e `-927639.json` (60%) + perfis: aleatório `naive`.
- `summary-ale-266475.json` + perfil: aleatório `cas` de 2 min com leitura por endpoint (2026-10-08).
- `degraus-<id>.csv` + `summary-degraus-<id>.json`: 8 escadas do limiar X (#14). IDs: 953959, 954833, 956799, 958305,
  959190, 959765, 962591 e 963487.
- `smoke-20261016/`: smoke da matriz e da escada, mais o baseline de rede de 2026-10-16.
- `matriz-prepooler-20261016.csv`: matriz oficial CAS × ingênuo (#12/#13), 50 linhas (versionada em `1fbe12b` como
  `matriz.csv`; copiada para cá com este nome no commit `12fc154` da #22, junto com a matriz pós-pooler).

## Análise

- [`ANALISE.md`](/testes/pre-serie/analise): rodadas de 2026-10-04.
- [`docs/carga/setup.md`](/testes/metodo/setup), seção 6: registro das rodadas de 2026-10-04.
- [`docs/carga/resultados-escada-2026-10-16.md`](/testes/pre-serie/resultados-escada-2026-10-16): escadas.
- [`docs/carga/resultados-matriz-2026-10-16.md`](/testes/pre-serie/resultados-matriz-2026-10-16): matriz.
- [`docs/artigo/experimento-monolito.md`](/testes/artigo/experimento-monolito): texto do artigo.
