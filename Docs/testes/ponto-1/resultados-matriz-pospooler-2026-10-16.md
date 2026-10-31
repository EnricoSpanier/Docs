---
sidebar_position: 4
---

# Matriz CAS × ingênuo depois do pooler: resultados de 2026-10-16

Rodadas 1a (braço CAS) e 1b (braço ingênuo) da issue #22 repetidas **com o Supabase Postgres e o Supavisor**.
É o **ponto 1 da série de 3** (monólito CRUD + pooler, `CONTEXT.md`). Capacidade de 20 vagas, 100% de
confirmação, 5 repetições por configuração, mesmo protocolo da matriz anterior
([Matriz CAS × ingênuo: resultados de 2026-10-16](/testes/pre-serie/resultados-matriz-2026-10-16), "monólito + HikariCP").
Fonte: `Projeto/carga/results/03-supabase-pooler/matriz.csv` (50 linhas: 10 CAS + 40 ingênuo; commit `12fc154`,
rodadas no commit `8ba01b4`). Nenhuma repetição inválida. Os agregados abaixo foram recalculados do CSV.
Máquinas: ver [Escada de degraus: resultados de 2026-10-16](/testes/pre-serie/resultados-escada-2026-10-16).

## Resumo

- **CAS: overselling 0 nas 10 execuções**, como antes. Exatamente 20 confirmadas em todas.
- **A latência e a vazão do CAS pioraram**: p95 de 53,7 para 103,9 ms com N = 100 e de 77,1 para 155,3 ms com
  N = 200 (cerca de 2×); vazão −47% e −43%. A mudança mistura **três alterações simultâneas** (pooler, PG 16 → 17 com
  outro locale e teto de conexões reais) e também o estado do banco (limpo agora, inchado antes). **Não dá para
  atribuí-la ao pooler.** Separar os efeitos exigiu rodadas extras, feitas depois: ver
  [Isolamento do pooler e escada X pelo pooler](/testes/ponto-1/resultados-isolamento-escada-pospooler-2026-10-17) (o Supavisor
  responde pela maior parte da piora).
- **Ingênuo: o lag observado agora respeita o configurado** (no lag de 500 ms, `lag_obs_disparo` médio de 275 ms; antes, 1592 ms),
  porque o banco começou limpo. Com isso, pela primeira vez o overselling **não** ficou sempre no teto: em 4 das 40
  repetições a rajada atravessou um refresh que "fechou" o evento no meio (68, 15, 25 e 64). As outras 36 ficaram no teto
  (80 com N = 100; 180 com N = 200).
- O braço de controle continua com overselling em todos os lags. A dependência da fase do refresh, que a hipótese
  previa, antes ficava escondida pelo lag inflado.

## Condições medidas no host

