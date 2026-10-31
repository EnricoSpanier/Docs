---
sidebar_position: 5
---

# Isolamento do pooler e escada X pelo pooler: resultados de 2026-10-17

Duas coisas que a [matriz pós-pooler](/testes/ponto-1/resultados-matriz-pospooler-2026-10-16) deixou em aberto:

1. **Isolamento.** Separar o que, na piora do CAS depois do pooler, vem do teto de conexões e o que vem do Supavisor.
2. **Escada X** (limiar X) refeita **pelo pooler**.

Fontes, todas em `Projeto/carga/results/03-supabase-pooler/` (commit `7f30308`): `matriz-isola-pool300.csv`,
`matriz-isola-sem-pooler.csv` e `degraus-{28082,32105,33459}.csv` com seus `summary-degraus-*.json`. Todos os
agregados abaixo foram recalculados dos CSVs. Máquinas: ver [Escada de degraus: resultados de 2026-10-16](/testes/pre-serie/resultados-escada-2026-10-16).

## Resumo

- **O Supavisor responde pela maior parte da piora do CAS.** Sem ele (PG 17 direto), o p95 volta para perto do
  pré-pooler: igual com N = 200 e ~14 ms acima com N = 100. Esse resíduo é o PG 17 mais o banco limpo, sem separar os dois.
- **O teto de conexões explica uma parte menor.** De 245 para 300, o p95 com N = 200 cai de 155 para 120 ms; com N = 100 quase não muda.
- **X pelo pooler ≈ 78.000 RPM** (~1300 reservas/s), contra 97.000 antes: cerca de −20% no teto da linha quente de um evento.
- Overselling 0 nas 20 execuções de isolamento. Nenhum 5xx em nenhuma escada.
- São 5 repetições por bloco e os intervalos mín–máx se sobrepõem em parte; as comparações abaixo dizem quando.

## Condições

Dia 2026-10-17. Host 192.168.68.57 e gerador EnzoAMD 192.168.68.66 (k6 2.2.0), nas mesmas máquinas do doc anterior.

