# Etapa 01: monólito sem pool de conexões

> **Números invalidados (#96).** Medem o esgotamento de portas do backend, não o sistema. Ficam só como o
> "antes" da comparação com a etapa 02.

## O que estava implementado

- Monólito Spring Boot (JDBC puro) + Postgres 16 (`postgres:16-alpine`, build de `Projeto/Backend/db`), sem pooler.
- **Sem pool.** `DatabaseConnection.getConnection()` usava `DriverManager.getConnection(...)` e abria uma conexão TCP
  nova a cada operação de repositório.
- Sob carga, os sockets em `TIME_WAIT` esgotavam as portas efêmeras do backend e as requisições falhavam com
  `BindException: Cannot assign requested address`, que virava 5xx (~31% a 10k RPM; 112.878 no aleatório).
- `max_connections`: 300 até a `Rpm-904217` (13:05) e 1000 depois. A mudança não teve efeito.
- Código: antes de `5beb1b7` (pool, issue #96, PR #97). O commit testado não foi registrado; a exceção é a
  `Ale-904991`, que rodou `c9bd024` (PR #95).

## Período

2026-10-04, das 12:26 às 14:31.

## Arquivos

- `baseline-20261004-122632.txt`: latência base gerador → host (HTTP p50 14,9 / p95 19,0 ms; o ICMP não respondeu).
- `summary-cas-n{50,100,200}-902454/902477/902506.json`: disputa CAS, 1ª bateria (capacidade 20).
- `summary-cas-n{50,100,200}-902833/902854/902883.json`: disputa CAS, 2ª bateria.
- `summary-rpm2000-903185.json`: 2k RPM (`Rpm-903185`).
- `summary-rpm10000-903506.json` e `-904217.json`: 10k RPM por 90 s, `max_connections` 300.
- `summary-rpm10000-909189.json` e `-909317.json`: 10k RPM por 60 s, `max_connections` 1000.
- `summary-ale-904483.json` + `perfil-ale-904483.json`: smoke do teste aleatório.
- `summary-ale-904991.json` + `perfil-ale-904991.json`: aleatório de 45 min (1k–12k RPM, semente 617706).

As linhas destas rodadas em `resultados*.csv` e `verificacoes.log` ficaram nos arquivos agregados de
[`../02-hikari/`](/testes/pre-serie/hikari). Nesses arquivos, tudo que é anterior a 2026-10-04 15:12 pertence a esta etapa.

## Análise

- [`docs/carga/setup.md`](/testes/metodo/setup), seção 6: registro das rodadas, causa e correção (#96).
- [`../02-hikari/ANALISE.md`](/testes/pre-serie/analise), seção 3: comparação antes × depois do pool.
