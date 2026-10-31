# Experimento de reserva concorrente no monólito: reserva por CAS × caminho ingênuo

> **Status: rascunho de seção do artigo (issue #15).** Os resultados das rodadas 1a e 1b e da escada de
> carga (issues #12, #13 e #14) foram preenchidos com as rodadas de 2026-10-16. O **ponto 1 da série** (monólito
> CRUD + pooler) foi medido depois, com as rodadas 1a e 1b repetidas com o Supavisor (issue #22). Em 2026-10-17 vieram
> as rodadas de isolamento do pooler e a escada X pelo pooler. O **ponto 2 da série** (monólito com CQRS + ES, issue #31)
> foi medido em 2026-10-19, com o braço ingênuo lendo a projeção assíncrona real. O **limiar X definitivo, por evento**
> (issue #40), veio da Rodada R de 2026-10-28, na configuração final distribuída (subseção "Limiar X definitivo").
> Revisão com o orientador pendente. Caminhos de arquivo são relativos à raiz do repositório (nos comandos
> `make`, relativos a `Projeto/carga`); os termos seguem o glossário de `CONTEXT.md`.
>
> **Escopo dos números.** Há três conjuntos, que **não se misturam**:
>
> - **Ponto 1 (pós-pooler, "monólito CRUD + pooler").** As rodadas 1a e 1b repetidas em 2026-10-16 com o
>   Supabase Postgres 17 e o Supavisor (issue #22). É a linha de base oficial da série de 3 pontos (`CONTEXT.md`,
>   "Ponto da série"): subseção "Ponto 1 (pós-pooler)" dos Resultados. A escada X pelo pooler (X ≈ 78k RPM) e as
>   rodadas de isolamento foram feitas em 2026-10-17 (subseções "Isolamento do pooler" e "Limiar X pelo pooler").
> - **Ponto 2 (CQRS + ES no monólito, Rodada 2).** A matriz CAS × ingênuo, as escadas X e o aleatório de 45 min repetidos
>   em 2026-10-19 (issue #31) com `catalog` e `reservation` em event sourcing, relay e consumer no Redpanda, e o braço
>   ingênuo lendo a projeção assíncrona: subseção "Ponto 2 (CQRS + ES no monólito, Rodada 2, 2026-10-19)" dos
>   Resultados. Compara-se com o ponto 1, não com o pré-pooler. O lag é medido, não configurado.
> - **Pré-pooler (referência, "monólito + HikariCP").** A matriz 1a/1b anterior e a escada de carga (limiar X),
>   com o backend direto no PG 16 (pool e `max_connections` informados no Setup). Ficam como histórico e como
>   comparação. O X pré-pooler (97k) é a referência do X pelo pooler.
>
> A subseção "Comparação das 3 configurações" (issue #39) **junta esses conjuntos de propósito**, lado a lado, com tabela e
> gráficos e com as ressalvas dela (rede, disco e código diferentes entre os pontos; o X intercalado da Rodada R não é comparável
> com os X sequenciais).

## Hipótese

O experimento compara dois **braços**, isto é, duas formas de checar a capacidade (`capacity`) de um evento
numa reserva (`walletevent`):

- **Reserva por CAS** (caminho `cas`, o padrão): dentro de uma única transação, um `UPDATE` condicional
  atômico em `eventcap` (`quant = quant - 1 ... AND quant >= 1`; zero linhas afetadas significa "lotado")
  e, só então, a gravação da reserva como `pending`. O design proposto.
- **Caminho ingênuo** (`naive`): lê o read model defasado `event_availability` e depois insere a reserva,
  sem CAS e sem tocar `eventcap`. O read model é recalculado por um job periódico (`ReadModelRefreshService`)
  cujo intervalo é o **lag** (`READMODEL_AVAILABILITY_REFRESH_MS`). O braço de controle.

A fundamentação está em `docs/adr/Architecture-Decision-Stock-Isolation.md`: ler a quantidade e só depois
decidir a escrita abre uma condição de corrida, e a correção é transformar "checar e reservar" numa única
operação atômica na fonte de verdade; checar a capacidade por uma projeção eventualmente consistente
reintroduz o overselling. O experimento é o diferencial do trabalho (`docs/adr/Architecture-Decision-Microservices-Split.md`):
roda primeiro contra o monólito, com um read model sintético (tabela desnormalizada, refresh por timer e
caminho de leitura atrás de feature flag), e é repetido a cada marco de arquitetura, formando a série de
3 pontos. Esta seção cobre a Fase 2, o monólito CRUD com read model sintético.

Hipóteses testáveis:

- **H1 (CAS).** O braço CAS tem overselling zero em toda **disputa**, para todo N testado, nas duas
  métricas (primária e secundária), com tolerância 0. Uma única execução do braço CAS com
  `confirmed > capacity` ou `pending + confirmed > capacity` refuta H1 e seria um defeito do CAS, não ruído
  de medição.
- **H2 (ingênuo).** O caminho ingênuo oversella, e o overselling cresce com o lag, pois um refresh mais
  espaçado deixa a leitura de vagas mais desatualizada por mais tempo (`Projeto/Backend/CLAUDE.md`:
  "Oversella proporcional ao lag do read model"; `Projeto/carga/README.md`: "overselling proporcional ao
  lag"). Por construção, cada cliente tenta uma vez, então o overselling de uma disputa é limitado por
  N − capacidade (80 para N = 100; 180 para N = 200): um patamar nesse teto para lags grandes é compatível com
  H2. H2 é enfraquecida se o overselling for zero, ou se não crescer com o lag antes de atingir o teto. O
  resultado é reportado como medido, sem repetir rodadas nem descartar lags para "achar" a tendência
  (`Projeto/carga/README.md`, rodada 1b).
- **Limiar X.** Não é uma hipótese sobre um valor, e sim uma medição: o primeiro degrau de carga em que o
  fluxo síncrono degrada. Pode não existir dentro da escada ("X acima do último degrau") ou valer só como
  limite inferior, se o gerador saturar antes do host.

## Setup

**Topologia.** Duas máquinas na mesma rede (`docs/carga/setup.md`): o **host** (alvo do teste: stack Docker
com backend em `:8081` e Postgres em `:5433`) e o **gerador** (roda o k6). O k6 nunca roda no host, pois
competiria por CPU e rede com o backend e invalidaria as latências. O link do gerador é de 1 Gbps; do lado do
host só está registrado "Ethernet, mesma rede do gerador". A matriz também consulta o Postgres do host pelo
gerador, por `psql` remoto na `:5433`, porta aberta apenas para o IP do gerador (`Projeto/carga/README.md`).

| Item | Host (alvo) | Gerador |
|---|---|---|
| CPU / RAM / disco | AMD Ryzen 7 7700X (8 núcleos / 16 threads), 63 GB de RAM (31 GB e 16 CPUs para a VM do Docker), SSD NVMe | AMD Ryzen 5 7600 (6 núcleos / 6 threads, SMT desligado), 15,2 GB de RAM (DDR5-5200), SSD NVMe |
| SO | Windows 11 Home (build 26300) | Windows 11 Pro (build 26200), plano de energia "Alto desempenho" |
| Rede | Ethernet a 1 Gbps, por cabo, mesma rede do gerador | Ethernet a 1 Gbps, por cabo |
| Ferramentas | Docker Desktop (engine 29.8.2) | k6 v2.2.0 (go1.26.5, windows/amd64); `psql` 16.15 |

Configuração levantada em 2026-10-16, dia das escadas da #14. Fontes: `docs/carga/setup.md` (seção 5),
`Projeto/carga/results/01-sem-pool/baseline-20261004-122632.txt` e `Projeto/carga/results/02-hikari/smoke-20261016/baseline-20261016-162438.txt`.

**Versões e configuração do backend e do banco (pré-pooler, referência).**

| Componente | Valor |
|---|---|
| PostgreSQL | 16.15 (imagem `postgres:16-alpine`, `Projeto/Backend/db/Dockerfile`) |
| Backend | Spring Boot 3.5.7, Java 21 na compilação e `temurin:25-jre` na execução (`Projeto/Backend/CLAUDE.md`) |
| HikariCP | 6.3.3 (gerenciada pelo Spring Boot; lida do jar do backend); `maximum-pool-size` padrão 1000 e `minimum-idle` 5 (o pool cresce sob demanda) |
| `max_connections` do Postgres | Escadas da #14: **100** até a `degraus-959190` (o `make setup-host` sobe o Postgres com o padrão) e **1000** nas `degraus-959765`, `-962591` e `-963487` (`make host-rpm MAX_CONN=1000`), valores lidos no host com `SHOW max_connections`. A coluna `max_connections` dos CSVs é só um rótulo passado ao gerador e diz 300 nas escadas com 100: vale o valor medido no host. `pool_hikari` = 1000 em todas. O `matriz.csv` não grava esses campos: nas rodadas 1a e 1b o host rodou com **300** (`make host-rpm MAX_CONN=300`, conferido com `SHOW max_connections`) e Tomcat com 200 threads (padrão). |
| Braço e lag | `RESERVATION_READPATH` (`cas` \| `naive`) e `READMODEL_AVAILABILITY_REFRESH_MS`, lidos no startup do backend (`Projeto/carga/docker-compose.carga.yml`); log de SQL desligado no host de carga para não distorcer a latência |
| Commit testado | coluna `commit` dos CSVs (checkout do gerador); host e gerador no mesmo commit: `5120412` em todas as escadas da #14 (a `degraus-963487` rodou com o `.js` editado localmente, ver "Limiar X"); `569d1be` nas 50 linhas da matriz (rodadas 1a e 1b), sem mudança de código em relação ao `5120412` |

**Condições do ponto 1 (pós-pooler).** Mesmas máquinas e mesmo protocolo da matriz; mudaram o banco, o pooler
e o estado do banco. Rodadas de 2026-10-16, por volta de 21:38 a 21:49 (horário do gerador).

| Componente | Valor |
|---|---|
| Commit | `8ba01b4` (`Fase_4` com as issues #17, #18, #19 e #21; branch `Issue-22`), host e gerador |
| PostgreSQL | 17.6 (imagem `supabase/postgres:17.6.1.136`, locale `en_US` ICU); antes, 16.15 (`postgres:16-alpine`, `pt_BR`) |
| Pooler | Supavisor 2.9.13 em transaction mode; o backend conecta em `supabase-pooler:6543` com `prepareThreshold=0` |
| Conexões | `max_connections` 300 (`subir-host-rpm.ps1 -MaxConnections 300`); pool do Supavisor no Postgres **245** (`max_connections − 55`); `POOLER_MAX_CLIENT_CONN` 1500; HikariCP `maximum-pool-size` 1000 e `minimum-idle` 5 (só enfileira no pooler) |
| Threads do Tomcat | **200** (padrão do Spring Boot): o ponto 1 foi medido assim; a partir do ponto 2 o backend usa **300** (issue #124; no teste de 2026-10-17 pelo pooler, mesmo teto de vazão, menor p95) |
| Role do app | `admin`, sem superuser |
| Estado do banco | **limpo** (volume novo) no começo da rodada 1a |
| Braço e lag | por lag, o host foi reiniciado em `naive` e conferido com `printenv RESERVATION_READPATH READMODEL_AVAILABILITY_REFRESH_MS` |
| Ferramentas do gerador | k6 v2.2.0; `psql` 16.15 |

Fonte: `Projeto/carga/results/03-supabase-pooler/README.md`. O CSV não grava essas colunas.

**Condições do ponto 2 (Rodada 2, CQRS + ES).** Mesmas máquinas e mesmo protocolo; mudaram o código, a rede e o estado
do banco. Rodadas de 2026-10-19. Fonte: `Projeto/carga/results/04-fase6-es/README.md` e
`baseline-20261019-074604.txt`.

| Componente | Valor |
|---|---|
| Commit | `1ee6fbe` (`main` com o merge do PR #145, Fase 6), host e gerador. No bloco 5 o backend rodou uma imagem local `:146`, montada com as classes da branch `Issue-146`; a coluna `commit` dos CSVs continua `1ee6fbe` |
| Conexões e Tomcat | `max_connections` 300; pool do Supavisor 245; HikariCP 1000; Tomcat com **300** threads (o ponto 1 usou 200) |
| Event backbone | Redpanda em modo dev-container (sem fsync), só na rede `gerenciador-net`; relay e consumer ligados no backend; no bloco 5, consumer em lote (até 500 mensagens por transação) e, no 3b, consumer desligado (`EVENTS_CONSUMER_ENABLED=false`, override local não versionado) |
| Rede | **Wi-Fi**, com IPs novos (o host trocou de IP durante a sessão). Baseline: HTTP p50 26,6 / p95 42,9 ms (n = 30), ping médio 18,55 ms (máx. 180 ms, 0 de 100 perdidos); nas rodadas anteriores, no cabo, ~14,9 / 19 ms |
| Estado do banco | **Acumulado** nos blocos 1 a 3b (matrizes ingênuo e CAS, escadas com e sem consumer, sem limpeza entre eles); **limpo antes de cada teste** do bloco 4 em diante (TRUNCATE em todas as tabelas, tópicos e consumer group do Redpanda apagados, backend reiniciado) |
| Braço e lag | `RESERVATION_READPATH` `naive` (bloco 1) e `cas` (demais); `lag_ms` = 0 (não há mais timer) |
| Ferramentas do gerador | AMD Ryzen 5 7600, k6 v2.2.0, `psql` 16.15, plano de energia "Alto desempenho" ativado à mão, portas dinâmicas TCP `start=10000 num=55535` |

**Latência base HTTP (não comparável; não subtraída).** O `setup-gerador.ps1` mediu, em 2026-10-04, 30
requisições `GET /actuator/health` cronometradas com `Stopwatch` em torno de `Invoke-WebRequest` (PowerShell):
p50 14,9 / p95 19,0 / máx 21,1 ms, numa única medição (`docs/carga/setup.md`, seção 5). Esse valor vem de
outro cliente que não o k6 e de um endpoint que consulta o Postgres; portanto não é a latência de rede (RTT) e
não é comparável ao tempo de requisição do k6 (excede, por exemplo, a latência de reserva medida pelo k6 nas
rodadas preliminares). Por isso **não é subtraído**: as latências do k6 são reportadas como medidas, com o RTT
embutido e não isolado. Nessas rodadas (até o ponto 1) o ICMP não respondeu (100 pacotes sem retorno), então não há
ping nem perda de pacotes; no ponto 2 o ping respondeu (ver "Condições do ponto 2", acima). Nova medição em 2026-10-16, antes das escadas da #14, pelo mesmo método: p50 14,7 / p95 18,2 / máx
20,1 ms (n = 30; `Projeto/carga/results/02-hikari/smoke-20261016/baseline-20261016-162438.txt`); de novo maior que a
latência de reserva do k6 nos degraus baixos (p95 de 7,7 a 10,9 ms na `degraus-953959`).

## Workload

### Disputa (rodadas 1a e 1b, matriz)

A unidade de execução do experimento de corretude é a **disputa**: N clientes concorrentes, cada um com
usuário próprio, tentam reservar o mesmo evento de `capacity` 20. Cada cliente faz uma tentativa
(`POST /bff/event-wallets`) e toda reserva aceita (201) é confirmada na mesma iteração
(`POST /bff/event-wallets/confirm`, `PCT_CONFIRMA=100`). No k6, é um cenário `shared-iterations` com um VU
por cliente; o login dos usuários (bcrypt) acontece no `setup()`, antes da rajada e fora da medição
(`Projeto/carga/carga.js`).

Cada chamada do runner (`Projeto/carga/rodar-matriz.ps1`) faz, nesta ordem:

1. um aquecimento descartado, uma vez por chamada e antes do seed do primeiro N (rajada pequena, evento
   próprio, sem linha no CSV);
2. por N, o seed: N usuários e um evento novo por repetição, todos com a mesma capacidade;
3. por repetição (um evento novo cada), espera o read model ter a linha do evento e depois um tempo aleatório
   em `[0, lag)`, de modo que a rajada caia numa fase pseudoaleatória do job de refresh, sem se sincronizar
   com ele;
4. dispara a rajada e, enquanto ela roda, amostra o lag no Postgres do host;
5. lê `confirmed` e `pending` do evento no Postgres e grava uma linha em `Projeto/carga/results/matriz.csv` (a área de trabalho da rodada corrente; ao fechar a etapa o
   CSV vai para `results/NN-etapa/`, ver Resultados).

| Rodada | Braço | N | Lag (ms) | Repetições | Linhas |
|---|---|---|---|---|---|
| 1a (#12) | `cas` | \{100, 200\} | 5000 (só rotula a coluna: o CAS não lê o read model) | 5 | 10 |
| 1b (#13) | `naive` | \{100, 200\} | \{500, 2000, 5000, 10000\} | 5 | 40 |

O total é de 50 linhas no mesmo CSV, nas duas matrizes (pré-pooler e ponto 1). O lag e o braço são lidos no startup do backend e não mudam em
runtime, então a rodada 1b reinicia a stack do host uma vez por lag (`make host-rpm`), e o valor passado ao
gerador apenas rotula as colunas `braco` e `lag_ms`: ele precisa bater com o que o host roda, o que se confere
com `docker exec gerenciador-backend printenv RESERVATION_READPATH READMODEL_AVAILABILITY_REFRESH_MS`.

Uma repetição só vira linha do CSV se for **válida**: k6 com código 0, resumo com `disparo_ms` (alguma
iteração rodou), nenhum usuário sem login, nenhuma resposta inesperada ou 5xx e toda reserva aceita
confirmada. Repetição inválida é descartada, contada e
listada no fim, e o runner sai com código 2 (matriz incompleta, refazer). Já o overselling no braço CAS não
invalida nada: é um resultado, entra no CSV e o runner sai com código 3.

### Escada de carga (limiar X, #14)

Uma única execução do k6, com um cenário `constant-arrival-rate` por degrau (seed e login uma vez só), que
estende o teste de taxa fixa (`Projeto/carga/README.md`, "Limiar X preliminar", e
`Projeto/carga/degraus/carga-degraus.js`):

- degraus a partir de 12k RPM (`DEG_INICIO`), de 4k em 4k (`DEG_PASSO`), até `DEG_MAX` (padrão 40k; no máximo
  40 degraus), 60 s por degrau (`DEG_DURACAO`, no mínimo 60 e múltiplo de 30);
- braço CAS (`READPATH=cas`) nos comandos do protocolo, 200 usuários, `MAX_VUS` 2000 (todos pré-alocados) e
  `PCT_CONFIRMA=100`;
- cada reserva é um par (usuário, evento) único, em sequência (usuário `i % U`, evento `floor(i / U)`), com
  capacidade por evento igual à metade dos usuários (padrão de `Projeto/carga/degraus/rodar-degraus.ps1`;
  100 com 200 usuários);
- só `POST` de reserva e de confirmação, sem leituras;
- no padrão (12k a 40k): 8 degraus, 208.008 pares, 1.093 eventos e cerca de 11,6 min de k6, com 31 s ociosos
  entre degraus;
- a escada vai até o máximo, mesmo depois de o host degradar.

## Métricas

As definições seguem `CONTEXT.md`. A tabela diz como cada uma é coletada.

| Métrica | Definição | Coleta |
|---|---|---|
| **Overselling primário** | Evento com `confirmed` maior que `capacity`. Coluna `oversell` = `max(0, confirmed − capacity)`, a magnitude. | `psql` remoto no Postgres do host (fonte de verdade), depois da rajada. |
| **Overselling secundário** | `pending + confirmed` maior que `capacity`. Derivável das colunas `pending` e `confirmed`. | Mesma leitura. |
| **Tolerância no braço CAS** | 0 nas duas métricas: igual a `capacity` passa; maior falha (código 3 do runner). | Verificada pelo runner a cada execução. |
| **Lag** | Intervalo de refresh do read model (`READMODEL_AVAILABILITY_REFRESH_MS`); coluna `lag_ms`. É a variável independente do braço ingênuo **no ponto 1**; no ponto 2 não há timer, `lag_ms` vale 0 e o lag é medido (`Lag observado`). O job usa `fixedDelay`, então o período efetivo é o lag mais a duração de cada refresh. | Configurado no host; rotulado no CSV. |
| **Lag observado** | `lag_obs_disparo` (última amostra antes do disparo) e `lag_obs_max` (maior valor entre essa amostra e as da rajada); `-1` = sem leitura. | Ponto 1: `now() − refreshed_at` do evento (relógio do Postgres). **Ponto 2:** `applied_at − last_occurred_at` da linha do evento em `event_availability`, isto é, a idade do último evento aplicado pelo consumer; a linha só nasce com a 1ª reserva, então `lag_obs_disparo` vale -1 sempre e só `lag_obs_max` traz leitura, como limite inferior (ameaça 20). Nos dois, amostrado a cada ~250 ms (`-PollMs`) pelo gerador por `psql` remoto; o instante da amostra é o do relógio do gerador, o mesmo do k6. |
| **Latência da reserva** | p50, p95 e p99 de `POST /bff/event-wallets`, em ms. | k6 no gerador; reportada como medida, sem subtrair a latência base HTTP (ver Setup: não é comparável). |
| **Vazão** | Matriz: tentativas por segundo na janela da rajada (1ª iteração iniciada até a última terminada), sem os logins do `setup()`. Escada: reservas por segundo respondidas sem 5xx. | k6 (resumo da execução). |
| **Taxa de 5xx** | `erros_5xx / reservas` (só os 5xx da reserva, sobre as reservas do degrau), como fração. Os 5xx da confirmação ficam em `erros_5xx_confirma`, informativos, fora do X. Respostas inesperadas (4xx fora de "lotado", timeout, conexão recusada) vão para `outros` e não entram em X. | k6, por degrau. |
| **p95 por janela de 30 s** | `p95_max_janela_30s`: maior p95 da reserva entre as janelas de 30 s do degrau. | k6: cada reserva é marcada pela janela do instante de **envio**; janelas fixas alinhadas ao início do degrau. |
| **Limiar X** | Primeiro degrau da escada com 5xx acima de 1% das reservas ou p95 acima de 1 s por 30 s. | Regra aplicada só pelo report (`docs/carga/harness/report-degraus.sh`), sobre o CSV. |

Detalhes de coleta que afetam a leitura:

- Os dois limites do X são estritos (`taxa_5xx` > 1%; `p95_max_janela_30s` > 1000 ms).
- A taxa de 5xx do X é só da reserva (5xx das reservas / reservas do degrau): o X marca o ponto em que a reserva
  passaria a ir para a fila, e os 5xx da confirmação não entram, mas ficam registrados em `erros_5xx_confirma`.
- O gerador é considerado **saturado** num degrau se `iteracoes_descartadas > 0` ou se `rpm_efetivo` ficar abaixo
  de 95% do alvo. Se ele saturou estritamente antes do primeiro degrau que degradou, X vira **limite inferior**
  (X maior que o último degrau sem saturação). Se degradou e saturou no mesmo degrau, X é firme, com aviso.
- O overselling é medido no banco, não pela contagem de respostas do cliente, que é só indicativa.
- O lag observado tem a resolução do intervalo de amostragem e a rajada é curta, então `lag_obs_max` costuma
  igualar `lag_obs_disparo`.
- Agregação (`docs/carga/harness/report-matriz.sh`): por (N, capacidade), média, ±1 desvio amostral e mín–máx
  das repetições em cada lag, eixo x linear em ms; o braço CAS, que não depende do lag, entra como linha de
  referência (média de todas as suas execuções).
- **Ponto da série**: medição do experimento em um marco da arquitetura (monólito CRUD, monólito ES,
  distribuído). O ponto 1 é o "monólito CRUD + pooler" (subseção "Ponto 1 (pós-pooler)"); os números de
  "monólito + HikariCP" são a referência pré-pooler, não o ponto 1.

## Resultados

Mapa das fontes: a rodada 1a (#12) e a rodada 1b (#13) alimentam o mesmo `matriz.csv` (linhas `braco=cas` e
`braco=naive`). O runner grava em `Projeto/carga/results/matriz.csv` e, ao fechar a etapa, o arquivo é movido para a
pasta dela: o **ponto 1** está em `Projeto/carga/results/03-supabase-pooler/matriz.csv` (50 linhas, commit
`12fc154`) e a matriz **pré-pooler** em `Projeto/carga/results/02-hikari/matriz-prepooler-20261016.csv` (50 linhas,
versionado em `1fbe12b` como `matriz.csv`). O gráfico de cada etapa sai de `report-matriz.sh` sobre o CSV dela
(HTML regenerável, fora do git; `Projeto/carga/README.md`, "Resultados"). A escada (#14) gera
`Projeto/carga/results/02-hikari/degraus-<id>.csv` e `summary-degraus-<id>.json` (a escada pelo pooler, em `03-supabase-pooler/`); o gráfico sai de
`make report-degraus`. Resultado como medido: lags e execuções não são descartados nem repetidos para
melhorar a curva (só as repetições inválidas são refeitas, pelas regras do runner). O **ponto 2** (Rodada 2,
`Projeto/carga/results/04-fase6-es/`) vem depois do "Limiar X pelo pooler", na subseção "Ponto 2 (CQRS + ES no monólito,
Rodada 2, 2026-10-19)".

### Ponto 1 (pós-pooler): overselling × lag e latência

Rodadas de 2026-10-16 com o Supabase Postgres 17 e o Supavisor (condições no Setup), capacidade 20, 100% de
confirmação, commit `8ba01b4`. Fonte: `Projeto/carga/results/03-supabase-pooler/matriz.csv` (50 linhas, commit
`12fc154`); detalhe e tabelas completas em `docs/carga/resultados-matriz-pospooler-2026-10-16.md`. Nenhuma
repetição foi descartada. Os agregados foram recalculados do CSV.

**Braço CAS (rodada 1a, #12).** `oversell = 0` nas 10 linhas, com `confirmed = 20` e `pending = 0` em todas: **H1
se sustenta** no ponto 1. Latência e vazão, com a comparação com o pré-pooler (média de 5 repetições; p95 com
mín–máx):

| N | p50 pré → pós (ms) | p95 pré → pós (ms) | p99 pré → pós (ms) | Vazão pré → pós (tentativas/s) |
|---|---|---|---|---|
| 100 | 44,3 → 84,0 | 53,7 (46,9–66,3) → 103,9 (84,6–117,6) | 55,4 → 107,2 | 1632,7 → 870,9 (−46,7%) |
| 200 | 59,2 → 115,8 | 77,1 (64,5–86,2) → 155,3 (125,5–203,7) | 81,1 → 160,8 | 2075,5 → 1178,5 (−43,2%) |

A latência do CAS **piorou** cerca de 2× e a vazão caiu 43% a 47%; os intervalos de p95 entre repetições não se
sobrepõem. Esse resultado mistura **três mudanças simultâneas** (a fila do pooler em transaction mode; PG 16 → 17
com outro locale; teto real de conexões de ~300 para 245) e também o estado do banco (limpo agora, inchado antes).
**Não se atribui o aumento ao pooler.** Os efeitos foram separados em rodadas de isolamento no dia seguinte (subseção "Isolamento do pooler", abaixo; ameaça 14).

**Braço ingênuo (rodada 1b, #13).**

| Lag (ms) | N | `oversell` média ± desvio | `oversell` mín–máx | Execuções no teto | `lag_obs_disparo` médio (ms) | p95 da reserva, média (mín–máx) (ms) | Vazão média (tentativas/s) |
|---|---|---|---|---|---|---|---|
| 500 | 100 | 77,6 ± 5,4 | 68–80 | 4 de 5 | 241 | 116,8 (87,0–146,0) | 746,5 |
| 500 | 200 | 116,0 ± 87,7 | 15–180 | 3 de 5 | 309 | 137,5 (90,1–175,9) | 1219,0 |
| 2000 | 100 | 80 ± 0 | 80–80 | 5 de 5 | 1084 | 116,4 (83,9–156,0) | 780,1 |
| 2000 | 200 | 180 ± 0 | 180–180 | 5 de 5 | 1370 | 144,7 (118,0–170,3) | 1079,8 |
| 5000 | 100 | 76,8 ± 7,2 | 64–80 | 4 de 5 | 2729 | 137,0 (90,8–197,6) | 673,4 |
| 5000 | 200 | 180 ± 0 | 180–180 | 5 de 5 | 2762 | 159,0 (139,8–190,7) | 1027,7 |
| 10000 | 100 | 80 ± 0 | 80–80 | 5 de 5 | 6211 | 117,8 (96,9–141,5) | 720,8 |
| 10000 | 200 | 180 ± 0 | 180–180 | 5 de 5 | 4211 | 161,3 (148,8–179,2) | 981,5 |

![Overselling médio por lag no ponto 1 (pós-pooler), capacity 20, duas faixas de N. CAS: 0 em todas as execuções (medido só no lag de 5000 ms; a linha tracejada o repete nos demais). Ingênuo, N = 100: 77,6 (lag 500 ms), 80 (2000), 76,8 (5000) e 80 (10000); N = 200: 116 (500, desvio 87,7, mínimo 15 e máximo 180) e 180 nos demais lags.](graficos/matriz-pooler.svg)

*Figura: overselling × lag, ponto 1 (média das 5 repetições; barra = ±1 desvio, que pode passar do teto N − capacity, linha fina = mín–máx). Regenerável com `graficos/gera-graficos-fase2.sh`.*

**O lag observado passou a respeitar o configurado.** Com o banco limpo, no lag de 500 ms o `lag_obs_disparo` ficou
entre 151 e 428 ms (média de 275; `lag_obs_max` até 503), contra 851–2095 ms (média de 1592) na matriz
pré-pooler. Nos demais lags, a média do `lag_obs_disparo` (1227, 2746 e 5211 ms) fica perto de metade do lag, como se
espera de um disparo em fase aleatória do ciclo.

**O overselling deixou de estar sempre no teto.** Em 36 das 40 repetições o overselling ficou no teto `N − capacidade`
(80 e 180), como antes. Em 4 a rajada atravessou um refresh que "fechou" o evento no meio (`confirmed < N`, isto é,
parte dos clientes recebeu "lotado"):

| Lag (ms) | N | Rep | `confirmed` | `oversell` | `lag_obs_disparo` / `lag_obs_max` (ms) |
|---|---|---|---|---|---|
| 500 | 100 | 5 | 88 | 68 | 295 / 295 |
| 500 | 200 | 2 | 35 | 15 | 193 / 503 |
| 500 | 200 | 3 | 45 | 25 | 192 / 495 |
| 5000 | 100 | 5 | 84 | 64 | 4677 / 5014 |

O braço de controle continua com overselling em todos os lags, e a dependência da fase do refresh, que a hipótese
previa, antes ficava escondida pelo lag inflado. A leitura é qualitativa: com 5 repetições por configuração e
desvio de até 87,7 (lag 500, N = 200), a amostra não permite ajustar uma curva nem estimar a probabilidade de a
rajada cruzar um refresh. Dentro desse limite, o resultado é compatível com H2 para N = 200 (116,0 no lag de 500
ms e 180 a partir de 2000 ms), mas não mostra tendência monotônica para N = 100 (77,6, 80, 76,8 e 80), e uma
repetição do lag de 5000 ms também ficou abaixo do teto.

**Comparação do ingênuo com o pré-pooler.** O p95 da reserva subiu nas 8 configurações (de 14% a 48%) e a vazão caiu em 7
de 8 (a exceção, lag 500 com N = 200, é puxada pelas duas repetições com rejeição, que respondem mais rápido). As
mesmas três mudanças simultâneas e o banco limpo valem para essa comparação.

### Isolamento do pooler (2026-10-17)

Duas matrizes CAS extras, com o mesmo protocolo (capacidade 20, N ∈ \{100, 200\}, 5 repetições), host na `main` `a8fc86a`,
HikariCP 1000, banco novo em cada bloco e Studio, meta e kong parados durante a carga. **(a) Pooler com pool de 300**
(`max_connections` 355): muda só o teto de conexões. **(b) PG 17 sem pooler**: o backend direto em `db:5432` (override
local do compose, não versionado, descrito no doc de resultados), `max_connections` 300: tira o Supavisor. Fonte:
`Projeto/carga/results/03-supabase-pooler/matriz-isola-pool300.csv` e `matriz-isola-sem-pooler.csv`; tabelas completas em
`docs/carga/resultados-isolamento-escada-pospooler-2026-10-17.md`. Média de 5 repetições, p95 com mín–máx; recalculado dos CSVs:

| Bloco | N | p95 (ms) | Vazão (tentativas/s) |
|---|---|---|---|
| Pré-pooler (PG 16 direto) | 100 | 53,7 (46,9–66,3) | 1632,7 |
| | 200 | 77,1 (64,5–86,2) | 2075,5 |
| Ponto 1 (pooler 245) | 100 | 103,9 (84,6–117,6) | 870,9 |
| | 200 | 155,3 (125,5–203,7) | 1178,5 |
| (a) pooler 300 | 100 | 96,0 (82,1–103,9) | 965,1 |
| | 200 | 119,9 (102,0–140,5) | 1462,6 |
| (b) PG 17 sem pooler | 100 | 67,4 (58,1–79,7) | 1333,1 |
| | 200 | 77,1 (64,3–91,5) | 2140,7 |

`oversell` = 0 nas 20 execuções de isolamento (H1 se sustenta). Leitura:

- **O Supavisor responde pela maior parte da piora.** Sem ele, o p95 fica próximo do pré-pooler: igual com N = 200 e
  ~14 ms acima com N = 100. Os intervalos de (b) não se sobrepõem aos do ponto 1. O resíduo é o PG 17 junto com o banco
  limpo, **sem separar os dois**.
- **O teto de conexões explica uma parte menor.** De 245 para 300, o p95 com N = 200 cai de 155 para 120 ms, mas os
  intervalos se sobrepõem em parte; com N = 100 quase não muda. (a) continua longe de (b).
- São 5 repetições por bloco e os intervalos se sobrepõem em parte; a ordem de grandeza (o pooler) é firme, a divisão
  fina do resto não.

### Overselling × lag, pré-pooler (referência: monólito + HikariCP)

Rodadas de 2026-10-16 (anteriores ao pooler), capacidade 20, 100% de confirmação, `max_connections` 300, commit
`569d1be`. Fonte: `Projeto/carga/results/02-hikari/matriz-prepooler-20261016.csv` (50 linhas; versionado em
`1fbe12b` como `matriz.csv`); gráfico regenerável com `report-matriz.sh` sobre esse CSV.
Nenhuma repetição foi descartada nos dois braços.

**Braço CAS (rodada 1a, #12).** `oversell = 0` nas 10 linhas (N ∈ \{100, 200\} × 5 repetições), com
`confirmed = 20` e `pending = 0` em todas: exatamente a capacidade, nenhuma a mais. Sem `[FALHA CAS]` (código
de saída 0). p95 da reserva: média de 53,7 ms (46,9–66,3) com N = 100 e 77,1 ms (64,5–86,2) com N = 200.

**Braço ingênuo (rodada 1b, #13).**

| Lag (ms) | N | `oversell` média ± desvio | `oversell` mín–máx | `lag_obs_disparo` médio (ms) | p95 da reserva, média (mín–máx) (ms) |
|---|---|---|---|---|---|
| 500 | 100 | 80 ± 0 | 80–80 | 1714 | 102,8 (77,3–135,2) |
| 500 | 200 | 180 ± 0 | 180–180 | 1470 | 118,1 (113,3–127,7) |
| 2000 | 100 | 80 ± 0 | 80–80 | 2408 | 95,2 (61,5–170,6) |
| 2000 | 200 | 180 ± 0 | 180–180 | 2678 | 111,3 (99,4–133,5) |
| 5000 | 100 | 80 ± 0 | 80–80 | 3620 | 92,3 (68,1–140,4) |
| 5000 | 200 | 180 ± 0 | 180–180 | 3344 | 121,3 (104,4–139,4) |
| 10000 | 100 | 80 ± 0 | 80–80 | 5541 | 95,9 (74,6–139,3) |
| 10000 | 200 | 180 ± 0 | 180–180 | 6337 | 115,7 (98,9–145,1) |

![Overselling médio por lag na matriz pré-pooler (monólito + HikariCP), capacity 20. CAS: 0 em todas as execuções (medido só no lag de 5000 ms; a linha tracejada o repete nos demais). Ingênuo: 80 com N = 100 e 180 com N = 200 nos quatro lags (500, 2000, 5000 e 10000 ms), sem variação com o lag.](graficos/matriz-prepooler.svg)

*Figura: overselling × lag, pré-pooler (média das 5 repetições; desvio zero em todos os pontos). Regenerável com `graficos/gera-graficos-fase2.sh`.*

**Forma observada: patamar no teto N − capacidade, sem variação com o lag.** Em todas as 40 execuções todos
os N clientes foram aceitos e confirmaram (`confirmed = N`), então o overselling é sempre o máximo possível
(80 e 180) e o desvio é zero. A hipótese de que o overselling cresce com o lag **não foi observada** nesta
faixa: a rajada dura de ~0,1 a 0,2 s (N ÷ vazão, com vazão de 518 a 1449 tentativas por segundo), menos que o menor período
efetivo de refresh, então o read model nunca reflete a lotação durante a rajada, em nenhum lag. Para ver a
curva subir seria preciso um lag menor que a duração da rajada ou rajadas espalhadas no tempo (não testado).

**Lag observado acima do configurado.** No lag de 500 ms, o `lag_obs_disparo` médio ficou em ~1,5–1,7 s; nos
lags maiores, em ~metade do lag, como se espera de um disparo em fase aleatória do ciclo. O período efetivo é o
lag mais a duração do refresh (`fixedDelay`), e o refresh recalcula a disponibilidade de **todos** os eventos.
No dia das rodadas, o banco do host acumulava ~35 mil eventos e ~2 milhões de linhas em `walletevent` das
escadas da #14, o que alonga cada refresh. O lag de 500 ms, portanto, não foi atingido de fato. O resultado
não muda (o teto já é atingido), mas a coluna `lag_ms` deve ser lida junto com `lag_obs_disparo`. No ponto 1, com o
banco limpo, o lag observado voltou a acompanhar o configurado e o teto deixou de ser universal (acima).

### Limiar X (escada de carga, pré-pooler: referência)

Escadas de 2026-10-16, braço CAS, 200 usuários, **antes do pooler** (HikariCP direto no PG 16; referência: a escada pelo pooler vem na subseção seguinte). Fonte: `Projeto/carga/results/02-hikari/degraus-<id>.csv` e
`summary-degraus-<id>.json` (commit `5caac91`); veredito de `make report-degraus`. Em **todas** as escadas:
`taxa_5xx = 0` e `erros_5xx_confirma = 0`. O host nunca respondeu 5xx: quando satura, ele fica lento e o critério
que dispara é o p95 por janela de 30 s.

**Escada do protocolo (`degraus-953959`, 12k → 40k, 2000 VUs, `max_connections` 100).** Nenhum degrau
degradou: **X > 40.000 RPM (acima do último degrau)**. p95 de 7,7 a 10,9 ms, 0 descartes, gerador sem
saturação. Como o protocolo não achou o X, as escadas seguintes estenderam a faixa. Essa extensão foi
decidida depois de ver o resultado, então está **fora do pré-registro**.

**Escadas estendidas (fora do pré-registro).**

| Escada | Faixa (RPM) | VUs | `max_connections` (host) | Veredito | Observação |
|---|---|---|---|---|---|
| `degraus-954833` | 50k → 120k | 2000 | 100 | X > 100k, **limite inferior** | gerador esgotou as portas efêmeras do Windows a partir de 60k (`outros` = erros de cliente); descartado como medida do host |
| `degraus-956799` | 60k → 130k | 3000 | 100 | **X = 100.000** | p95 de janela de 1339,8 ms; rpm efetivo estaciona em 97–99,8k |
| `degraus-958305` | 95k → 100k, passo 1k | 3000 | 100 | **X = 97.000**; último degrau limpo 96.000 | 97k teve pico isolado (p95 de janela de 4254,3 ms); 98k–100k estáveis em ~1,3 s |
| `degraus-959190` | 96k → 97k, **60% de confirmação** | 3000 | 100 | X > 97.000 | p95 de 205,8 / 216,2 ms: com 40% menos confirmações o host passa no X |
| `degraus-959765` | 60k → 130k | 3000 | 1000 | **X = 100.000** | rpm efetivo de 94–95k; mais conexões não subiram o teto |
| `degraus-962591` | 95k (diagnóstico) | 3000 | 1000 | — | Tomcat com 400 threads (override local): p95 de 582,2 ms contra 242,5 ms com 200 threads e 100 conexões |
| `degraus-963487` | 100k → 160k, passo 20k | 3000 | 1000 | 120k e 140k limpos | mapeamento **intercalado** (ver abaixo); em 160k o gerador saturou (portas, VUs, CPU de 99%) |

Degraus da escada que define o X (`degraus-956799`), em ms:

| `rpm_alvo` | `rpm_efetivo` | `taxa_5xx` | `p95` | `p95_max_janela_30s` | `throughput` (reservas/s) | `iteracoes_descartadas` |
|---|---|---|---|---|---|---|
| 60.000 | 60.001 | 0 | 105,6 | 126,0 | 1000,0 | 0 |
| 70.000 | 70.001 | 0 | 122,4 | 125,0 | 1166,7 | 0 |
| 80.000 | 80.001 | 0 | 177,7 | 178,2 | 1333,4 | 0 |
| 90.000 | 90.001 | 0 | 221,6 | 235,5 | 1500,0 | 0 |
| 100.000 | 99.033 | 0 | 1315,9 | 1339,8 | 1650,6 | 967 |
| 110.000 | 99.784 | 0 | 1351,8 | 1369,8 | 1663,1 | 10.218 |
| 120.000 | 97.156 | 0 | 1405,7 | 1406,6 | 1619,3 | 22.845 |
| 130.000 | 98.139 | 0 | 1396,5 | 1422,1 | 1635,7 | 31.862 |

![Escada de 60k a 130k RPM pré-pooler (degraus-956799): o p95 da pior janela de 30 s fica entre 125,0 e 235,5 ms até 90k e passa a 1339,8 ms em 100k (X = 100.000, traço vertical), 1369,8, 1406,6 e 1422,1 ms em 110k, 120k e 130k; o throughput estaciona em ~1650 reservas/s (1650,6 em 100k) e a taxa de 5xx é 0 em todos os degraus.](graficos/escada-prepooler-956799.svg)

*Figura: escada larga pré-pooler (`degraus-956799`), a mesma tabela acima.*

![Escada fina de 95k a 100k RPM pré-pooler (degraus-958305), passo de 1k: o p95 da pior janela de 30 s é 259,1 ms em 95k e 494,4 ms em 96k, salta para 4254,3 ms em 97k (X = 97.000, traço vertical, com 10.459 descartes e RPM efetivo de 86.542) e fica em 1391,7, 1361,3 e 1315,9 ms em 98k, 99k e 100k; taxa de 5xx 0 em todos os degraus.](graficos/escada-prepooler-958305.svg)

*Figura: escada fina pré-pooler (`degraus-958305`), a que localiza o X = 97.000 usado na comparação das 3 configurações. Regenerável com `graficos/gera-graficos-fase2.sh`.*

Os descartes a partir de 100k vêm da latência do host: com os VUs pré-alocados, só há descarte quando a
iteração passa de `MAX_VUS ÷ (RPM/60)` s. O gerador ficou com CPU de no máximo 66% e mais de 4 GB livres. O
report marca X como firme, com aviso de descartes no mesmo degrau.

**Causa do teto: contenção na linha do `eventcap`.** Nem conexões (100 → 1000) nem threads do Tomcat
(200 → 400) subiram o teto; as duas mudanças só aumentaram a latência na saturação. O container do backend
não tem limite de CPU (a JVM enxerga 16 CPUs) e ficou em ~420–470%. Durante a `degraus-962591`, o Postgres
tinha 162 sessões em `LWLock:LockManager`, 119 em `Lock:transactionid` e 90 em `Lock:tuple` (amostra de
`pg_stat_activity` no host). O motivo está no mapeamento da escada: a iteração `i` usa o evento `floor(i / U)`,
então 200 reservas seguidas fazem o `UPDATE` condicional (CAS) na **mesma linha** de `eventcap`, e essas
atualizações se serializam. Com o mapeamento intercalado (evento `i % E`, `.js` editado só localmente para o
diagnóstico e revertido; a coluna `commit` não reflete a edição), as esperas por lock de linha somem (só
sobra `LWLock:WALWrite`) e o host sustenta **120k e 140k RPM** com p95 de 317,1 e 262,7 ms.

**Leitura.** O X medido, ≈ 97–100k RPM (~1650 reservas/s), é a vazão de **um evento disputado** no CAS
(todas as reservas no mesmo `eventcap`), não a capacidade do host. Com a carga espalhada entre eventos, o
host passa de 140k RPM, e esse teto não é mensurável com um único gerador. Como o gargalo é uma linha do banco,
adicionar réplicas do backend não deve subir o X de um evento disputado (hipótese, não medida). A opção de
mapeamento na escada é a issue #113.

### Limiar X pelo pooler (2026-10-17)

Três escadas do braço CAS, 200 usuários, `MAX_VUS` 3000, mapeamento sequencial (a mesma linha quente do `eventcap`),
pooler com pool 245 e `max_connections` 300, host na `main` `a8fc86a`, banco novo em cada escada, Studio, meta e kong
parados. Fonte: `Projeto/carga/results/03-supabase-pooler/degraus-<id>.csv` e `summary-degraus-<id>.json`; um degrau por
tabela em `docs/carga/resultados-isolamento-escada-pospooler-2026-10-17.md`. Nenhum 5xx (reserva ou confirmação) em
nenhum degrau.

| Escada | Faixa (RPM) | Resultado |
|---|---|---|
| `degraus-28082` | 20k → 55k, passo 5k, sem `netsh` | 20k–50k limpos; p95 de janela de 5–8 ms até 35k, depois 36 ms (40k), 62 ms (45k) e 98 ms (50k). O degrau de 55k está **contaminado** por 2021 erros de porta do cliente |
| `degraus-32105` | 50k → 130k, passo 10k, com `netsh` | limpo até 70k (janelas de 366, 192 e 392 ms). Satura em 80k (efetivo 75,3k, p95 de janela de 1865 ms, 5,8% de descartes) e de 80k a 130k o efetivo estaciona em ~74,6–77,3k, p95 de ~1,8–1,9 s |
| `degraus-33459` | 70k → 80k, passo 1k | 70k degradou (janela de 1982 ms, 514 descartes): aquecimento depois do seed, pois na `32105` o mesmo 70k ficou limpo. De 71k a 77k sem descartes e janela entre 368 e 1170 ms (71k e 75k passam de 1 s por pouco). De 78k em diante, saturação sustentada: efetivo de ~72,9–75,5k, descartes de 3% a 8%, janela de ~1,9 s |

![Escada fina de 70k a 80k RPM pelo pooler (degraus-33459), passo de 1k: o p95 da pior janela de 30 s é 1981,9 ms em 70k (aquecimento: o veredito automático do report, X = 70.000, esmaecido na figura e rotulado "não usado", não vale), cai para 368,3 ms em 73k, fica entre 368,3 e 1170,3 ms de 71k a 77k (1002,9 em 71k e 1170,3 em 75k acima de 1 s) e sobe para 1906,8, 1939,9 e 1869,0 ms em 78k, 79k e 80k, com RPM efetivo de 75.501, 72.905 e 74.599 e descartes de 2500, 6096 e 5401; taxa de 5xx 0 em todos os degraus. O X adotado, 78.000, tem traço sólido rotulado "X adotado" nos três painéis.](graficos/escada-pooler-33459.svg)

*Figura: escada fina pelo pooler (`degraus-33459`). O traço sólido marca o X adotado, ≈ 78.000, o primeiro degrau de saturação sustentada; o traço esmaecido (70k) é o veredito automático do report, contaminado pelo aquecimento e não usado. Regenerável com `graficos/gera-graficos-fase2.sh`.*

**X pelo pooler ≈ 78.000 RPM** (~1300 reservas/s): primeiro degrau de saturação sustentada (último degrau sem descartes:
77k, janela de ~0,9 s; joelho entre 74k e 78k). É o mesmo critério de leitura do X pré-pooler, ≈ 97.000 (referência, com
pico pontual em 97k), e dá cerca de **−20%** no teto da linha quente de um evento. O veredito automático do runner na
`33459` ("X = 70k") está contaminado pelo aquecimento e não é usado; pela regra estrita da `32105`, X seria 80k.

Ruídos: o aquecimento no 1º degrau; o p95 de 50k maior que o de 60k na `32105` (e, no mesmo 50k, 98 ms na `28082`, ~4×
menor); o degrau de 55k da `28082`. O gerador não saturou (CPU ≤ 73%, RAM livre ≥ 4,5 GB, observação do operador): os
descartes vêm do teto de 3000 VUs com iterações de ~1,8 s, isto é, da latência do host.

Como no pré-pooler, o X é o **da linha quente de um evento** (mapeamento sequencial), não a capacidade agregada do host
(#113). **Impacto:** as regras de autoescala 50/80 (#111 e #112), que usam o X, passam a ter como base ≈ 78k pelo pooler,
não 97k (as issues não foram alteradas).

### Ponto 2 (CQRS + ES no monólito, Rodada 2, 2026-10-19)

Rodada 2 do experimento (issue #31), contra a `main` em `1ee6fbe` (merge do PR #145, Fase 6), capacidade 20 e 100% de
confirmação. As condições estão em "Condições do ponto 2" (Setup). Fonte: `Projeto/carga/results/04-fase6-es/` (o
`README.md` da etapa descreve os 6 blocos; `matriz-naive.csv`, `matriz-cas.csv`, `degraus-*.csv`,
`resultados-aleatorio.csv` e as amostras de lag do host em `host-lag/`). Nenhuma repetição foi descartada. Os agregados
foram recalculados dos CSVs. As ressalvas da rodada (Wi-Fi, banco acumulado em parte dos blocos, imagem local da #146)
estão nas ameaças 16 a 21 e valem para toda a subseção. Compara-se com o ponto 1 (subseções anteriores), com o
pré-pooler só como referência do X.

**O que mudou em relação ao ponto 1.**

- `catalog` e o lado wallet de `reservation` passaram a event sourcing: cada command grava o evento no `event_store` e
  no `event_outbox` na mesma transação do estado (`docs/arquitetura/fase6-cqrs-es.md`). O `eventcap` e o CAS continuam
  relacionais e síncronos.
- O **relay** (outbox → Redpanda) e o **consumer** (tópico → projeção) rodam no processo do backend. O broker é um
  Redpanda em modo dev-container, só na rede interna do compose.
- O braço `naive` deixou de ler um read model recalculado por timer: lê a projeção assíncrona `event_availability`,
  alimentada pelo consumer do tópico. O `ReadModelRefreshService` saiu.
- O **lag virou variável medida**, não controlada (`docs/adr/Architecture-Decision-Event-Backbone-Event-Store.md`,
  seção 4). A coluna `lag_ms` vale sempre 0; o `lag_obs_*` é a idade do último evento aplicado na linha do evento
  (`applied_at − last_occurred_at`), amostrada pelo gerador durante a rajada (definição em Métricas). A variável
  independente passa a ser a carga (N concorrentes na matriz).
- O braço `cas` não mudou. O runner da matriz espera o pipeline ficar ocioso (`Wait-Estavel`) antes de cada repetição.

**Overselling × lag.** Matrizes de N ∈ \{100, 200\}, 5 repetições cada, nos dois braços (20 linhas):

| Braço | N | `confirmed` | `oversell` | `lag_obs_max` com leitura (ms) |
|---|---|---|---|---|
| `naive` | 100 | 100 em todas | 80 em todas (teto) | 19 a 171 (4 de 5 repetições) |
| `naive` | 200 | 200 em todas | 180 em todas (teto) | 53 a 280 (3 de 5) |
| `cas` | 100 | 20 em todas | 0 em todas | 61 a 112 (4 de 5) |
| `cas` | 200 | 20 em todas | 0 em todas | 110 a 116 (2 de 5) |

- **CAS: `oversell = 0` nas 10 linhas**, com `confirmed = 20` e `pending = 0` em todas (80 e 180 clientes recusados como
  lotado). H1 se sustenta no ponto 2. 0 erros 5xx nos dois braços.
- **Ingênuo: overselling máximo nas 10 repetições** (80 com N = 100; 180 com N = 200), com todos os N clientes aceitos e
  confirmados. No ponto 1 o ingênuo oversellou nas 40 repetições, mas ficou no teto em 36 de 40 (quatro rajadas
  atravessaram um refresh); no pré-pooler, no teto em 40 de 40. Com a projeção real, o teto voltou a ser universal.
- **A hipótese H2 (overselling cresce com o lag) não pode mais ser testada pelo lag**, porque o lag deixou de ser
  configurado. O que a rodada mostra é o outro lado: com o lag que o pipeline de fato tem (append → relay → Redpanda →
  consumer), a janela basta para o overselling ser total, isto é, no teto em 10 de 10 repetições. O `lag_obs` de 19 a
  280 ms que acompanha esse resultado é um limite inferior (ameaça 20).
- **Lag observado.** Das 20 linhas, 13 têm `lag_obs_max` com leitura, entre 19 e 280 ms (média de 116,5 ms; 129,4 no
  ingênuo e 101,3 no CAS). `lag_obs_disparo` vale -1 nas 20, e isso é **estrutural, não um achado**: a linha do evento
  na projeção só nasce com a primeira reserva, e o disparo usa a última amostra anterior à rajada (`rodar-matriz.ps1`,
  comentário acima de `Wait-Evento`; `lib-matriz.ps1`, `Get-LagRajada`). Em 7 linhas (3 do ingênuo, 4 do CAS) nem
  `lag_obs_max` teve leitura, isto é, a linha do evento não apareceu na projeção durante a amostragem. **O `lag_obs` é
  um limite inferior** do atraso da projeção: mede a idade do último evento já aplicado, não quanto a projeção está
  atrás do "agora", e só existe depois do primeiro evento aplicado.
- **Lag de consumer do host.** Na amostra `host-lag/lag-poll-cas-*` (80 amostras em cerca de 2 min, nomeada para a matriz
  CAS; a cobertura completa da matriz não foi conferida), o offset lag do grupo chegou a no máximo 21 mensagens e o
  `event_outbox` a no máximo 3. Para o ingênuo não há amostra do host.

**Latência e vazão das matrizes.** Média de 5 repetições, comparada com o ponto 1 (`03-supabase-pooler/matriz.csv`,
Tomcat 200, banco limpo, cabo). Para o ingênuo, o ponto 1 é a média das 20 repetições (4 lags × 5), pois o lag não
tem efeito mensurável sobre p50, p95 e vazão no ponto 1. O p95 do ponto 2 vem com mín–máx:

| Braço | N | p50 ponto 1 → 2 (ms) | p95 ponto 1 → 2 (ms) | Vazão ponto 1 → 2 (tentativas/s) |
|---|---|---|---|---|
| `cas` | 100 | 84,0 → 107,6 | 103,9 → 130,9 (118,9–147,2) | 870,9 → 555,8 (−36,2%) |
| `cas` | 200 | 115,8 → 132,6 | 155,3 → 166,1 (139,3–216,1) | 1178,5 → 813,2 (−31,0%) |
| `naive` | 100 | 74,0 → 65,2 | 122,0 → 112,8 (70,3–150,2) | 730,2 → 547,6 (−25,0%) |
| `naive` | 200 | 86,7 → 99,5 | 150,6 → 184,3 (164,5–223,8) | 1077,0 → 707,9 (−34,3%) |

- **CAS:** o p95 sobe 26% com N = 100 e 7% com N = 200; neste último os intervalos de p95 entre repetições se
  sobrepõem (125,5–203,7 no ponto 1; 139,3–216,1 no ponto 2), então a diferença não é firme. A vazão cai de 31% a 36%.
- **Ingênuo:** o p95 muda −8% com N = 100 (intervalos sobrepostos) e +22% com N = 200; a vazão cai de 25% a 34%.
- **A comparação certa do CAS é com o Tomcat 300.** O ponto 1 foi medido com 200 threads, e o ponto 2 com 300. A matriz
  CAS do ponto 1 refeita com 300 threads (`03-supabase-pooler/matriz-tomcat300.csv`, 2026-10-17) deu p50 de 75,3 e
  92,6 ms, p95 de 91,9 e 114,4 ms e vazão de 1006,3 e 1514,7 tentativas/s (N = 100 e 200). Contra essa linha, o CAS do
  ponto 2 tem p95 cerca de 42% (N = 100) e 45% (N = 200) maior, e a vazão com N = 200 é 46% menor.
- **O que não se atribui ao ES:** a queda de vazão e o aumento de latência vêm junto de três fatores que mudaram ao
  mesmo tempo: o append do evento no caminho quente, a rede em Wi-Fi (baseline de HTTP de 26,6 / 42,9 ms, contra
  ~15 / 19 ms no cabo) e o banco acumulado dos blocos 1 e 2 (ameaças 16 e 17). Os dados não separam os três. O
  overselling, ao contrário, está no teto (ingênuo) ou em zero (CAS) em qualquer um desses cenários.

**Limiar X: o custo por camada.** Escada do braço CAS, 200 usuários, `MAX_VUS` 3000, mapeamento sequencial (a mesma
linha quente do `eventcap` de todas as escadas anteriores), degraus de 60 s, 0 erros 5xx em todos os degraus de todas
as escadas. O X segue o critério do resto do artigo, o **primeiro degrau de saturação sustentada**: um pico isolado
(um degrau acima de 1 s entre degraus abaixo de 1 s) não conta, como os 71k e 75k do pós-pooler. As camadas **não diferem só
pelo que foi ligado no host**: ver o bullet "O que não se atribui ao ES".

| Camada | X (RPM) | Escada(s) | Queda em relação ao pós-pooler | Backlog máximo do consumer |
|---|---|---|---|---|
| Pré-pooler (PG 16, HikariCP direto) | ~97k | `degraus-958305` | — | — |
| Pós-pooler (ponto 1, sem ES) | ~78k | `degraus-33459` | — | — |
| ES: append + relay, sem consumer (bloco 3b) | ~61k | `degraus-188193`, `-188802` | ~17k | consumer desligado |
| ES com consumer, 1 evento por transação (bloco 3) | ~56k | `degraus-181953`, `-183194` | ~22k | 362.342 na grossa; 578.674 no refino (187.917 herdados) |
| ES com consumer em lote, #146 (bloco 5) | ~58k | `degraus-193515`, `-194168` | ~20k | 66.333 na grossa; 118.606 no refino |

O backlog é o máximo do offset lag do grupo nas amostras de 1 s do host, em cada escada (`host-lag/`). A escada grossa
e o refino de cada bloco estão no `README.md` da etapa; os pontos de corte:

- **ES com consumer (bloco 3).** Grossa de 40k a 120k: 60k já satura (p95 de janela 1,28 s, 877 timeouts de leitura,
  277 descartes) e de 70k a 120k o efetivo fica em ~62–63k RPM (68k só em 80k) com p95 de janela de ~2,2–2,4 s. Refino
  de 50k a 60k: **X = 56k** (p95 de janela 1,84 s), e a degradação se sustenta (57k, 58k e 59k também acima de 1 s),
  com 0 descartes e 0 outros em todos os degraus. O 1º degrau é aquecimento.
- **ES sem consumer (bloco 3b).** Grossa de 40k a 80k: 60k limpo (p95 de janela 590 ms); 70k satura (efetivo ~59k, p95
  de 2,56 s, 10.612 descartes). Refino de 60k a 70k: o report marca X = 60k (1005 ms, no limite), mas é o degrau de
  aquecimento, e o mesmo degrau deu 590 ms na grossa; descontado, **X ≈ 61k** (1,64 s, 0 descartes).
- **ES com consumer em lote (bloco 5).** Grossa de 40k a 80k: 50k limpo (351 ms), 60k já com 1,76 s, acima de 70k o
  efetivo trava em ~58–59k. Refino de 50k a 60k: o degrau de 55k deu 1077 ms, mas é um **pico isolado** (56k e 57k
  voltam a ficar abaixo de 1 s, com 991 e 990 ms), e a degradação sustentada começa em 58k (1,81 s; 59k e 60k também
  acima de 1 s). Pelo critério do artigo, **X = 58k**; a regra estrita do report marca 55k. Só o degrau de 60k teve
  descartes (302).
- **O que não se atribui ao ES.** O ponto 1 (78k) foi medido no cabo, em banco limpo e com o host na `main` `a8fc86a`.
  Os blocos 3 e 3b rodaram no Wi-Fi, em banco **acumulado**, e o 3b depois do 3 (herdando o volume e o backlog dele). O
  bloco 5 rodou em banco limpo. O Tomcat não explica a queda: com 300 threads o teto do ponto 1 foi o mesmo
  (`03-supabase-pooler/degraus-39710.csv`: efetivo de 74.064 a 75.412 RPM de 80k a 100k, contra `degraus-32105`, com 200
  threads). Logo, os ~17k do append e os ~20–22k do total **incluem o Wi-Fi e o estado do banco**, que os dados não
  separam; é uma escada por camada.

**Leitura.**

- **O append no caminho quente custa até ~17k RPM.** De ~78k (pós-pooler, sem ES) para ~61k (append + relay, sem
  consumer), com o `event_store` e o `event_outbox` gravados na mesma transação da reserva e o relay ligado. A ressalva
  do bullet acima vale: parte desses 17k pode ser rede e estado do banco.
- **O consumer custa de ~2k a ~5k RPM, conforme o critério.** Pelo X, ~61k (3b) contra ~56k com o consumer de 1 evento
  por transação (~5k) e contra ~58k com o consumer em lote (~3k). Pelo início dos descartes, ≈60k no bloco 3 (277
  descartes em 60k) contra ≈62k no 3b (1570 em 62k), ~2k; o degrau de 60k do 3b é aquecimento e não entra. Uma escada por
  camada, resolução de 1k. O
  consumer e a reserva disputam o mesmo Postgres.
- **O consumer em lote empata em vazão com o atual.** X de ~58k contra ~56k, dentro da resolução de 1k e com uma
  escada por camada; a queda total em relação ao pós-pooler passa a ser de ~20k.
- **O consumer em lote mantém a projeção mais em dia.** Com janelas iguais: no degrau de 80k, o backlog máximo foi de
  179.634 mensagens no bloco 3 e de 66.333 no bloco 5 (≈ 2,7×); no refino, o backlog do bloco 3 cresceu 390.757
  (578.674 menos os 187.917 herdados da grossa) e o do bloco 5 chegou a 118.606 (≈ 3,3×). De 40k a 80k, o backlog
  cresceu até 179.634 em 5 degraus (pico do degrau de 80k, a partir de 0) no bloco 3 (~36 mil por degrau) e 66.333 no bloco 5 (~13 mil por degrau). Na drenagem com
  a carga parada, o lote caiu de 66.333 para 45.586 em 28 s (741 msg/s) e o consumer atual de 362.342 para 187.917 em
  382 s (457 msg/s). O zero que aparece no bloco 5 em seguida (de 42.463 para 0 em 1 s) é o **reset do banco** entre as
  escadas (TRUNCATE, tópicos e grupo apagados), não drenagem: não se lê como "o lote zerou" nem como "o atual não
  zerou". Os dois blocos também diferem no estado do banco (acumulado no 3, limpo no 5).
- **O p95 em 60k não melhorou com o lote, e a causa é uma hipótese.** Na grossa, o degrau de 60k teve p95 de janela de
  1,76 s no lote e de 1,28 s no consumer atual. A hipótese é que o consumer em lote faz o trabalho de banco durante o
  teste e disputa mais com a reserva: uma troca entre projeção fresca e vazão de escrita num banco compartilhado. Mas o
  degrau de 60k do bloco 3 teve 877 `outros` e 277 descartes fora do p95 (p99 de 4816 ms), e o do bloco 5, 0 e 0 (p99
  de 1813 ms), e o banco estava acumulado no 3 e limpo no 5. A hipótese não está isolada.
- **Motivação para a Fase 7, não conclusão.** Se a troca existe, ela motiva **separar o banco de leitura** do que
  recebe as escritas; os dados desta rodada não medem esse ganho.
- Como nas escadas anteriores, o X é o da **linha quente de um evento** (ameaça 10), não a capacidade agregada.
  Os 5xx ficam em 0: quando satura, o host fica lento e dispara o p95 de janela, não 5xx.
- As regras de autoescala 50/80 (#111 e #112) usam o X como base; com o ES no caminho da reserva, ela seria ~56k a
  ~58k, não ~78k (as issues não foram alteradas).

**Carga aleatória de 45 min (`Ale-190276`) × `Ale-29057` (#109).** Mesmo perfil (semente 617706, 1k–12k RPM, passo de
30 s, 30% de leitura, 200 usuários, `PCT_CONFIRMA=100`), braço `cas`, banco **limpo** nos dois, o novo com o ES e o
consumer ligados. Fontes: `04-fase6-es/resultados-aleatorio.csv` e `summary-ale-190276.json`;
`03-supabase-pooler/resultados-aleatorio-109.csv`. Os deltas são do p50 e do p95, em ms:

| Endpoint | p50 / p95 / p99 `Ale-29057` (ms) | p50 / p95 / p99 `Ale-190276` (ms) | Δ p50 / Δ p95 (ms) | p95 (×) |
|---|---|---|---|---|
| Reserva | 3,9 / 5,7 / 10,7 | 10,8 / 36,2 / 62,0 | +6,9 / +30,5 | 6,3 |
| Confirma | 2,1 / 5,0 / 8,8 | 8,7 / 29,7 / 56,0 | +6,6 / +24,7 | 5,9 |
| Evento | 1,9 / 3,4 / 6,2 | 7,9 / 32,7 / 58,1 | +6,0 / +29,3 | 9,6 |
| Carteira | 3,2 / 12,6 / 25,0 | 16,6 / 56,9 / 105,1 | +13,4 / +44,3 | 4,5 |
| Busca | 11,4 / 15,0 / 21,8 | 58,8 / 128,3 / 222,4 | +47,4 / +113,3 | 8,6 |
| Leitura agregada | 2,6 / 12,9 / 19,9 | 13,6 / 82,6 / 142,7 | +11,0 / +69,7 | 6,4 |

- **Mesma correção, 0 erros.** 146.400 aceitas (1464 eventos × 100 vagas), todas confirmadas; 48.617 recusadas como
  lotado (48.612 na `Ale-29057`); 0 erros 5xx, 0 outros, 0 descartes, 0 leituras com erro. Overselling 0.
- **O p95 ficou de 4,5× a 9,6× maior** (6,3× na reserva), e o p50 de 2,8× a 5,2×. O p95 de reserva de 36,2 ms ainda é
  baixo em termos absolutos; as razões exageram porque a base da `Ale-29057` é muito baixa.
- **O backlog do consumer não é a causa.** Na amostra de 1 s do host durante o aleatório (2.625 amostras, na janela do
  teste: do horário de término menos a duração de 2702 s até o término), o lag do consumer ficou em média em 2,9
  mensagens, com máximo de 49 e mediana 0: o consumer acompanhou a carga. Não houve aleatório com o consumer desligado,
  então isso não diz que o consumer não custa nada, só que não havia fila.
- **A origem do aumento é uma hipótese: ES no banco e Wi-Fi, sem separar os dois.** O delta do p95 da baseline de HTTP
  entre o Wi-Fi e o cabo foi de ~+24 ms, e o do p50, de ~+12 ms (ordem de grandeza: é outro cliente). A reserva
  (+30,5 ms), a confirmação (+24,7) e o evento (+29,3) ficam na mesma faixa, e o evento, que é só leitura de uma
  projeção inline, subiu tanto quanto a reserva, o que é compatível com o jitter do Wi-Fi. No p50, os deltas de +6 a +7
  ms dos três ficam abaixo dos ~+12 ms da baseline. **Só a busca (+113 ms no p95) e a carteira (+44 ms) excedem a
  rede com clareza**; é nelas que o custo do ES (ou outro efeito) fica visível. Separar as parcelas pede uma repetição
  no cabo.

### Ponto 3 (serviços separados, Rodada 3, 2026-10-24)

Rodada 3 do experimento (issue #34), contra a `Fase_7` em `20aae4e` (código das #32 e #33, ainda não mergeado na `main`
quando a rodada rodou), capacidade 20 e 100% de confirmação. Fonte: `Projeto/carga/results/05-distribuido/` (README da
etapa, `matriz-naive.csv`, `matriz-cas.csv`, `degraus-*.csv`, `resultados-aleatorio.csv`). O **controle do ponto 2 no cabo**
está em `04b-fase6-es-cabo/`. Rede cabeada (baseline HTTP p50 15,8 ms / p95 18,0 ms), host com Docker em SSD, banco limpo
antes de cada bloco. Nenhuma repetição foi descartada.

**O que mudou em relação ao ponto 2.** `reservation` virou serviço (schema, event store e relay próprios); o `gateway` o
chama por HTTP interno autenticado: o braço `cas` em 1 chamada, o `naive` em 2 (a janela check-then-act inclui a rede). Junto
com a arquitetura mudaram o Hikari do monólito (1000 → 350), o pool HTTP de 400, o timeout de 10 s e o token interno.

- **Overselling.** CAS: **0 em 20 de 20 repetições**, 0 erros 5xx. Naive: no teto em 19 de 20 (80 em N=100, 10/10; 180 em
  N=200, 9/10; 168 na rep 1, em que a projeção refletiu parte da lotação). Igual ao ponto 2.
- **Matrizes (p95 por requisição).** Naive 97–345 ms (N=100) e 189–274 ms (N=200); CAS 106–176 ms e 156–205 ms. No cabo e
  em SSD, o ponto 2 refeito (04b) deu naive 87–187 ms e 127–186 ms: o p95 subiu na faixa de dezenas de ms, o que é a ordem
  de grandeza do salto HTTP, mas a rodada mudou junto outras variáveis (acima) e não as isola.
- **Limiar X ≈ 58k RPM.** Grossa: 50k limpo (243 ms), 60k satura (1,78 s), efetivo ~60–61k acima de 70k. Refino sobre banco
  limpo: 51k–57k entre 260 e 482 ms; **58k é o primeiro degrau saturado** (1,94 s). 0 erros 5xx, 0 outros, 0 descartes até
  58k. Contra o ponto 2: ≈ 56k no Wi-Fi (04) e ≥ 60k no cabo (04b, refino inconclusivo por banco sujo): o distribuído fica
  ~3% abaixo do ponto 2 na mesma rede, com o mesmo teto de vazão (~61k req/min).
- **Aleatório de 45 min** (mesma semente 617706): 146.400 aceitas, todas confirmadas, 0 erros, 0 descartes; p95 de reserva
  6,6 ms, confirma 4,5, busca 19,9, evento 3,7, carteira 10,1. Está na faixa da #109 (pós-pooler, sem ES) e muito abaixo do
  ponto 2 no Wi-Fi (reserva 36,2 ms). Como o ponto 3 também grava no event store, o aumento de p95 do ponto 2 vinha em boa
  parte do Wi-Fi, não do ES; a confirmação direta (aleatório do código do ponto 2 no cabo) não foi feita.
- **Os 5xx.** Não houve nenhum, e `backend` e `reservation` terminaram sem `WARN`/`ERROR`: o timeout de 10 s e o pool HTTP
  de 400 não foram atingidos até 58k.

**Ameaças a este ponto.** (i) Mudaram juntas a arquitetura, o Hikari (350), o pool HTTP, o timeout e o token: o delta de
X e de p95 não se atribui só ao salto de rede. (ii) Resolução de 1k RPM no X e uma escada por configuração; o 04b tem
refino inconclusivo, então o X do ponto 2 no cabo é um piso (≥ 60k). (iii) A 1ª tentativa do 04b rodou com os dados do
Docker em HDD (`fsync` ≈ 30 ms) e foi descartada; as medidas válidas são as de SSD. (iv) A matriz naive tem `lag_obs_*`
quase sempre -1 (a projeção ficou mais rápida que o polling), então o lag não aparece como variável. (v) O PR da `Fase_7`
não estava mergeado: o código medido é o que vai para a `main`.

### Limiar X definitivo (Rodada R, 2026-10-28; issue #40)

Rodada R, contra a `Batch_1` em `b072346` (Fase 7 completa: `notification`, `reservation`, `catalog` e `identity` como
serviços; ainda não mergeada na `main` quando a rodada rodou, então o código medido é o que vai para ela). Fonte:
`Projeto/carga/results/06-batch1-final/` (README da etapa e `degraus-*.csv`). Braço `cas`, 200 usuários, 60 s por degrau,
host com Docker em SSD NVMe, rede cabeada, banco limpo antes de cada bloco, Tomcat 300 e Hikari 1000 no `reservation`,
pool do Supavisor 245. O X desta subseção é o que a arquitetura de admissão usa (`docs/adr/Architecture-Decision-Async-Checkout-Queue.md`).

**X definitivo = 56.000 RPM por evento** (≈ 930 tentativas de reserva/s numa única linha do `eventcap`), da escada **sequencial**
(evento disputado), refino 6b (`degraus-938039`), resolução de 2k:

| `rpm_alvo` | `rpm_efetivo` | p50 (ms) | p95 de janela de 30 s (ms) | Descartes |
|---|---|---|---|---|
| 38k (aquecimento) | 38.000 | 49,6 | 1.397,0 | 0 |
| 52k | 52.001 | 137,4 | 318,6 | 0 |
| 54k | 54.001 | 164,6 | 356,8 | 0 |
| **56k** | 56.000 | 215,3 | **1.669,1** | 0 |
| 58k | 42.408 | 3.069,4 | 3.483,2 | 15.593 |
| 60k | 42.027 | 3.096,2 | 3.426,6 | 17.974 |

- **Por que 56k.** É o primeiro degrau que cumpre a regra do X (p95 de janela acima de 1 s) fora do aquecimento, e é
  seguido de colapso (como o "58k é o primeiro degrau saturado" do ponto 3): a cauda passa de 1 s (janela de 1,67 s) ainda
  sem descarte, e nos dois degraus seguintes a vazão **cai** para ~42k efetivos (colapso por fila, p50 ~3,1 s). O último degrau limpo é **54k** (janela de 357 ms, p50
  165 ms). 0 erros 5xx e 0 outros em todos os degraus da tabela.
- **Aquecimento descartado.** O degrau de 38k do `degraus-938039` é a partida a frio do refino (janela de 1,4 s) e não é
  degradação: os degraus de 40k a 54k, na sequência, ficam limpos (169 → 357 ms). O `report-degraus` aplica a regra do X
  ao CSV inteiro e marcaria o X nesse 38k; a leitura acima o descarta. O refino 6 (`degraus-936649`, 18k–40k) está todo
  limpo (janela de 6 a 160 ms). Aquecimento análogo no 1º degrau de cada refino intercalado (janela de 2,1 s nos dois).
- **Anomalia fora do X.** A escada grossa sequencial (`degraus-931618`) começou a frio em 40k e colapsou já no 1º degrau
  (efetivo 39–44k, janela de 3,3–3,9 s); os degraus de cima herdaram o host atolado. Fica registrada como medida, não
  como X.
- **Causa.** Vem do diagnóstico ao vivo (README da etapa), não do refino 6b e não dos CSVs versionados: o `pg_stat_statements`
  acumulado desde o início da escada sequencial a frio até o fim do `Rpm-932720` deu média de 344 ms no `UPDATE` do CAS
  e, durante o `Rpm-932720`, havia 186 sessões esperando lock de transação e as 300
  threads do Tomcat do `reservation` ficaram esperando o banco. É a contenção na linha do `eventcap` do evento disputado.

**Por que é "por evento".** No mapeamento `sequencial` a iteração `i` vai ao evento `⌊i/U⌋` (U = 200), de modo que, em cada
instante, as chegadas novas caem num único evento: a taxa na linha quente do `eventcap` é a taxa agregada do degrau (≈ 930
req/s a 56k). O que é fixo por evento é a **contagem** (200 tentativas, numa rajada de 200 · 60 / RPM s ≈ 0,2 s a 56k, ameaça
10), não a taxa. Logo, a escada sequencial mede o RPM **de um
evento**, e o `RPM(evento)` da ADR é comparável a ele.

**Teto do host (intercalado).** O mapeamento `intercalado` espalha a carga pelos eventos e chega a **≈ 86k RPM** (refino
`degraus-933734` e `degraus-935110`): 84k é o último limpo (janela de 62 ms, p50 11,8 ms), 86k degrada (efetivo 85.700,
janela de 1.120 ms, p50 228 ms, 301 descartes) e de 88k a 92k o efetivo se segura em ~80–82k (7.050 a 12.234 descartes). É o
teto do host somado entre eventos, não o X por evento: a linha quente de um evento custa ~35% dele (56k contra 86k).

**Contra os pontos anteriores** (todos sequenciais, mesma linha quente): ≈ 97k pré-pooler (referência), ≈ 78k pelo pooler
(ponto 1), ≈ 56k–61k no ponto 2 e ≈ 58k no ponto 3 (Rodada 3, `20aae4e`). 56k contra 58k é cerca de um passo de
resolução, e o código mudou entre as duas (saíram o `catalog`, #35, e o `identity`, #36, do processo do `gateway`, e mudou
o contrato da reserva, #57): **não se lê como regressão.**

**Limiares derivados** (regra 50/80/70 de `docs/adr/Architecture-Decision-Async-Checkout-Queue.md`, com 1 réplica do `reservation`, uso = `RPM(evento)` ÷ (X × réplicas)):

| Gatilho | Uso | RPM por evento |
|---|---|---|
| Fila entra | ≥ 80% | 0,8 × 56k = **44,8k** |
| Volta ao síncrono (com fila vazia) | &lt; 70% | 0,7 × 56k = **39,2k** |
| Réplica em stand-by (#111) | > 50% | 0,5 × 56k = **28k** |

A faixa de 44,8k fica dentro do trecho limpo da escada (44k: janela de 230 ms), com margem de 11,2k RPM para o X.

**Consequências para a implementação (fora desta medição).**

- **Janela do sinal.** X é uma **taxa** (≈ 930 tentativas/s), e a rajada por evento dura ~0,2 s. Um contador de janela de 60 s leria
  ~200 numa rajada dessas e nunca chegaria a 44,8k; a janela do sinal em Redis (e como ela converte a contagem em RPM) é
  decisão da implementação do `admission` (#41 e #43), não desta medição.
- **Réplicas.** A Rodada R mediu **uma** réplica. O limite é a linha do `eventcap`, que réplicas extras também disputariam
  (e o mesmo host sem a linha quente chega a 86k contra 56k): insumo para a #111, fórmula `X × réplicas` inalterada.

**Ameaças a este X.** (i) Uma escada por configuração e resolução de 2k RPM: o X vale 56k ± um passo (o degrau limpo anterior é
54k). (ii) A causa vem do diagnóstico a frio (estado já colapsado), não de uma medição no joelho do refino: o
`pg_stat_statements` salvo não está alinhado à escada do 6b, então o joelho não tem diagnóstico de banco próprio (a coleta do
6b, `coleta-host-r-refino-seq2-*`, só traz um pico de 237 sessões em `pg_espera_lock`, sem alinhamento por degrau). (iii) Partida
a frio: o aquecimento do 6b e dos refinos intercalados estoura a cauda (o refino 6 começou limpo) e é descartado por
julgamento, não pela regra automática do report. (iv) O X é uma taxa de chegada na linha quente com rajada de
~0,2 s por evento, não um evento sustentado a 56k RPM por 60 s (um evento real esgota a capacidade antes); vale como limiar
de contenção do `eventcap`. (v) Uma réplica do `reservation`, um host, uma rede; o código medido é o da `Batch_1`.

### Comparação das 3 configurações (issue #39)

Resultado consolidado da série: **monólito CRUD + pooler** (ponto 1), **monólito com CQRS + ES** (ponto 2) e **distribuído com ES**
(ponto 3: a etapa 05 como intermediária e a Rodada R, etapa 06, como configuração final). Esta subseção **junta de propósito os
conjuntos** que o "Escopo dos números" do topo manda não misturar, lado a lado e com as ressalvas abaixo. Nenhum número é recalculado:
todos vêm dos README das etapas (`Projeto/carga/results/<etapa>/README.md`) e das subseções anteriores, e os valores e a fonte de cada
um estão em [`graficos/comparacao-3-configuracoes.csv`](graficos/comparacao-3-configuracoes.csv). Os gráficos saem de
[`graficos/gera-graficos.sh`](graficos/gera-graficos.sh) (bash + awk, sem lib). Compara-se sequencial com sequencial (escada do X) e o
aleatório de 45 min com a mesma semente 617706 (latência); o X **intercalado** da Rodada R não entra na comparação (ver abaixo).

| | Ponto 1: monólito CRUD + pooler (03) | Ponto 2: monólito ES (04 Wi-Fi; 04b cabo) | Ponto 3 intermediário: distribuído (05) | Distribuído final, Rodada R (06) |
|---|---|---|---|---|
| Commit / rede | matriz `8ba01b4` (código a partir de `66a46b4`), escada na `main` `a8fc86a`; cabo | `main` `1ee6fbe`; 04 em Wi-Fi (baseline HTTP p50 26,6 / p95 42,9 ms); 04b: + #146, no cabo, SSD | `20aae4e`; cabo, SSD | `b072346`; cabo, SSD (baseline HTTP p50 13,9 / p95 15,6 ms) |
| Overselling, braço CAS | 0 em 10/10 | 04: 0 em 10/10; 04b: não medido | 0 em 20/20 | 0 em 20/20 e 0 no aleatório |
| Overselling, braço ingênuo | teto em 36/40 (15 a 180) | 04: teto em 10/10 (80/180); 04b: teto em 10/10 (80/180) | teto em 19/20 (168 na rep 1 de N=200) | teto em 20/20 (80/180) |
| **X sequencial** (throughput, RPM por evento) | 78k (referência pré-pooler: 97k) | 04: 56k (Wi-Fi); 04b: ≥ 60k (só limite inferior) | 58k | 56k (último degrau limpo 54k) |
| Teto do host, intercalado (não comparável com o X) | n/d | n/d | n/d | 86k (último limpo 84k) |
| Reserva p50 / p95 / p99 (ms, aleatório 45 min) | 3,9 / 5,7 / 10,7 (Ale-29057) | 10,8 / 36,2 / 62,0 (Ale-190276, Wi-Fi); 04b sem aleatório | 4,8 / 6,6 / 9,3 (Ale-644172) | 4,7 / 6,7 / 8,0 (Ale-939580) |
| Confirmação p50 / p95 / p99 (ms, aleatório 45 min) | 2,1 / 5,0 / 8,8 | 8,7 / 29,7 / 56,0 (Wi-Fi) | 3,1 / 4,5 / 6,9 | 3,1 / 5,5 / 8,1 |
| Leitura p95 (ms): busca / evento / carteira | 15,0 / 3,4 / 12,6 | 128,3 / 32,7 / 56,9 (Wi-Fi) | 19,9 / 3,7 / 10,1 | 32 / 5 / 8 |
| Lag (a definição muda por ponto) | timer **configurado** de 500 a 10000 ms; `lag_obs_disparo` médio de 241 a 6211 ms | 04: `lag_obs_max` de 19 a 280 ms (13 de 20 linhas) e, no aleatório, offset lag do consumer médio de 2,9 e máximo de 49 mensagens; 04b: `lag_obs_max` = -1 em 9 de 10 linhas (projeção mais rápida que o polling de 250 ms) | `lag_obs_*` = -1 quase sempre (projeção mais rápida que o polling) | `lag_obs_max` lido em poucas linhas (máx. 79 a 158 ms); nas outras a projeção foi mais rápida que o polling de 250 ms |
| Aceitas, 5xx e descartes no aleatório | 146.400 aceitas, 0 erros 5xx, 0 descartes | 04: 146.400 aceitas, 0 erros 5xx, 0 descartes | 146.400 aceitas, 0 erros 5xx, 0 descartes | 146.400 aceitas, 0 erros 5xx, 0 descartes |

O **lag** não tem uma coluna comparável: no ponto 1 é a variável independente (um timer de refresh), do ponto 2 em diante é medido no
pipeline real (`lag_obs_*` em ms ou offset lag em mensagens), e `-1` significa que a projeção foi mais rápida que o polling. Por isso o
lag fica na tabela e não vira gráfico; o overselling também (é uma contagem por repetição, sem escala a comparar). Como o SVG é uma
imagem estática, a tabela acima é a "table view" dos gráficos.

![Limiar X sequencial por configuração: pré-pooler 97k (referência), ponto 1 78k, ponto 2 56k no Wi-Fi e no mínimo 60k no cabo, ponto 3 intermediário 58k e final 56k; o teto do host intercalado (86k) fica fora da série.](graficos/x-sequencial.svg)

O primeiro gráfico mostra o X sequencial, uma barra por configuração. O ponto 2 no cabo (04b) é só um **limite inferior** (contorno
tracejado com seta, não barra), porque o refino ficou inconclusivo por banco sujo.

![Latência de reserva e de confirmação (p50, p95, p99) no aleatório de 45 min, mesma semente, em quatro configurações, em dois painéis de mesma escala.](graficos/latencia-aleatorio.svg)

O segundo mostra a latência do aleatório de 45 min por configuração, em dois painéis de mesma escala (reserva e confirmação). O ponto 2
é o do Wi-Fi (o 04b não tem aleatório).

**Leitura.**

- **Corretude.** O braço CAS ficou em **0 de overselling** em todos os pontos em que foi medido (10/10, 10/10, 20/20 e 20/20, mais 0
  no aleatório da Rodada R), e o braço ingênuo ficou no teto (80 em N=100 e 180 em N=200) em quase todas as repetições, em todos os
  pontos: a corretude do CAS não mudou ao introduzir ES nem ao distribuir.
- **Throughput.** O X caiu de ≈ 78k RPM (ponto 1, sem ES) para ≈ 56k no ponto 2 (Wi-Fi) e ficou na mesma faixa ao distribuir: 58k
  (05) e 56k (06, com 54k como último degrau limpo). O 04b no cabo só dá um limite inferior (≥ 60k), então o ponto 2 refeito no cabo
  não fecha um X para comparar com 58k e 56k. A diferença entre 58k e 56k é cerca de um passo de resolução e o código mudou entre as
  duas (nota da #57 abaixo): não se lê como regressão.
- **Teto do host.** O X intercalado de ≈ 86k RPM só existe na Rodada R. É o teto do host somado entre eventos, não o X por evento, e
  por isso não é comparável com os X sequenciais acima.
- **Latência.** No aleatório, a reserva do distribuído (p95 de 6,6 ms no 05 e 6,7 ms no 06) ficou na faixa do ponto 1 (5,7 ms), e a
  confirmação também (4,5 e 5,5 contra 5,0 ms). O ponto 2 aparece mais alto (reserva 36,2 ms, confirmação 29,7 ms), mas foi medido no
  Wi-Fi e a latência dele inclui a rede: o 05, no cabo e também com ES, **indica** que boa parte do aumento vinha da rede (indício, não
  prova). A confirmação direta, com o aleatório do código do ponto 2 no cabo, não foi feita, então a parte desse aumento que vem do ES
  e a que vem da rede não estão isoladas.

**Nota da #57 entre os pontos.** Nos pontos 1 a 3 (até a etapa 05) o `userId` da reserva vinha do corpo da requisição. Na Rodada R a
reserva é amarrada ao token (PR #167, issue #57): em `/bff/event-wallets/**` o `userId` informado fica opcional, o ausente vale o do
token e o **divergente devolve 403**, antes de qualquer validação ou chamada ao `reservation` (testes
`HttpContractTest.eventWallet_tokenDeAnaoAgeEmNomeDeBeto_returns403NosEndpoints` e `eventWallet_proprioUsuario_comESemUserId`).
Com a #36, o `gateway` tira o id da claim `uid` do JWT RS256, validado sem estado pelo JWKS, **sem consulta ao banco** (a #57 sozinha
faria uma consulta e-mail → `user_id` por requisição). O kit de carga já mandava o `userId` do dono do token, então **a requisição do
k6 é a mesma**; muda o caminho no servidor (validação do JWT pelo JWKS, sem consulta). **Não é uma variável isolada:** entra junto
com as outras mudanças entre as etapas 05 e 06 (a saída do `catalog` e do `identity` do processo do `gateway`, #35 e #36).

**Ameaças desta comparação.** (i) **Uma escada por configuração**, com resolução de 1k a 2k RPM no X (56k ± um passo). (ii) **Rede, disco e
estado do banco diferentes:** o ponto 2 (04) rodou no Wi-Fi e, nos blocos 1 a 3b, sobre banco acumulado; o 04b, no cabo e em SSD, só deu um limite inferior. (iii) **Códigos diferentes entre
os pontos**, sem isolar uma variável por vez (a arquitetura, o Hikari do monólito, o pool HTTP, o timeout, o token interno e a #57
mudaram junto). (iv) O ponto 1 rodou com **Tomcat de 200 threads**; do ponto 2 em diante, 300. (v) O X do 04b é **só limite inferior**
(≥ 60k). (vi) O lag não tem a mesma definição nos pontos: é uma variável configurada no ponto 1 e uma medida do pipeline depois.

### Rodada 4 (admission e autoescala acima do X, 2026-10-29; issue #179)

Rodada 4, contra a `Batch_2` em `35955ef`: a configuração da Rodada R mais o `admission` (#41–#43: contador de RPM por evento no Redis, janela
de 200 ms, fila no RabbitMQ com worker pool, gatilho 80/70 de `X × réplicas` com X = 56k, `202` e consulta de estado), a autoescala (#111/#112,
opção A: override do compose, HAProxy e scaler no host) e as imagens slim (#177). Fonte: `Projeto/carga/results/07-rodada4-admission/`
(README da etapa e `degraus-*.csv`). Escada sequencial de 20k a 98k RPM, passo de 6k, 60 s por degrau, 1000 usuários, 5% das respostas `202`
acompanhadas até o estado final, parada por p95 acima de 5 s numa janela de 60 s, banco limpo antes de cada bloco, `pg_test_fsync` 0,37–0,39 ms.

| Bloco | Braço | Resultado | Overselling (CAS) |
|---|---|---|---|
| 1 (`degraus-46496`) | sem autoescala | 14 degraus completos, 0 5xx, 0 descartes; fila drenada (máx. 4.419, 0 ao fim), dead-letter 0 | 0 |
| 2 (`degraus-49019`) | autoescala, parâmetros provisórios | parada no 32k (p95 de janela 5,58 s); 4.175 5xx (3.148 reserva, 1.027 confirma), 1.162 descartes | 0 |
| 3 (`degraus-50350`) | autoescala calibrada | parada no 38k (p95 de janela 6,00 s); 9.537 5xx (7.557 reserva, 1.980 confirma), 4.609 descartes | 0 |

**Contra a Rodada R** (mesma escada e mesma regra do X):

| | R (06, `b072346`) | R4 bloco 1 | R4 bloco 2 | R4 bloco 3 |
|---|---|---|---|---|
| 1º degrau degradado fora do aquecimento | **56k** (54k limpo) | **32k** (26k limpo) | 20k (já no 1º degrau) | 26k |
| p50 / p95 / p99 a 32k (ms) | 5,2 / 36,6 / 76,2 | 217,3 / 1.430,3 / 1.950,7 | 1.302,5 / 5.580,7 / 6.650,9 | 554,7 / 2.731,9 / 3.884,3 |
| p50 / p95 / p99 a 56k (ms) | 215,3 / 1.141,3 / 1.984,1 | 4,7 / 377,9 / 654,7 | — | — |
| Taxa de 5xx | 0 | 0 | 10,2% no 32k | 24,1% no 38k |
| Tempo até admitir p95 | — | 2,2–3,0 s até 38k; 15,0–29,2 s de 44k a 98k | 16,1–18,9 s | 1,0–20,2 s |
| Réplicas | 1 de cada | 1 de cada | reservation 1→2→1, backend 1→3 | reservation e backend 1→2 |

- **Sem autoescala, o modo de alta carga deixa o sistema estável acima do X.** De 50k a 98k o efetivo fica igual ao alvo, sem 5xx e sem
  descartes, e o p95 de janela fica em 0,30–0,77 s. A Rodada R colapsava para ~42k efetivos logo depois de 56k.
- **O preço do modo de alta carga** é a espera até admitir (p95 de 15 a 29 s acima de 44k) e o `429` por usuário, que chega a 72% das
  respostas em 98k (limite de 5 em espera por usuário com 1000 usuários; a fila nunca encheu).
- **Abaixo do X a R4 é mais lenta que a R.** O contador de 200 ms vê rajadas acima do RPM oferecido e liga a fila já em 20k–44k. A fila e o
  caminho síncrono disputam a mesma linha do `eventcap`, e cada reserva ganha o salto ao `admission`.
- **Com autoescala, neste host, o sistema não fica estável acima do X.** O health check do HAProxy (`GET /actuator/health`) divide as 300
  threads do Tomcat do gateway com o tráfego e estoura os 2 s com o gateway saturado. O `lb` então tira a réplica do ar com milhares de
  sessões ativas, e os 503 são do próprio `lb` (`econ` = `hrsp_5xx` no `show stat`; os servidores têm 0 5xx próprios). Calibrar as
  capacidades do scaler pelo bloco 1 (bloco 3) corrigiu o começo, com p50 de 7,7 ms a 20k, mas não a ejeção. Follow-up #207; a oscilação do
  sinal `adm:hot` do scaler é a #206. Réplicas extras também não ganham capacidade aqui: o host é um só, e a linha quente do `eventcap`
  é a mesma (X(1) = X(2) no dry-run da #178).

**Ameaças.**
- Uma escada por bloco, sem repetição.
- Imagens slim e 1000 usuários, contra as imagens originais e os 200 usuários da R.
- Matriz não rodada nesta rodada; o CAS foi conferido no banco por bloco.
- Sem telemetria do gerador no modo direto: a saturação do gerador sai só de `iteracoes_descartadas`/`rpm_efetivo`.
- Um host compartilhado entre todos os serviços e réplicas.

### Resultados preliminares (fora do protocolo)

Antes do protocolo acima, rodadas de 2026-10-04 (`Projeto/carga/results/02-hikari/ANALISE.md`) mediram os dois braços
com **um único lag (5 s) e uma ou duas repetições por configuração** (`BACKLOG.md`, seção "Estado";
`ANALISE.md`, seção 6: "uma rodada por configuração"). Servem como motivação e como expectativa, **não**
como resultado do protocolo: não entram nas curvas nem no X. A tabela traz só overselling, medido no banco
como `(pending + confirmed) − capacidade` (`make verificar-*`), isto é, a métrica secundária; com 100% de
confirmação ela coincide com a primária. As rodadas pós-pool rodaram com `max_connections=1000`
(`docs/carga/setup.md`, seção 6), enquanto os comandos do protocolo usam `MAX_CONN=300`
(`Projeto/carga/README.md`): mais um motivo para não compará-las com a matriz e a escada.

| Teste preliminar | Braço | Overselling (banco) |
|---|---|---|
| Rodadas pós-pool (disputa, taxa fixa e aleatório; com e sem confirmação) | `cas` | 0 (`eventos_com_overselling = 0`) |
| Disputa de 50 / 100 / 200 clientes, capacidade 20, com 100% e 60% de confirmação (N = 50 está fora do protocolo, que usa 100 e 200) | `naive` | 30 / 80 / 180 (igual nas duas confirmações) |
| Taxa fixa de 10k RPM por 90 s, 79 eventos | `naive` | 7.347 reservas a mais em 75 eventos (100% de confirmação); 6.985 em 75 eventos (60%) |
| Aleatório, 45 min, 1464 eventos | `naive` | 0 |

Leitura (interpretação pelo código e pelo padrão de carga, **não medida diretamente**): na disputa preliminar
do braço ingênuo todos os clientes foram aceitos (0 "lotado"), porque a rajada cabe dentro de um intervalo de
refresh e o read model mostra 20 vagas durante toda ela; no aleatório, as tentativas de um mesmo evento chegam
mais espaçadas que o refresh e o evento já aparece cheio na tentativa seguinte. Isso sugere que o overselling
do braço ingênuo depende da concentração de tentativas por evento dentro do lag, e não da taxa total
(hipótese a testar, não resultado).

Para o X, os dados preliminares de monólito + HikariCP ficam abaixo ou no início da escada: 10k RPM por 90 s
no braço CAS, com 0 respostas 5xx e p95 da reserva de 4,2 ms (`ANALISE.md`, seção 3), e o aleatório de 45 min
(1k–12k RPM, com leituras), também sem 5xx. Não são comparáveis aos degraus (carga, duração e mistura
diferentes). Os números anteriores ao pool de conexões (por exemplo, 5xx de cerca de 31% a 10k RPM) estão
invalidados (issue #96) e não são usados.

## Ameaças à validade

As sete primeiras são as ameaças obrigatórias do experimento; a sétima está **aberta**.

1. **LAN única.** Host e gerador estão na mesma rede (host em Ethernet; gerador com link de 1 Gbps, meio
   físico não registrado). Não há variação de topologia nem das condições de rede. O RTT não foi isolado: o
   ICMP não respondeu e a "latência base" HTTP (p50 de 14,9 ms) veio de outro cliente (PowerShell) e de um
   endpoint que consulta o Postgres, então não é comparável ao k6 e não é subtraída; as latências do k6 vão
   como medidas, com o RTT embutido. Latências absolutas e X valem para esta topologia; o efeito de uma rede
   mais lenta ou com jitter sobre a duração da rajada, e portanto sobre o overselling do braço ingênuo, não
   foi avaliado.
2. **Um evento por disputa.** Cada disputa concentra os N clientes num único evento: uma linha de `eventcap`
   e uma do read model. É o caso de maior concentração. Nas rodadas preliminares (ver "Resultados
   preliminares") o braço ingênuo teve overselling na disputa concentrada e nenhum no teste aleatório, com
   as tentativas espalhadas por muitos eventos; o resultado da matriz vale para a concentração máxima e não
   diz quanto se oversella com a demanda espalhada. Na matriz também não há disputas simultâneas entre
   eventos.
3. **Determinismo do job de refresh.** O overselling do braço ingênuo depende do ponto do ciclo do job em
   que a rajada chega e de haver ou não um refresh no meio dela. A mitigação é a espera aleatória em
   `[0, lag)`, as 5 repetições e a coleta de `lag_obs_*`. Resíduos: 5 repetições são uma amostra pequena das
   fases; a rajada é curta (cerca de 0,1-0,3 s segundo `Projeto/carga/lib-matriz.ps1`; "menos de ~3 s" nas
   rodadas preliminares, `ANALISE.md`), e na disputa preliminar todos os clientes foram aceitos, então para
   lags grandes o overselling pode atingir um patamar em N − capacidade que esconde a sensibilidade ao lag;
   o job usa `fixedDelay`, então o período efetivo é o lag mais a duração do refresh, um único
   `INSERT ... SELECT` que recalcula todas as linhas de `eventcap` e tende a crescer com os eventos acumulados
   no banco, de modo que a espera uniforme em `[0, lag)` cobre só parte do ciclo; e sob saturação o job pode
   atrasar (observado antes do pool, em `docs/carga/setup.md`). Em ambos os casos o lag efetivo difere do
   configurado, e o `lag_obs_*` registra o efeito. No ponto 1, o banco limpo reduziu esse efeito (ameaça 15).
4. **bcrypt no seed.** O seed e o login usam bcrypt (custo alto): semear centenas de usuários leva dezenas de
   segundos e os logins do `setup()` custam cerca de 10 ms por cliente, o que domina o tempo de cada
   execução e deixa a rajada ocupar uma fração mínima dele. A consequência de validade é que esse custo leva a
   usar poucos usuários (200 na escada) para gerar milhares de reservas, com os pares (usuário, evento) em
   sequência (`Projeto/carga/README.md`, "Como funciona"), o que concentra as tentativas de cada evento (ver
   a ameaça 10). O `setup()` só termina depois de todos os logins (`http.batch`), então a rajada não compete
   com o bcrypt; resta, como possibilidade não medida, algum efeito do estado do host logo depois de N
   logins (coleta de lixo, JIT). A mitigação é medir só a janela da rajada (`disparo_ms` e `fim_ms`), sem os
   logins.
5. **Pool HikariCP de 1000.** O tamanho padrão do pool não foi explorado: nas rodadas preliminares, com 100 VUs
   e latências de poucos ms, o pool nunca chegou perto de 1000 (`ANALISE.md`, seção 6), e o padrão só é seguro
   com `max_connections` alto. Um pool menor mudaria onde as requisições esperam (fila no pool em vez de conexão no Postgres) e,
   com isso, a latência e o X (não testado). Os resultados pré-pooler são de "monólito + HikariCP (1000)". No ponto
   1 o HikariCP (1000) só enfileira no Supavisor, cujo pool real no Postgres é 245; o efeito disso sobre a latência
   não foi isolado (ameaça 14).
6. **Sem `pg_stat_statements`.** A extensão não é coletada nesta fase (a coleta está prevista para o harness
   definitivo da Fase 8, e a imagem do Supabase a traz: `docs/adr/Architecture-Decision-Supabase-Self-Host.md`).
   Sem ela não há tempo por instrução SQL (o `UPDATE` do CAS, o UPSERT em `walletevent`, o `INSERT ... SELECT`
   do refresh), e as causas de latência e do X permanecem hipóteses. Os CSVs da matriz e da escada também não
   trazem série de CPU, memória nem uso do pool durante a carga, e o `sockstat` pós-pool não cobre as rodadas.
7. **p95 bimodal (~460 ms) sem causa medida (ameaça aberta).** Nas rodadas preliminares pós-pool
   (medição fora do protocolo), o backend apresentou uma latência de **leitura** bimodal: p50 de ~2 ms e p95 de
   ~460–475 ms, nos braços `cas` e `naive`, que não vem do pool nem da confirmação (`ANALISE.md`, seção 6).
   A suspeita, não medida por endpoint, é que `GET /bff/events/search` varra os eventos em memória. A matriz
   e a escada enviam só `POST` (reserva e confirmação), então esse comportamento não deveria aparecer nelas,
   mas a causa não foi isolada e não há evidência de que o caminho de escrita sob a escada esteja livre dele.
   Segue aberta até a latência ser medida por endpoint.

Ameaças adicionais, sustentadas pelos documentos do kit:

8. **Pool maior que `max_connections`.** O pool cresce sob demanda a partir de 5 conexões; se crescer além de
   `max_connections`, o Postgres pode recusar conexões (`too many clients`) e o backend responde HTTP 500
   (`Projeto/carga/README.md`, "Por que `MAX_CONN` importa"). Os comandos do protocolo usam `MAX_CONN=300` com
   o pool padrão de 1000 (o valor efetivo é o registrado no Setup), então 5xx na escada podem ser artefato de
   configuração, o que pode antecipar o X. (No ponto 1 isso não se aplica do mesmo modo: o HikariCP conecta ao
   Supavisor, com `POOLER_MAX_CLIENT_CONN` 1500, que enfileira sobre as 245 conexões reais.) Mitigação parcial: `max_connections` e `pool_hikari` vão para o
   CSV, e a causa dos 5xx deve ser conferida no log. Na matriz, repetições com 5xx são descartadas, não
   gravadas. Nas escadas de 2026-10-16 isso não aconteceu: com `max_connections` 100 e pool de 1000, o Postgres
   chegou a recusar um `psql` externo (`too many clients`), mas o backend não registrou erro de conexão e a
   `taxa_5xx` ficou em 0. O risco que se confirmou foi outro: a coluna `max_connections` do CSV é um rótulo e
   divergiu do valor real (300 no CSV, 100 no host).
9. **Saturação do gerador.** Se o k6 não sustenta a taxa (iterações descartadas ou `rpm_efetivo` abaixo de
   95% do alvo), o degrau mede o gerador, e X passa a limite inferior; a tolerância de 5% é fixa. Os 2000 VUs
   pré-alocados custam memória no gerador (estimativa de 1–2 MB por VU). Em 2026-10-16 o gerador limitou de três
   formas: portas efêmeras do Windows acima de ~60k RPM (corrigido com
   `netsh int ipv4 set dynamicport tcp start=10000 num=55535`; a `degraus-954833` fica como limitada pelo
   gerador), memória com 4000 VUs (escada interrompida, sem dados) e, com a carga intercalada, CPU e portas em
   160k RPM. Acima de ~140k RPM é preciso um segundo gerador.
10. **Concentração por evento crescente com o RPM na escada.** Os pares (usuário, evento) são consumidos em
    sequência (usuário `i % U`, evento `floor(i / U)`, com U = 200 usuários;
    `Projeto/carga/degraus/carga-degraus.js`), então cada evento recebe até 200 tentativas, uma após a outra
    (capacidade 100); o padrão é o mesmo descrito em `ANALISE.md`, seção 5.3, para o teste de taxa fixa. A
    carga por evento é fixa: só a duração dessa rajada por evento encurta com o RPM (200 · 60 / RPM segundos,
    conta derivada da regra de pares: cerca de 1 s a 12k RPM e 0,3 s a 40k RPM). Logo, nos degraus altos
    sobem juntas a carga total e a concentração temporal por evento (contenção na linha de `eventcap`), e o X
    confunde os dois efeitos.
11. **Degraus contíguos e timeouts fora do X.** Entre degraus só há 31 s ociosos, sem resfriamento, e a
    degradação de um degrau pode contaminar o seguinte. Um host que trava gera timeouts, contados em `outros`
    e não como 5xx; o report avisa, mas a regra do X não captura essa forma de degradação.
12. **Ambiente não caracterizado.** CPU, RAM, disco, SO e a versão do Docker Desktop do host (e RAM, disco,
    SO e o meio físico do gerador) não constam nos registros (placeholders no Setup), o que limita a
    reprodução e a leitura do X em termos de recurso. O plano de energia
    "Alto desempenho" e o host na tomada são recomendados, mas não há registro de que tenham sido aplicados.
13. **Rótulo versus configuração real.** `braco` e `lag_ms` são rotulados pelo operador no gerador, e o
    `commit` do CSV é o do checkout do gerador: o host precisa estar no mesmo commit e na mesma configuração,
    o que é conferido manualmente (`printenv`). O `lag_obs_*` permite detectar uma discrepância de lag, mas
    não de braço, de commit nem de pool.
14. **Três mudanças simultâneas no ponto 1.** O ponto 1 difere da matriz pré-pooler em três fatores ao mesmo tempo:
    (a) a fila do pooler em transaction mode (Supavisor, um salto a mais por transação), (b) PG 16 → 17 e o locale
    (`postgres:16-alpine` com `pt_BR` → `supabase/postgres:17.6` com `en_US` ICU) e (c) o teto real de conexões, de
    ~300 (HikariCP direto; a role `admin` era superuser e podia usar as 3 conexões reservadas) para 245 (`max_connections − 55`).
    O CAS ficou cerca de 2× mais lento e com 43% a 47% menos vazão. **As rodadas de isolamento foram feitas em
    2026-10-17** (subseção "Isolamento do pooler"; `docs/carga/resultados-isolamento-escada-pospooler-2026-10-17.md`): com
    o pool em 300, o p95 com N = 200 cai de 155 para 120 ms e com N = 100 quase não muda (96 contra 104 ms); sem o pooler
    (PG 17 direto), o p95 fica próximo do pré-pooler (67,4 contra 53,7 ms com N = 100; 77,1 contra 77,1 com N = 200). O
    Supavisor responde pela maior parte da piora e o teto de conexões por uma parte menor. **Resíduos:** o resto (~14 ms com
    N = 100) é o PG 17 junto com o banco limpo, que os dados não separam (ameaça 15); são 5 repetições por bloco, com
    intervalos mín–máx que se sobrepõem em parte; e os blocos de isolamento rodaram em outro dia que o ponto 1, em banco novo
    cada, na `main` `a8fc86a` e não no `8ba01b4` do ponto 1. O override do bloco (b) é local e não versionado.
15. **Banco limpo × inchado.** O ponto 1 começou com o banco limpo (volume novo); a matriz pré-pooler rodou sobre ~35
    mil eventos e ~2 milhões de `walletevent` acumulados pelas escadas do dia. O refresh do read model recalcula
    todos os eventos, então o estado do banco muda o lag efetivo do braço ingênuo (lag 500: ~1,6 s antes, 151–428 ms
    agora) e, com ele, a chance de a rajada cruzar um refresh. Também pode afetar a latência do CAS (hipótese, não
    medida). A diferença do overselling do ingênuo entre as duas matrizes acompanha o lag observado, e portanto o estado do
    banco; não foi isolada dos demais fatores (ameaça 14).

Ressalvas do ponto 2 (Rodada 2, 2026-10-19; fonte: `Projeto/carga/results/04-fase6-es/README.md`):

16. **Rede em Wi-Fi.** Nesta rodada o gerador e o host estavam em Wi-Fi, com IPs novos. A baseline
    (`baseline-20261019-074604.txt`) deu HTTP p50 26,6 / p95 42,9 ms (n = 30) e ping médio de 18,55 ms (máx. 180 ms, 0 de
    100 perdidos), contra ~15 / 19 ms no cabo das rodadas anteriores (ameaça 1). Como a baseline vem de outro cliente que
    o k6, ela não dá a parcela de rede nas latências do k6, e a parcela do Wi-Fi nelas não foi isolada. Afeta as
    latências e a vazão da matriz, do aleatório e, pelo p95 de janela, o X; o overselling do ingênuo já está no teto, e
    uma rajada mais longa não o aumentaria. A comparação de latência com as etapas anteriores fica com essa ressalva.
    O cabo volta no fim de semana; repetir no cabo é o que separa o Wi-Fi do custo do ES. O plano de energia do gerador
    foi ajustado à mão (o `setup-gerador.ps1` usou um GUID errado).
17. **Estado do banco entre os blocos e comparabilidade com o ponto 1.** Os blocos 1 a 3b (matrizes ingênuo e CAS,
    escadas com e sem consumer) rodaram sobre banco **acumulado**, sem limpeza entre eles, e o backlog do consumer foi
    crescendo; do bloco 4 em diante, o banco foi limpo antes de cada teste (TRUNCATE, tópicos e consumer group do
    Redpanda apagados, backend reiniciado). O ponto 1 rodou com banco limpo, cabo e Tomcat de 200 threads, e o ponto 2
    com Tomcat de 300. Logo, a comparação das matrizes com o ponto 1 mistura o ES, o Wi-Fi, o banco acumulado e as
    threads (por isso a matriz CAS com Tomcat 300 entra como referência); o X do pós-pooler (cabo, banco limpo) é
    comparado com o dos blocos 3 e 3b (Wi-Fi, banco acumulado); e a comparação entre os blocos 3, 3b e 5
    mistura o consumer com o estado do banco (acumulado nos dois primeiros, limpo no 5); o 3b rodou depois do 3, herdando
    o volume e o backlog dele. A `Ale-29057` (#109) não
    registra as threads do Tomcat; a #124, que fixou 300, é do mesmo dia.
18. **Imagem `:146` montada localmente.** O bloco 5 rodou com o consumer em lote (issue #146) numa imagem do backend
    montada à mão com as classes da branch `Issue-146`, porque o Maven Central estava bloqueado na rede do host (erro de
    certificado PKIX) e o `docker compose build` normal não fechava. A coluna `commit` dos CSVs desse bloco (`1ee6fbe`) é a
    do checkout do gerador e não reflete a imagem (ameaça 13).
19. **Redpanda em modo dev-container, sem fsync.** O broker sobe com `--mode=dev-container` (`docs/arquitetura/fase6-cqrs-es.md`),
    que não força gravação em disco. A latência do relay e o lag do consumer são **otimistas** em relação a um broker
    com disco durável; um lag maior só reforçaria o overselling do ingênuo, mas o custo do ES no X e no aleatório pode
    estar subestimado.
20. **`lag_obs` é limite inferior e o lag do consumer vem de amostras do host.** Na matriz, o `lag_obs_*` mede a idade do
    último evento aplicado na linha do evento, amostrada pelo gerador durante uma rajada de ~0,2 s: vale -1 no disparo
    em todas as 20 linhas (a linha só nasce com a 1ª reserva) e ficou sem leitura em 7 delas, e não mede quanto a
    projeção está atrás do "agora". O lag de consumer das escadas e do aleatório vem do offset lag do grupo, amostrado a
    cada 1 s no host (`host-lag/`; três arquivos com `ts` provavelmente em UTC, 3:00:00 à frente do nome do arquivo e do gerador (a confirmar), e o
    `lag-poll-cas` no horário local). A captura do aleatório continuou rodando depois do fim do teste (e pegou o início
    do bloco 5), e a da escada do bloco 3 parou de drenar depois do fim da carga (564.215 e depois 792.777), o que é
    compatível com o consumer desligado para o 3b. Só as janelas de cada teste entram nos números acima; os valores
    fora delas não são backlog do bloco, e o máximo do bloco 3 com o consumer ligado é 578.674.
21. **Incidentes da sessão.** O host trocou de IP durante a sessão (DHCP do Wi-Fi): a 2ª tentativa do 3b abortou antes
    do seed, com o backend inacessível no IP antigo, e a escada foi relançada no IP novo, sem efeito nos resultados já
    coletados. A 1ª tentativa do 3b (40k a 120k) foi abortada no degrau de 80k por falta de memória no gerador, sem CSV
    (o host não foi afetado), e refeita só até 80k.

## Limitações

- **Pontos 1 e 2 e X.** O ponto 1 (monólito CRUD + pooler) cobre as rodadas 1a e 1b e, desde 2026-10-17, o limiar X
  pelo pooler (≈ 78k RPM), com o 97k pré-pooler (HikariCP direto, PG 16) como referência. O ponto 2 (monólito com
  CQRS + ES, 2026-10-19) se compara com o ponto 1, não com os números pré-pooler; o ponto 3 (distribuído) vem depois
  e se compara com os dois. A comparação pré × pós-pooler dentro do ponto 1 mistura três mudanças e o estado do banco
  (ameaças 14 e 15); a do ponto 2 com o ponto 1 mistura o ES, o Wi-Fi, o banco acumulado e as threads do Tomcat
  (ameaças 16 e 17).
- **Lag sintético × lag real.** No ponto 1 o read model é recalculado por timer (lag fixo e configurável), que não é o
  atraso de uma projeção real. No ponto 2 o lag é o do consumer real, mas só foi medido como limite inferior na matriz
  (ameaça 20) e como offset lag do host nas escadas e no aleatório. A transferência para o ponto 3 (consumer em
  outro processo, banco separado) continua em aberto.
- **X anteriores preliminares; X definitivo na Rodada R.** Os X dos pontos 1 a 3 também vêm de escadas sequenciais, então
  valem a mesma leitura por evento (subseção "Limiar X definitivo"); o que os torna preliminares é a pouca repetição e as
  configurações diferentes, não a unidade. O X definitivo, ≈ 56k RPM por evento, é o da Rodada R. A ameaça 10 continua
  valendo: a rajada por evento é curta (~0,2 s a 56k) e a concentração cresce com o RPM, então o 56k é o limiar de
  contenção da linha quente, não de um evento sustentado por 60 s. O gatilho da fila (`RPM(evento) ≥ 80% de X × réplicas`,
  `docs/adr/Architecture-Decision-Async-Checkout-Queue.md`) é o das issues #111 e #112; a escala do X com as réplicas não foi
  medida.
- **Escopo do workload.** Só escrita (reserva e confirmação) com `PCT_CONFIRMA=100`; capacidade fixa em 20 e
  N ∈ \{100, 200\} na disputa; um único evento por disputa. A escada não tem leituras, e o teste aleatório
  (com leituras) ficou fora do protocolo da matriz e da escada; entra só no ponto 2, como comparação com a #109.
- **Vazão do kit anterior não usada.** Os números de "Vazão" e `reservas_por_s` do teste 1 anterior à matriz
  (`docs/carga/setup.md`, seção 6, tabela da disputa; coluna `reservas_por_s` de
  `Projeto/carga/results/02-hikari/resultados.csv`) não são reportados aqui. Há uma hipótese, **não confirmada**, de que meçam a taxa de login do
  `setup()` (bcrypt) e não a de reserva: o `duracao_s` desse teste inclui o `setup()` (`Projeto/carga/README.md`;
  `Projeto/carga/lib-matriz.ps1`). Não se afirma que estejam errados; a vazão desta seção vem só do
  `throughput` da matriz (janela da rajada) e do `throughput` da escada.
- **Amostra e execução.** 5 repetições por (lag, N) e uma execução da escada por X (três no X pelo pooler, com faixas parcialmente sobrepostas); a execução é feita pelo
  usuário no gerador, e o resultado depende do estado do host naquele dia.
- **Observabilidade.** Sem `pg_stat_statements`, sem série de recursos do host e sem medição de latência por
  endpoint (ver as ameaças 6 e 7).