| Item | Valor |
|---|---|
| Commit (host e gerador) | `8ba01b4` (`Fase_4` com as issues #17, #18, #19 e #21; branch `Issue-22`) |
| Banco | `supabase/postgres:17.6.1.136` (PG 17.6, locale `en_US` ICU). Antes: `postgres:16-alpine` (PG 16.15, `pt_BR`) |
| Pooler | Supavisor 2.9.13 em transaction mode; backend em `supabase-pooler:6543` com `prepareThreshold=0` |
| `max_connections` | 300 (`subir-host-rpm.ps1 -MaxConnections 300`) |
| Pool do Supavisor no Postgres | **245** (`max_connections − 55`); `POOLER_MAX_CLIENT_CONN` 1500 |
| HikariCP | `maximum-pool-size` 1000, `minimum-idle` 5 (só enfileira no pooler) |
| Role do app | `admin`, sem superuser |
| Estado do banco | **limpo** (volume novo) no começo da 1a |
| Braço e lag | por lag, o host foi reiniciado em `naive` e conferido com `printenv RESERVATION_READPATH READMODEL_AVAILABILITY_REFRESH_MS` |
| Gerador | EnzoAMD, 192.168.68.66; k6 v2.2.0; `psql` 16.15. Host: 192.168.68.57 |
| Quando | 2026-10-16, cerca de 21:38 a 21:49 (horário do gerador) |

Para comparação, a matriz anterior (pré-pooler) rodou no commit `569d1be`, com o backend direto no PG 16
(HikariCP até 1000 conexões, `max_connections` 300, e a role `admin` era superuser, então podia usar as ~300, inclusive as 3 reservadas) e com o banco
inchado pelas escadas do dia (~35 mil eventos e ~2 milhões de linhas em `walletevent`). Fonte:
`Projeto/carga/results/02-hikari/matriz-prepooler-20261016.csv` (versionado em `1fbe12b` como `matriz.csv`).

## Braço CAS (#12)

Média de 5 repetições, intervalo mín–máx entre parênteses.

| N | `confirmed` | `oversell` | p50 (ms) | p95 (ms) | p99 (ms) | Vazão (tentativas/s) |
|---|---|---|---|---|---|---|
| 100 | 20 em todas | 0 em todas | 84,0 | 103,9 (84,6–117,6) | 107,2 | 870,9 (752–1010) |
| 200 | 20 em todas | 0 em todas | 115,8 | 155,3 (125,5–203,7) | 160,8 | 1178,5 (901–1389) |

Sem `[FALHA CAS]`. A tolerância 0 vale nas duas métricas: `pending` ficou em 0 em todas.

## Braço ingênuo (#13)

| Lag (ms) | N | `oversell` média ± desvio | `oversell` mín–máx | Execuções no teto | `lag_obs_disparo` em ms, média (mín–máx) | p95, média (mín–máx) (ms) | Vazão média |
|---|---|---|---|---|---|---|---|
| 500 | 100 | 77,6 ± 5,4 | 68–80 | 4 de 5 | 241 (151–357) | 116,8 (87,0–146,0) | 746,5 |
| 500 | 200 | 116,0 ± 87,7 | 15–180 | 3 de 5 | 309 (192–428) | 137,5 (90,1–175,9) | 1219,0 |
| 2000 | 100 | 80 ± 0 | 80–80 | 5 de 5 | 1084 (307–1646) | 116,4 (83,9–156,0) | 780,1 |
| 2000 | 200 | 180 ± 0 | 180–180 | 5 de 5 | 1370 (880–1912) | 144,7 (118,0–170,3) | 1079,8 |
| 5000 | 100 | 76,8 ± 7,2 | 64–80 | 4 de 5 | 2729 (634–4677) | 137,0 (90,8–197,6) | 673,4 |
| 5000 | 200 | 180 ± 0 | 180–180 | 5 de 5 | 2762 (1044–4891) | 159,0 (139,8–190,7) | 1027,7 |
| 10000 | 100 | 80 ± 0 | 80–80 | 5 de 5 | 6211 (4479–7711) | 117,8 (96,9–141,5) | 720,8 |
| 10000 | 200 | 180 ± 0 | 180–180 | 5 de 5 | 4211 (802–9451) | 161,3 (148,8–179,2) | 981,5 |

O teto é `N − capacidade` (80 e 180): todos os clientes aceitos e confirmados. Somando os dois N, a média de
`lag_obs_disparo` fica perto de metade do lag configurado (275, 1227, 2746 e 5211 ms nos lags de 500, 2000, 5000 e
10000), como se espera de um disparo em fase aleatória do ciclo. No lag de 500 ms, `lag_obs_disparo` fica
entre 151 e 428 ms (e `lag_obs_max`, até 503); antes ficava entre 851 e 2095 ms.

### As 4 repetições abaixo do teto

| Lag (ms) | N | Rep | `confirmed` | `oversell` | `lag_obs_disparo` / `lag_obs_max` (ms) | Vazão (tentativas/s) |
|---|---|---|---|---|---|---|
| 500 | 100 | 5 | 88 | 68 | 295 / 295 | 885,0 |
| 500 | 200 | 2 | 35 | 15 | 193 / 503 | 1388,9 |
| 500 | 200 | 3 | 45 | 25 | 192 / 495 | 1801,8 |
| 5000 | 100 | 5 | 84 | 64 | 4677 / 5014 | 500,0 |

Nelas `confirmed < N`: parte dos clientes recebeu "lotado", o que só acontece se o read model passou a mostrar o
evento sem vagas no meio da rajada. É a leitura de um refresh que caiu dentro da janela da rajada, que dura de
~0,1 a ~0,2 s (N ÷ vazão). A janela de uma rajada é curta e, no lag de 500 ms, é uma fração relevante do ciclo,
por isso 3 das 4 ocorrências são nesse lag. A amostra (5 repetições por configuração, 10 por lag) é pequena para estimar
a probabilidade: a dispersão no lag de 500 ms com N = 200 (desvio de 87,7) mostra que a média sozinha engana.

As duas repetições do lag de 500 ms com N = 200 têm vazão acima das demais do grupo (1388,9 e 1801,8), o que eleva a
média do grupo (1219,0): os clientes rejeitados respondem mais rápido.

## Comparação com o pré-pooler (monólito + HikariCP)

### CAS

| N | p50 pré → pós (ms) | p95 pré → pós (ms) | p99 pré → pós (ms) | Vazão pré → pós (tentativas/s) |
|---|---|---|---|---|
| 100 | 44,3 → 84,0 | 53,7 → 103,9 (1,9×) | 55,4 → 107,2 | 1632,7 → 870,9 (−46,7%) |
| 200 | 59,2 → 115,8 | 77,1 → 155,3 (2,0×) | 81,1 → 160,8 | 2075,5 → 1178,5 (−43,2%) |

Os intervalos de p95 entre repetições não se sobrepõem (N = 100: 46,9–66,3 contra 84,6–117,6; N = 200:
64,5–86,2 contra 125,5–203,7). O overselling continua 0.

### Ingênuo

| Lag (ms) | N | `oversell` pré → pós (média) | p95 pré → pós (ms) | Vazão pré → pós | `lag_obs_disparo` pré → pós (ms) |
|---|---|---|---|---|---|
| 500 | 100 | 80 → 77,6 | 102,8 → 116,8 | 763,7 → 746,5 | 1714 → 241 |
| 500 | 200 | 180 → 116,0 | 118,1 → 137,5 | 1192,5 → 1219,0 | 1470 → 309 |
| 2000 | 100 | 80 → 80 | 95,2 → 116,4 | 859,4 → 780,1 | 2408 → 1084 |
| 2000 | 200 | 180 → 180 | 111,3 → 144,7 | 1302,0 → 1079,8 | 2678 → 1370 |
| 5000 | 100 | 80 → 76,8 | 92,3 → 137,0 | 884,0 → 673,4 | 3620 → 2729 |
| 5000 | 200 | 180 → 180 | 121,3 → 159,0 | 1221,2 → 1027,7 | 3344 → 2762 |
| 10000 | 100 | 80 → 80 | 95,9 → 117,8 | 813,5 → 720,8 | 5541 → 6211 |
| 10000 | 200 | 180 → 180 | 115,7 → 161,3 | 1224,4 → 981,5 | 6337 → 4211 |

O p95 do ingênuo subiu em todas as 8 configurações (de 14% a 48%) e a vazão caiu em 7 de 8 (a exceção é
lag 500 com N = 200, puxada pelas duas repetições com rejeição).

O overselling do ingênuo estava no teto em 40 de 40 execuções antes e está em 36 de 40 agora.

## As três mudanças simultâneas (e o banco)

O ponto 1 não difere do pré-pooler só pelo pooler. Mudaram juntos:

1. **A fila do pooler em transaction mode.** Entre o HikariCP e o Postgres há agora o Supavisor, um salto de rede
   a mais por transação e uma fila quando as conexões reais estão ocupadas. O transaction mode também exige
   `prepareThreshold=0`: sem prepared statements no servidor, cada instrução é parseada e planejada de novo.
2. **PG 16 → 17 e o locale** (`postgres:16-alpine`, `pt_BR` → `supabase/postgres:17.6`, `en_US` ICU).
3. **O teto real de conexões**: ~300 (HikariCP direto; a role `admin` era superuser e podia usar as 3 conexões reservadas) para 245
   (`max_connections − 55`).

E mudou o **estado do banco**: limpo agora, com ~35 mil eventos e ~2 milhões de `walletevent` antes.

Os dados não separam esses efeitos. Uma leitura plausível, mas **não medida**, é que o teto de 245 não limite estas rodadas:
no máximo 200 clientes (N) disputam ao mesmo tempo e cada reserva ou confirmação usa uma transação por vez. Para
separar de fato seriam necessárias rodadas extras, por exemplo **pooler com pool de ~300** (isola a mudança 3) ou **PG 17
sem pooler** (isola a mudança 1). Elas foram feitas em 2026-10-17 e estão em
[Isolamento do pooler e escada X pelo pooler](/testes/ponto-1/resultados-isolamento-escada-pospooler-2026-10-17).

## Cuidados na leitura

- **O banco limpo muda o ingênuo (provavelmente).** O refresh recalcula todos os eventos; com o banco pequeno, cada refresh é rápido e o ciclo
  real fica perto do lag configurado. É por isso que o `lag_obs_disparo` caiu e que a rajada passou a cruzar um refresh
  de vez em quando. Esse efeito acompanha o estado do banco; não foi isolado dos outros fatores (seção "As três mudanças simultâneas", acima).
- **O CAS não depende do lag.** O `lag_ms = 5000` do CAS só rotula a coluna; o lag observado dele não é uma variável do braço.
- **Latência absoluta inclui o RTT** do link do gerador (não subtraído, como na matriz anterior).
- **Uma rodada, um dia.** 5 repetições por configuração, sem repetir lags para melhorar a curva.
- **A escada de carga (limiar X)** não faz parte desta matriz. Foi refeita pelo pooler em 2026-10-17: X ≈ 78k RPM, contra
  97k da etapa de HikariCP direto
  ([resultados](/testes/ponto-1/resultados-isolamento-escada-pospooler-2026-10-17)).
- O gráfico se gera com
  `bash ../../docs/carga/harness/report-matriz.sh results/03-supabase-pooler/matriz.csv results/03-supabase-pooler/matriz.html`
  (de `Projeto/carga`); o HTML não é versionado.