| Item | Valor |
|---|---|
| Commit (host) | `a8fc86a`, a `main` com a Fase 4, em todos os blocos |
| Braço | `cas`, HikariCP 1000 |
| Estado do banco | **volume novo** no começo de cada bloco |
| Studio, meta e kong | **parados** durante a carga, como no ponto 1 |
| Matrizes de isolamento | capacidade 20, 100% de confirmação, N ∈ \{100, 200\}, 5 repetições (mesmo protocolo do ponto 1) |
| Escadas | 200 usuários, `MAX_VUS` 3000, mapeamento sequencial (linha quente do `eventcap`, #113), 100% de confirmação, 60 s por degrau; pooler com pool **245** e `max_connections` 300 |

**(a) Isolamento do teto.** Pooler com pool de **300** e `max_connections` **355** (`MaxConnections − 55`, a mesma regra do ponto 1).

**(b) Isolamento do pooler.** PG 17 **sem pooler**: o backend conectou direto em `db:5432`, com `max_connections` 300 e HikariCP 1000.
Foi feito por um override local do compose, **não versionado**:

```yaml
services:
  backend:
    environment:
      SPRING_DATASOURCE_URL: jdbc:postgresql://db:5432/meu_banco
      SPRING_DATASOURCE_USERNAME: ${POSTGRES_USER}
```

Conferido em `pg_stat_activity` que as conexões da role `admin` vinham do IP do backend.

## Isolamento (matriz CAS, média de 5 repetições)

p95 em ms, com mín–máx entre parênteses; vazão em tentativas/s.

| Bloco | O que muda | N | p50 | p95 | p99 | Vazão |
|---|---|---|---|---|---|---|
| Pré-pooler (`02-hikari/matriz-prepooler-20261016.csv`) | PG 16 direto, banco inchado | 100 | 44,3 | 53,7 (46,9–66,3) | 55,4 | 1632,7 |
| | | 200 | 59,2 | 77,1 (64,5–86,2) | 81,1 | 2075,5 |
| Ponto 1 (`matriz.csv`) | PG 17 + pooler 245 | 100 | 84,0 | 103,9 (84,6–117,6) | 107,2 | 870,9 |
| | | 200 | 115,8 | 155,3 (125,5–203,7) | 160,8 | 1178,5 |
| (a) pooler 300 | só o teto 245 → 300 | 100 | 79,6 | 96,0 (82,1–103,9) | 97,4 | 965,1 |
| | | 200 | 96,3 | 119,9 (102,0–140,5) | 124,6 | 1462,6 |
| (b) PG 17 sem pooler | tira o Supavisor | 100 | 58,3 | 67,4 (58,1–79,7) | 69,7 | 1333,1 |
| | | 200 | 63,2 | 77,1 (64,3–91,5) | 80,6 | 2140,7 |

`confirmed` = 20 e `pending` = 0 nas 10 execuções de cada bloco; `oversell` = 0 em todas.

### Leitura

- **Pooler (b contra o ponto 1).** Tirar o Supavisor derruba o p95 de 103,9 para 67,4 ms (N = 100) e de 155,3 para 77,1 ms
  (N = 200), e a vazão sobe de 870,9 para 1333,1 e de 1178,5 para 2140,7. Os intervalos de p95 **não se sobrepõem**
  (58,1–79,7 contra 84,6–117,6; 64,3–91,5 contra 125,5–203,7). É o efeito dominante.
- **(b contra o pré-pooler).** Com N = 200, p95 idêntico (77,1) e intervalos que se sobrepõem; vazão +3%. Com N = 100, p95
  13,7 ms acima (67,4 contra 53,7), intervalos com sobreposição pequena (58,1–66,3) e vazão −18%. O resíduo é a soma de
  PG 16 → 17 (com outro locale) e banco limpo × inchado; **os dados não separam os dois**.
- **Teto (a contra o ponto 1).** Com N = 200, p95 de 155,3 para 119,9 ms (−23%) e vazão de 1178,5 para 1462,6 (+24%), mas os
  intervalos se sobrepõem (125,5–140,5). Com N = 100, 103,9 para 96,0 ms, com sobreposição quase total. O teto pesa
  algo, mais com N = 200, e muito menos que o Supavisor: (a) continua longe de (b) (102,0–140,5 contra 64,3–91,5, sem sobreposição).
- **Por que o teto pesa só com N = 200.** Hipótese, **não medida**: com mais clientes simultâneos (cada reserva e cada
  confirmação ocupam uma conexão real por transação), a fila de 245 conexões começa a aparecer.
- Cautela: 5 repetições, uma rodada por bloco. A ordem de grandeza é firme (o pooler); a divisão fina do resto não é.

## Escadas pelo pooler

Braço `cas`, todos os degraus com `taxa_5xx` = 0 e `erros_5xx_confirma` = 0. Colunas: RPM alvo e efetivo,
p95 da reserva, pior janela de 30 s (`p95_max_janela_30s`, a que decide o X), descartes (`iteracoes_descartadas`) e `outros`
(erros de cliente). Gerador sem saturar: CPU ≤ 73% e RAM livre ≥ 4,5 GB (observação do operador; não está nos CSVs).

### `28082`: 20k → 55k, passo 5k, **sem** `netsh`

| RPM alvo | Efetivo | p95 (ms) | Pior janela (ms) | Descartes | `outros` |
|---|---|---|---|---|---|
| 20.000 | 20.000 | 7,7 | 8,1 | 0 | 0 |
| 25.000 | 25.000 | 5,4 | 5,6 | 0 | 0 |
| 30.000 | 30.000 | 5,2 | 5,5 | 0 | 0 |
| 35.000 | 35.000 | 7,7 | 7,9 | 0 | 0 |
| 40.000 | 40.001 | 29,0 | 36,2 | 0 | 0 |
| 45.000 | 45.001 | 55,5 | 61,5 | 0 | 0 |
| 50.000 | 50.001 | 97,4 | 97,6 | 0 | 0 |
| 55.000 | 55.000 | 153,3 | 169,1 | 0 | **2021** |

De 20k a 50k, tudo limpo; o p95 fica em ~5–8 ms até 35k e sobe a partir de 40k. O degrau de **55k está contaminado**:
2021 erros de porta efêmera do cliente (o gerador não tinha o `netsh`), então não vale como medida do host.

### `32105`: 50k → 130k, passo 10k, com `netsh` no gerador

| RPM alvo | Efetivo | p95 (ms) | Pior janela (ms) | Descartes | Descartes (%) |
|---|---|---|---|---|---|
| 50.000 | 50.001 | 250,0 | 366,5 | 0 | 0 |
| 60.000 | 60.000 | 188,1 | 191,6 | 0 | 0 |
| 70.000 | 70.001 | 341,2 | 391,7 | 0 | 0 |
| 80.000 | 75.336 | 1835,2 | 1865,5 | 4665 | 5,8 |
| 90.000 | 75.762 | 1846,2 | 1856,4 | 14.239 | 15,8 |
| 100.000 | 77.266 | 1804,5 | 1810,5 | 22.734 | 22,7 |
| 110.000 | 75.233 | 1885,1 | 1891,0 | 34.767 | 31,6 |
| 120.000 | 75.163 | 1873,0 | 1885,9 | 44.838 | 37,4 |
| 130.000 | 74.609 | 1896,0 | 1916,0 | 55.391 | 42,6 |

Limpo até 70k. Em 80k satura, e de 80k a 130k o efetivo fica parado em ~74,6–77,3k, com p95 de ~1,8–1,9 s. Os descartes
vêm do teto de 3000 VUs: uma iteração (reserva e confirmação) leva ~1,8 s, e só pode durar até `3000 ÷ (RPM/60)` s
(2,25 s a 80k) antes de faltar VU. O limite é a latência do host, não o gerador.

### `33459`: refinamento 70k → 80k, passo 1k

| RPM alvo | Efetivo | p95 (ms) | Pior janela (ms) | Descartes | Descartes (%) |
|---|---|---|---|---|---|
| 70.000 | 69.486 | 1890,7 | 1981,9 | 514 | 0,7 |
| 71.000 | 71.001 | 950,0 | 1002,9 | 0 | 0 |
| 72.000 | 72.001 | 440,6 | 490,1 | 0 | 0 |
| 73.000 | 73.001 | 336,2 | 368,3 | 0 | 0 |
| 74.000 | 74.001 | 717,1 | 764,1 | 0 | 0 |
| 75.000 | 75.001 | 1128,2 | 1170,3 | 0 | 0 |
| 76.000 | 76.001 | 697,2 | 729,9 | 0 | 0 |
| 77.000 | 77.001 | 850,4 | 889,8 | 0 | 0 |
| 78.000 | 75.501 | 1860,2 | 1906,8 | 2500 | 3,2 |
| 79.000 | 72.905 | 1919,3 | 1939,9 | 6096 | 7,7 |
| 80.000 | 74.599 | 1862,3 | 1949,3 | 5401 | 6,8 |

- O primeiro degrau (70k) degradou, mas é **aquecimento depois do seed**: na `32105` o mesmo 70k ficou limpo.
- De 71k a 77k não há descartes e o p95 de janela oscila entre 368 e 1170 ms; **71k (1002,9) e 75k (1170,3) passam de 1 s**
  por pouco e por um degrau só, e o seguinte volta abaixo.
- De 78k em diante a saturação é sustentada: efetivo de ~72,9–75,5k, descartes de 3% a 8% e p95 de janela em ~1,9 s.

## O X

**X pelo pooler ≈ 78.000 RPM** (~1300 reservas/s): primeiro degrau de saturação sustentada. O último degrau sem descartes é
77k (p95 de janela de 0,89 s), e o joelho fica entre 74k e 78k. É o mesmo critério de leitura do X pré-pooler (97k, que também
teve um pico pontual no degrau de 97k antes de estabilizar acima de 1 s em 98k–100k).

| | Pré-pooler | Pelo pooler |
|---|---|---|
| X (RPM) | 97.000 (`958305`) | ≈ 78.000 (`32105` e `33459`) |
| Em reservas/s | ~1650 | ~1300 |
| Variação | | cerca de −20% |

Leituras possíveis dão valores um pouco diferentes, e vale dizê-las:

- Pela regra estrita do runner (primeiro degrau com p95 de janela > 1 s), a `32105` dá X = 80k e a `33459` dá "X = 70k" (aquecimento).
  O veredito automático da `33459` ("X = 70k") está **contaminado** pelo aquecimento e não é usado.
- Ignorando o aquecimento, o 71k da `33459` passa do limite por 2,9 ms. Dentro de 71k–77k há degraus acima e abaixo de 1 s sem
  tendência, o que é compatível com ruído de medição e não com saturação (não há descarte, e o efetivo acompanha o alvo).
- A saturação de verdade (efetivo parado e descartes) começa em 78k na `33459` e em 80k na `32105`; 78k é o menor dos dois.

O X continua sendo o **da linha quente de um evento** (mapeamento sequencial: 200 reservas seguidas no mesmo `eventcap`),
não a capacidade agregada do host (#113). Não há 5xx: ao saturar, o host fica lento.

**Impacto nas regras de autoescala 50/80 (#111 e #112).** Elas usam o X como base. Pelo pooler, a base passa a ser
**≈ 78k RPM**, não 97k. As issues não foram alteradas.

## Ruídos a registrar

- **Aquecimento no primeiro degrau.** O 70k da `33459` degradou (p95 de janela de 1981,9 ms, 514 descartes) e o da `32105` não.
- **p95 de 50k maior que o de 60k na `32105`** (366,5 ms de janela contra 191,6). Sem causa medida; o 50k é o primeiro degrau da
  escada. E na `28082` o mesmo 50k deu 97,6 ms: a mesma taxa varia ~4× entre execuções, o que dá a ordem de grandeza do ruído da latência abaixo da saturação.
- **Veredito automático da `33459`** ("X = 70k"): contaminado pelo aquecimento, não usado.
- **`28082`, degrau de 55k:** 2021 erros de porta do cliente (sem `netsh`). A `32105` e a `33459` rodaram com o
  `netsh` aplicado no gerador (range de portas 10000/55535) e tiveram 0 `outros`/erros de porta.
- **Uma escada, um dia, um evento por vez.** Como no pré-pooler, cada X vem de uma execução (aqui, de três) e o estado do host
  naquele dia. O banco começou novo em cada escada.

## Threads do Tomcat e virtual threads (2026-10-17, tarde)

Mesma condição do ponto 1 (pooler com pool 245, `max_connections` 300, Hikari 1000, `cas`, banco limpo por
bloco). Só muda o modelo de threads do backend, via override local não versionado:
`SPRING_THREADS_VIRTUAL_ENABLED=true` (virtual threads) ou `SERVER_TOMCAT_THREADS_MAX=300|400` (threads de
plataforma; o padrão do Spring Boot é 200). Arquivos em `Projeto/carga/results/03-supabase-pooler/`.

**Matriz CAS** (média de 5 repetições, mín–máx; oversell 0 em todas):

| Configuração | p95 N=100 (ms) | p95 N=200 (ms) | Vazão N=200 (res/s) |
|---|---|---|---|
| Tomcat 200 (ponto 1, `matriz.csv`) | 103,9 (84,6–117,6) | 155,3 (125,5–203,7) | 1178,5 |
| **Tomcat 300** (`matriz-tomcat300.csv`) | **91,9** (74,8–118,3) | **114,4** (99,5–124,5) | 1514,7 |
| Tomcat 400 (`matriz-tomcat400.csv`) | 98,2 (79,5–118,1) | 121,0 (105,1–139,2) | 1442,4 |
| Virtual threads (`matriz-virtual-threads.csv`) | 98,0 (83,5–111,4) | 117,8 (108,1–131,3) | 1484,7 |

**Escada 50k → 100k** (p95 de janela em ms · efetivo):

| RPM alvo | Tomcat 200 (`32105`) | Tomcat 300 (`39710`) | Tomcat 400 (`40664`) | Virtual threads (`38530`) |
|---|---|---|---|---|
| 50.000 | 366,5 · 50.001 | 187,8 · 50.001 | 226,8 · 50.001 | 209,5 · 50.000 |
| 60.000 | 191,6 · 60.000 | 180,4 · 60.001 | 203,3 · 60.001 | 516,0 · 60.000 |
| 70.000 | 391,7 · 70.001 | 319,1 · 70.000 | 508,7 · 70.000 | 1011,9 · 70.001 |
| 80.000 | 1865,5 · 75.336 | 1929,9 · 75.412 | 1985,4 · 73.288 | 1530,1 · 80.001 |
| 90.000 | 1856,4 · 75.762 | 1981,7 · 74.232 | 1948,7 · 75.312 | 1645,4 · 90.001 |
| 100.000 | 1810,5 · 77.266 | 1954,5 · 74.064 | 1972,8 · 74.281 | 2736,2 · 99.132 |

0 erros 5xx em todas. Descartes de 80k a 100k: Tomcat 200/300/400 ~4,6–25,9 mil por degrau; virtual threads
só 869 em 100k.

**Leitura:**

- **200, 300 e 400 threads dão o mesmo teto** (~74–77k efetivos, X = 80k): o número de threads de plataforma
  não é o gargalo nessa faixa.
- **Virtual threads passam do teto** (~99k efetivos, +28% de vazão, de volta ao teto pré-pooler de ~1650 res/s)
  porque deixam mais requisições em voo, mas o p95 cresce antes (X por p95 > 1 s cai para 70k): trocam latência
  por vazão.
- **Tomcat 300 tem o menor p95**, tanto na matriz (N=200: 155 → 114 ms) quanto abaixo do joelho da escada.
- **Decisão do usuário (2026-10-17):** priorizar a menor latência: virtual threads desligadas e teto de
  threads do Tomcat em 300 (issue a criar). O ponto 1 da série foi medido com 200.
