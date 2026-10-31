# Harness de carga — issue #11

Cenário de N clientes concorrentes disputando uma `capacity` finita, coleta de
corretude (`confirmed` vs `capacity`), latência p50/p95/p99, throughput
(reservas/s) e lag observado do read model. Saída em CSV + gráfico HTML.

Complementa `docs/testes-manuais/overselling-sob-concorrencia.sh` (que prova
não-overselling com 2 usuários e capacity=1, no nível HTTP): este harness
generaliza para N clientes e agrega métricas de desempenho.

## Papel deste harness: sanity local

Este harness é **só sanity local**: roda tudo na própria máquina da stack
(`docker exec` para o banco, k6 em container na rede Docker), o que serve para
conferir rapidamente que o cenário, a coleta de lag e o relatório funcionam.
**O runner oficial do experimento da Fase 2 é o kit `Projeto/carga`** (ver o
`README.md` de lá): o k6 roda numa máquina geradora separada, a matriz
(`make test-matriz`) varre N e repetições e mede o lag real do consumer, e consulta o Postgres do host por `psql` remoto, e `make
report-matriz` gera o gráfico overselling × lag (`report-matriz.sh`, nesta
pasta). Números para o artigo vêm dele, não deste harness (latência medida
com o k6 no mesmo host não é válida).

O seed (`setup.sh`) é a fonte única dos dois.

## Arquivos

| Arquivo | Papel |
|---|---|
| `run.sh` | Orquestrador: probe → setup → collector (bg) → k6 → verify → report. É o que você roda. |
| `setup.sh` | Cria a fixture: host + N attendees + evento com `capacity` fixa (via `POST /bff/seed`), loga cada attendee e escreve os tokens. Também é o seed único do kit `Projeto/carga` (variáveis opcionais `EVENTS`, `EVENT_NAME_PREFIX`, `SEM_TOKENS`, `USERS_FILE`, `EVENT_IDS_FILE`; ver o cabeçalho do script). |
| `scenario.js` | Script k6: N VUs, 1 iteração cada, disparo simultâneo (`per-vu-iterations`). Cada VU faz `addLink` e, se aceito, `confirm`. |
| `collector.sh` | Amostra `applied_at - last_occurred_at` de `event_availability` (lag real da projeção assíncrona, #29) via `psql`, em background, durante a rodada. |
| `verify.sh` | Depois da carga, lê `eventcap`/`walletevent` **direto do banco** (fonte de verdade) e calcula o veredito de corretude. |
| `report.sh` | Junta k6 + verify + lag num CSV final + gráfico HTML autocontido (SVG inline, sem lib externa). |
| `report-selftest.sh` | Auto-teste de `report.sh` com fixture sintética (sem precisar de stack no ar) — ver seção própria abaixo. |
| `report-matriz.sh` | **Não faz parte do `run.sh`**: lê o CSV da matriz do kit `Projeto/carga` (`results/matriz.csv`) e gera o gráfico HTML/SVG (overselling × lag, p95 × lag, tabela), com eixo x linear em ms: o braço `naive` é uma curva por lag e o `cas`, que não depende do lag, uma linha de referência tracejada. Usado por `make report-matriz`. |
| `report-matriz-selftest.sh` | Auto-teste de `report-matriz.sh` com duas fixtures (2 braços × 2 lags × 2 N, BOM + CRLF; e a forma da rodada 1b: `naive` em 4 lags + `cas` em 1, com grupo/CSV sem `cas`). Só bash/awk. |
| `report-degraus.sh` | **Não faz parte do `run.sh`**: lê o CSV da escada de carga em degraus do kit `Projeto/carga` (`results/degraus-<id>.csv`) e gera a curva latência/throughput × carga com o degrau X (ou o limite inferior) marcado; é o único lugar onde a regra do X é decidida. Usado por `make report-degraus`. |
| `report-degraus-selftest.sh` | Auto-teste de `report-degraus.sh` (X por 5xx das reservas, 5xx só da confirmação não decide X, CSV no formato antigo recusado, X por p95 em janela, gerador saturado antes de X, nenhum degrau degradado). Só bash/awk. |
| `resultados/` | Saída de cada rodada (`run.sh` cria `resultados/<sufixo>/`); **não versionado** (`.gitignore` local), mesma regra do `CLAUDE.md` da raiz para relatórios gerados. |

## Pré-requisitos

```bash
docker compose -f Projeto/docker-compose.yml up -d --build db backend
```

Só isso — `run.sh` roda o k6 via container efêmero (`grafana/k6`, baixado na
primeira execução), no mesmo espírito do `Projeto/Backend/run-tests.sh` para
o Maven. Não precisa instalar k6 nem nada localmente.

## Rodar um smoke run local

```bash
docs/carga/harness/run.sh
# ou parametrizado:
N=30 CAPACITY=10 docs/carga/harness/run.sh
```

Ao final, imprime o caminho de cada artefato gerado em
`resultados/<sufixo>/`:

- `tokens.json` — tokens JWT dos attendees (entrada do k6).
- `lag.csv` — série de amostras `(timestamp_epoch, lag_ms)` do read model.
- `verify.csv` — `capacity`, `confirmadas`, `pendentes`, `veredito_corretude`.
- `k6-summary.json` / `k6-metrics.csv` — saída bruta do k6.
- `resultado.csv` — **CSV final** (formato longo `metrica,valor,unidade`), junta tudo.
- `resultado.html` — **gráfico** (barras de latência p50/p95/p99 + linha de
  lag ao longo da rodada + tabela-resumo), abra num navegador.

Por padrão a fixture (usuários + evento) é removida ao final
(`MANTER_DADOS=1` para preservar e inspecionar manualmente).

### Variáveis de ambiente principais

Ver o cabeçalho de `run.sh` para a lista completa comentada. As mais usadas:

| Variável | Default | O que é |
|---|---|---|
| `N` | `10` | nº de attendees / VUs concorrentes disputando a capacity |
| `CAPACITY` | `4` | capacity do evento-fixture (`eventcap.capacity`) |
| `BASE_URL_K6` | `http://backend:8081` | URL do backend visto de **dentro** do container do k6 (rede Docker local; o experimento oficial não usa este caminho — ver o kit `Projeto/carga`) |
| `BASE_URL_PROBE` | `http://localhost:8081` | URL usada pelo probe inicial e por `setup.sh`, rodando **nesta máquina** |
| `READPATH` | `cas` | só rotula o relatório final — **não troca o braço em runtime** (ver abaixo) |
| `COLLECTOR_INTERVAL_S` | `1` | intervalo (s) entre amostras de lag do `collector.sh` — ver limitação abaixo em rodadas com N alto |

## Braço `cas` (default) vs. `naive` (experimento)

`RESERVATION_READPATH` é um `@Value` do Spring (`reservation/EventWalletService`),
lido **só no startup** do backend — o harness não troca isso em tempo de
execução. Pra rodar o braço "ingênuo" neste harness (sanity local; o
experimento oficial usa a matriz do kit `Projeto/carga`), suba o backend com a
env var setada **antes** de chamar `run.sh`:

```bash
# Projeto/.env (ou export antes do docker compose):
RESERVATION_READPATH=naive

docker compose -f Projeto/docker-compose.yml up -d --build backend
READPATH=naive docs/carga/harness/run.sh
```

No braço `naive`, `verify.sh` pode reportar `veredito_corretude=OVERSELL`
(`confirmadas > capacity`) — isso **não é um bug do harness nem do backend**:
é o fenômeno de controle do experimento (overselling proporcional ao lag do
read model, ver `Projeto/Backend/CLAUDE.md`). No braço `cas`, overselling
seria um bug real.

## Interpretação: "confirmed vs capacity" (suposição desta issue)

A reserva é em duas fases (`addLink` → `pending`, `confirm` → `confirmed`).
O Aceite da issue pede corretude como `confirmed` vs `capacity`, mas não
detalha o fluxo — decisão tomada aqui: cada VU do `scenario.js`, se `addLink`
retornar `201 pending`, encadeia imediatamente um `confirm`. A corretude final
é sempre lida do banco (`verify.sh`: `count(*) walletevent WHERE status =
'confirmed'` vs `eventcap.capacity`), nunca só pela resposta HTTP observada
pelo k6 — o k6 registra sucesso/lotado/erro em contadores customizados
(`reservas_confirmadas`, `reservas_lotadas`, `reservas_erro`) só para
diagnóstico, não como fonte de verdade.

## Limitação metodológica: overhead do polling de lag em N alto

`collector.sh` amostra o lag chamando `docker exec ... psql` a cada
`COLLECTOR_INTERVAL_S` segundos (default `1`), em background, durante toda a
rodada — cada amostra abre um processo `docker exec` + uma conexão nova ao
Postgres. Em rodadas pequenas (dezenas de VUs, o smoke run local) o custo é
desprezível frente à carga do k6. Em rodadas de N alto neste harness (mesmo
host do banco), esse polling compete por CPU/IO com o próprio banco sob teste
e pode introduzir ruído na latência/throughput observados — achado da review
automática do Gemini na PR #82. (O runner oficial, `Projeto/carga`, amostra por
`psql` remoto a partir do gerador, sem `docker exec` no host; o intervalo é
`-PollMs`, padrão 250 ms.) Mitigação: para
N grande, aumente `COLLECTOR_INTERVAL_S` (ex.: `2`–`5`s) e leve isso em conta
na seção de "ameaças à validade" do rascunho do artigo (issue #14) — o lag do
read model muda na casca de segundos (job padrão a cada 5000ms), então uma
amostragem mais espaçada ainda captura a série real sem perder resolução
relevante.

## Lag da projeção: por que pode aparecer `-1` nas primeiras amostras

`collector.sh` grava `-1` quando `event_availability` ainda não tem linha
para o evento (a linha só nasce quando o consumer aplica o 1º evento do
evento: append → relay → Redpanda → consumer). Numa rodada pequena (poucos
VUs), o k6 termina em bem menos de 1 segundo. Por isso `run.sh` espera
`COLLECTOR_COOLDOWN_S` (default 6s) **depois** do k6 terminar antes
de parar o collector, garantindo pelo menos 1 leitura real na maioria das
rodadas. `resultado.csv` distingue `lag_amostras` (total, inclui os `-1`) de
`lag_leituras_validas` (só as reais) — `lag_max`/`lag_medio` são calculados só
sobre as válidas (`0.0` com `lag_leituras_validas=0` significa "sem leitura
ainda", não "lag zero").

## Auto-teste de `report.sh` (`report-selftest.sh`)

`report.sh` é o único script desta pasta com lógica não trivial que **não**
depende de infra externa (não bate em HTTP nem no banco — só agrega os
arquivos que os outros scripts produzem). Por isso, ao contrário de
`setup.sh`/`collector.sh`/`verify.sh`/`run.sh` (que só fazem sentido contra a
stack real), ele é testável com fixture sintética, no mesmo espírito de
`docs/testes-manuais/overselling-sob-concorrencia.sh`: as asserções são o
teste, saem com código != 0 se algo bater errado.

```bash
docs/carga/harness/report-selftest.sh              # green esperado
REPRODUZIR_FALHA=1 docs/carga/harness/report-selftest.sh   # reproduz a
                                                             # assinatura de
                                                             # falha (p(95)
                                                             # errado no
                                                             # fixture) de
                                                             # propósito
```

Não precisa de Docker/stack no ar — só de `bash`/`awk`.

## Por que HTML+SVG inline e não uma lib de gráfico

Não há Python nem Node.js neste repo (só Java/Maven no backend e Flutter no
frontend) — nada de matplotlib/plotly/Chart.js. `report.sh` gera um HTML
autocontido com SVG desenhado à mão (barras de latência, linha de lag),
seguindo a skill `dataviz` do projeto (paleta validada para contraste/CVD,
marcas finas, grid recessivo, cor reservada para o veredito de corretude —
verde = OK, vermelho = OVERSELL). Abra o arquivo `resultado.html` direto no
navegador.
