# Etapa 08: Rodada 5, saga stock + wallet sobre a configuração da R4 (issue #180)

Dois blocos, os mesmos da R4 para a comparação:
- bloco 1, braço sem autoescala, em 2026-10-29;
- bloco 2, braço C calibrado, em 2026-10-30, depois de uma espera pedida pelo usuário.

## O que estava implementado

- `Batch_2` em `850d38e` (host e gerador no mesmo commit): a configuração da etapa 07 (admission #41–#43, autoescala #111/#112, slim #177,
  kit da #178) mais a **saga `stock` + `wallet`** (#47) e o kit da R5 (#204).
- Na saga, o `reservation` (lado `wallet`) orquestra cada reserva:
  1. tx1 grava a saga em `reserving`;
  2. `POST /internal/holds` no serviço `stock` cria o hold e faz o CAS do `eventcap`;
  3. tx2 grava `reserved`, o `walletevent` e o `SlotReserved{holdId}`.
- Falha no meio tem compensação inline (`release(holdId)`), e o reaper resolve as órfãs (`reserving`/`compensating` com mais de 30 s).
  Cancelar e expirar só appendam o evento; a vaga volta pelo consumer do `stock` (group `stock`, tópico `reservation.wallet`).
- **Só a saga muda** em relação à R4: mesma escada, mesmos parâmetros do k6, mesmo `admission`, mesmas imagens slim (regeradas do
  mesmo código, agora com o `stock`), mesma autoescala.

## O que muda entre os caminhos da R4 e da R5

| Caminho | R4 | R5 (saga) |
|---|---|---|
| `cas` sucesso | gateway → reservation (1 salto); 1 transação (claim, CAS, reservePending, append) | +1 salto reservation → stock; 3 commits (tx1, hold+CAS, tx2); o lock da linha quente do `eventcap` só cobre o CAS e o commit do `stock` |
| `cas` rejeição "lotado" | 1 `INSERT` + rollback | tx1 (commit) + `stock` (rollback) + `DELETE` (commit) |
| `naive` | 2 saltos do gateway | os mesmos 2, com +1 salto interno em cada (capacidade e hold) |
| confirmar | 1 transação | igual |
| cancelar/expirar | guarda + `release` + append numa transação | guarda + append; a devolução é assíncrona no `stock` |
| `admission`, autoescala, slim, Hikari, X | — | iguais; o `stock` entra fixo (1 réplica) com Hikari 250 |

## Configuração

- **Host:** Ryzen 7 7700X, 2,5 GbE onboard (192.168.68.64), Docker com os dados em SSD NVMe.
  - `pg_test_fsync`, fdatasync, sempre &lt; 1 ms (`host-telemetria/pg_test_fsync-r5*.txt`):
    - **0,421 ms** no volume antigo (29/10, 10:5x);
    - **0,378 ms** no volume novo, depois do reset (29/10, 11:4x);
    - **0,405 ms** antes do bloco 2 (30/10).
- **Gerador:** EnzoAMD (192.168.68.54), k6 2.2.0, kit em `850d38e` (o mesmo do host).
  - RAM livre: 10,06 GB antes e 10,11 GB ao fim do bloco 1; 10,06 GB antes e 10,16 GB ao fim do bloco 2.
  - `netsh dynamicport` em 10000/55535 (o usuário reverte).
  - O Claude Code do gerador rodou com `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1` no bloco que valeu (ver "Bloco abortado").
- **Stack:** `docker-compose.carga.yml` + `rpm/docker-compose.rpm.yml` + `docker-compose.slim.yml` (+ `docker-compose.autoescala.yml` no braço C).
  - Igual à R4: `max_connections` 300, pool do Supavisor 245, READPATH `cas`, `ADMISSION_X_RPM` 56000 (a fila liga a 0,8 X × réplicas e
    volta a 0,7), janela do contador 200 ms, TTL da fila 30 s, 5 mensagens em espera por usuário.
  - Sem autoescala: Hikari do `reservation` 1000, worker pool do `admission` 32, tópicos `reservation.wallet` e `identity.notification`
    com **1 partição** (como no bloco 1 da R4: o reset recriou o broker).
  - Saga: reaper com `RESERVATION_SAGA_ORPHAN_MS` 30000 e `RESERVATION_SAGA_REAPER_SCAN_MS` 5000 (defaults). Logger `saga.timing`
    desligado: a latência dos passos ficou fora, porque o log por reserva infla a latência medida.
- **Hikari do `stock` = 250**, pela conta do Supavisor (`min(250, 1500 − soma da R4)`, com os Hikari finais da R4; nenhum `*_HIKARI`
  exportado na R4):
  - sem autoescala: 1000 (reservation) + 10 (backend) + 3 (notification) + 100 (catalog) + 100 (identity) = 1213, então
    `min(250, 287)` = 250 e o total fica em 1463;
  - braço C: 3 × 300 + 3 × 10 + 3 × 3 + 3 × 50 + 3 × 50 = 1239, então `min(250, 261)` = 250 e o total fica em 1489 ≤ 1500.
- **Imagens slim** (`gerenciador-eventos-<serviço>.slim`) regeradas do código de `850d38e`, com o `stock`. O `application.properties` do
  jar das 7 é igual ao do repositório em `850d38e` (o do `reservation` tem o reaper; o do `stock` tem a porta 8086 e o Hikari 250).
  - `gerar-imagens-slim.sh` saiu com 2 erros, os dois no probe do `admission`: o script ainda cria o `eventcap` do probe no `reservation`, e
    desde a #47 ele está no `stock` (404). Por isso o worker da imagem-alvo não foi exercitado no probe.
  - O código do `admission` não mudou desde `35955ef`. A imagem foi validada por `E2E_SLIM=1 Projeto/e2e/run-e2e.sh`, com `E2E OK`:
    as 7 slims novas rodando, e o passo 4b com o worker do `admission` criando as reservas e a fila drenada.
- **Banco:**
  - antes do preparo, backup do `meu_banco` (fora do repo);
  - migração `20261029-stock-schema.sql`: o verify em bancos descartáveis passou, a 1ª aplicação moveu o `eventcap` e fez o backfill de
    40.424 holds, e a 2ª deu só NOTICEs;
  - `DROP DATABASE meu_banco_s5` (o banco de teste da S5).
  - Depois do bloco abortado, o usuário pediu um **reset**: `pg_dumpall` completo (fora do repo) e `down -v` da stack. O `meu_banco` nasceu dos
    init scripts, com o `stock` e sem `public.event`, `public.users` ou `reservation.eventcap`.
  - Em stack nova, o `stock-seek` e o `notification-seek` saíram com código 0.
- Banco limpo antes de cada bloco (`limpar-banco.sh`: `TRUNCATE` de `public`/`reservation`/`stock`/`catalog`/`identity`, `FLUSHDB`, purge das
  filas, chave do JWT apagada, serviços religados). Seed pelo host (`preparar-degraus.ps1`); o gerador só roda `git checkout` + `k6 run`.

## Escada (igual à da R4, nos dois braços)

Sequencial, 20k → 98k RPM, passo 6k, 14 degraus de 60 s com espaço de 46 s (há acompanhamento).

- `USUARIOS=1000` (capacidade de 500 por evento, 868 eventos), `PCT_CONFIRMA=100` e `MAX_VUS=3000`.
- `PCT_ACOMPANHA=5`: 5% das 202 consultam o estado a cada 1000 ms, até 35 s.
- `PARADA_P95_MS=5000` por janela de 60 s, `SETUP_S=90` e nenhuma `Idempotency-Key` própria.

## Comandos

Host (Git Bash, pasta principal em `850d38e`); `F` = `-f docker-compose.yml -f carga/docker-compose.carga.yml -f carga/rpm/docker-compose.rpm.yml -f docker-compose.slim.yml`
(mais `-f docker-compose.autoescala.yml` no braço C):

```bash
cd Projeto && export RESERVATION_READPATH=cas PG_MAX_CONNECTIONS=300 PG_POOLER_POOL_SIZE=245
docker compose $F up -d --wait
cd carga && bash ./limpar-banco.sh          # braço C: com o scaler parado
# braço C: scaler no host, mesmos -f e ambiente, com os parâmetros calibrados do bloco 3 da R4 (exportados também no shell da coleta)
#   export AUTOESCALA_X_RPM=56000 AUTOESCALA_GATEWAY_RPS=1600 AUTOESCALA_ADMISSION_RPS=1600 AUTOESCALA_IDENTITY_RPS=200 AUTOESCALA_CATALOG_RPS=500 AUTOESCALA_NOTIFICATION_LAG=100 AUTOESCALA_DESCE_SEG=120
#   AUTOESCALA_COMPOSE_ARQUIVOS='docker-compose.yml carga/docker-compose.carga.yml carga/rpm/docker-compose.rpm.yml docker-compose.slim.yml docker-compose.autoescala.yml' Projeto/autoescala/scaler.sh
powershell.exe -NoProfile -File degraus/preparar-degraus.ps1 -HostIp 192.168.68.64 -MaxConnections 300 -PoolHikari 1000   -RpmInicio 20000 -RpmPasso 6000 -RpmMax 98000 -Duracao 60 -Usuarios 1000 -MaxVus 3000 -Mapeamento sequencial   -PctAcompanha 5 -ParadaP95Ms 5000 -ParadaJanelaS 60 -SetupS 90 -Arranjo 'sem-autoescala+slim+saga'   # braço C: -PoolHikari 300 -Arranjo 'autoescala+slim+saga' -ParamsAutoescala '...'
bash ./coleta-host.sh r5-b<n> 0 &   ;   powershell.exe -NoProfile -File telemetria-host.ps1 -Rotulo r5-b<n> -DuracaoS 7200 &
# fim do k6: a coleta segue até saga_reservando e saga_compensando = 0 (ou 45 s); só então Ctrl+C (gera saga-*.csv e resumo-saga-*.txt)
powershell.exe -NoProfile -File degraus/csv-do-resumo.ps1 -Plano results/plano-degraus-<id>.json -Resumo results/summary-degraus-<id>.json
bash ../../docs/carga/harness/report-degraus.sh results/degraus-<id>.csv results/degraus-<id>.html
powershell.exe -NoProfile -File rpm/subir-host-rpm.ps1 -Verificar -Prefixo Deg-<id>      # código 3 = overselling no CAS; 4 = órfã que não converge
```

Gerador (Windows PowerShell, raiz do clone): `git fetch origin Batch_2`, `git checkout 850d38ed0b07e1c4694f95e6c1d0a1a89a8fb67f` e a linha
`k6 run` impressa pelo `preparar-degraus.ps1` (guardada em `linha_k6` do `plano-degraus-<id>.json`). Depois, `git add -f` do resumo, commit e
`git push origin HEAD:refs/heads/R5-gerador-NN` (um ref por bloco; o resumo foi lido no host por `git show`).

## Blocos

| Bloco | Escada | Braço | Resultado |
|---|---|---|---|
| — | `Deg-57569` | sem autoescala + slim | **abortado, não usar**: o k6 foi morto no gerador pelo reaper de memória do Claude Code (fora do repo) |
| 1 | `degraus-59713` | sem autoescala + slim | 14 degraus completos, 0 5xx, 0 descartes, overselling **0**, 0 órfãs, 0 compensações |
| — | `Deg-61967` | autoescala + slim, calibrada | **não usado**: preparado em 29/10, gerador offline, pedido cancelado sem carga (fora do repo) |
| 2 | `degraus-138518` | autoescala + slim, calibrada | **parada** no 5º degrau (44k, p95 de janela 6,41 s); 6.272 5xx (5.142 reserva, 1.130 confirma), 6.610 descartes; overselling **0**, 0 órfãs, 0 compensações |

### Bloco 1 (`degraus-59713`, sem autoescala)

| RPM alvo | p50 | p95 | p99 | p95 pior janela 30 s | 202 | 429 | admitir p50 / p95 (ms) | ponta a ponta p95 (ms) |
|---|---|---|---|---|---|---|---|---|
| 20k | 12,5 | 1.551,7 | 2.516,3 | 1.944,3 | 1.654 | 0 | 1.511 / 5.882 | 2.057 |
| 26k | 10,9 | 100,1 | 307,4 | 136,8 | 0 | 0 | — | 150 |
| 32k | 14,3 | 436,1 | 900,8 | 483,3 | 106 | 0 | — (4 acompanhadas, todas `rejected`) | 377 |
| 38k | 353,6 | 1.602,8 | 2.302,7 | 1.801,3 | 18.205 | 0 | 2.235 / 6.436 | 2.817 |
| 44k | 13,3 | 922,9 | 1.494,1 | 1.035,4 | 29.604 | 0 | 2.005 / 2.362 | 2.019 |
| 50k | 6,2 | 248,4 | 485,8 | 274,2 | 35.677 | 7.814 | 8.027 / 9.047 | 8.066 |
| 56k | 5,7 | 281,2 | 520,3 | 296,2 | 30.790 | 18.002 | 10.038 / 11.084 | 10.076 |
| 62k | 5,2 | 287,4 | 549,0 | 302,4 | 31.146 | 22.794 | 9.055 / 11.068 | 10.058 |
| 68k | 5,3 | 292,5 | 501,8 | 315,2 | 29.644 | 29.539 | 10.058 / 12.071 | 11.050 |
| 74k | 4,1 | 389,7 | 659,8 | 413,3 | 23.136 | 41.185 | 16.062 / 19.090 | 15.060 |
| 80k | 5,1 | 591,3 | 989,3 | 613,4 | 18.096 | 50.440 | 20.116 / 22.162 | 13.055 |
| 86k | 8,3 | 665,7 | 1.121,5 | 778,2 | 16.523 | 58.199 | 20.336 / 24.208 | 15.369 |
| 92k | 7,2 | 542,2 | 1.008,8 | 570,1 | 17.612 | 62.486 | 19.265 / 22.199 | 15.092 |
| 98k | 8,2 | 763,3 | 1.137,6 | 866,3 | 16.579 | 68.609 | 21.139 / 23.219 | 13.205 |

Latências em ms, de todas as respostas do POST (201, 202, 409 e 429).

- Em todos os degraus: efetivo = alvo, 0 5xx, 0 `outros` e 0 descartes.
- Entre as 13.302 acompanhadas: 8.460 admitidas, 4.842 `rejected`, 0 `timed_out` e 0 `sem_estado`.
- Total: 268.772 respostas 202 e 359.068 429. `k6 run` com código 0, resumo no ref `R5-gerador-01` (`0fa9d01`).
- Banco do host depois da fila drenar:
  - 158.155 `confirmed`, 160.527 `expired` e 2.035 `pending` na verificação (`verificacoes-r5.log`); as `pending` são 202 não acompanhadas, que
    expiram em seguida pelo job (162.562 `expired` contados pela soma, sem retrato posterior);
  - 0 evento acima da capacidade.
- Fila `admission.requests`: no máximo 4.418 mensagens (bem abaixo do teto de 100.000) e 0 ao fim. A dead-letter (`admission.timed_out`)
  ficou em 0 em todas as amostras, e o k6 deu `timed_out` 0.

#### Saga no bloco 1 (`host-telemetria/resumo-saga-r5-b1-*.txt`, `saga-r5-b1-*.csv`, colunas `saga_*`/`lag_stock` da coleta)

| Métrica | Valor |
|---|---|
| Compensações por minuto (inline / reaper) | **0 / 0** em todos os minutos (`saga-r5-b1-*.csv` só com o cabeçalho) |
| Órfãs (`saga_orfas`, `reserving` com mais de 30 s) | **0** em todas as amostras; `saga_compensando` 0 em todas |
| Sagas em voo (`saga_reservando`) | máx. 295, 0 ao fim do k6 (instantâneas: tx1 comitada, à espera do `stock`/tx2) |
| Tempo até resolver (compensadas, inline / reaper) | sem amostra (nenhuma compensação) |
| Lag de devolução (`hold.updated_at − occurred_at` do Cancelled/Expired) | n 160.527, p50 **118 ms**, p95 **448 ms**, máx. 1.568 ms |
| Lag do group `stock` (`lag_stock`) | máx. 108 mensagens; 0 ao fim |
| Fim do bloco | devolução pendente 0, órfã inversa 0, sagas `reserving` 0, `compensating` 0 |
| `verificar-rpm -Prefixo Deg-59713` | RC 0: overselling 0 (868 eventos, 160.190 ativas) e invariantes da saga convergidas (velhas 0, hold `held` com saga `compensated` 0, devolução pendente 0, órfã inversa 0, `quant` divergente 0) |

O lag de devolução é uma amostra: as `pending` dos últimos ~120 s expiram depois da coleta. O p95 é o `percentile_cont` do banco, não o
rank do `awk`.

### Bloco 2 (`degraus-138518`, braço C calibrado)

Os parâmetros são só de configuração do scaler, os mesmos do bloco 3 da R4 (coluna `params_autoescala` do CSV):
`AUTOESCALA_GATEWAY_RPS=1600`, `AUTOESCALA_ADMISSION_RPS=1600`, `AUTOESCALA_IDENTITY_RPS=200` e `AUTOESCALA_DESCE_SEG=120`, com o resto
no padrão.

- Stack: Hikari 300 por réplica do `reservation`, 50 em `identity` e `catalog`, 10 workers por réplica do `admission`, `stock` fixo com
  Hikari 250 e `lb` na 8081.
- Tópicos `identity.notification` e `reservation.wallet` com 3 partições, como no braço C da R4.
- Rodou em 2026-10-30, das 09:55 às 10:03 (horário local).

| RPM alvo | efetivo | p50 | p95 | p99 | p95 pior janela 30 s | 5xx reserva / confirma | descartes | 202 | 429 | admitir p50 / p95 (ms) |
|---|---|---|---|---|---|---|---|---|---|---|
| 20k | 20.001 | 15,7 | 2.111,3 | 3.128,2 | 2.532,6 | 0 / 0 | 0 | 1.527 | 0 | 2.023 / 4.665 |
| 26k | 26.000 | 12,6 | 189,4 | 474,7 | 248,5 | 0 / 0 | 0 | 0 | 0 | — |
| 32k | 32.000 | 183,1 | 1.535,8 | 2.230,5 | 1.663,9 | 0 / 0 | 0 | 9.318 | 0 | 4.256 / 6.205 |
| 38k | 38.001 | 245,5 | 1.346,5 | 1.888,0 | 1.363,8 | 0 / 0 | 0 | 16.433 | 430 | 5.852 / 10.382 |
| 44k (parcial) | 36.190 | 1.796,3 | 6.414,5 | 7.541,6 | 7.347,1 | 5.142 / 1.130 | 6.610 | 6.444 | 0 | 4.011 / 16.799 |

- **Parada** `p95_acima_de_5000ms_em_janela_de_60s_no_degrau_44000`: código 99 do k6, esperado com a parada ligada.
  - O k6 chegou às 3000 VUs no degrau de 44k, às 10:02:36.
  - Resumo no ref `R5-gerador-02` (`2ecf85d`).
- **Entre as 1.661 acompanhadas:** 614 admitidas, 1.047 `rejected`, 0 `timed_out` e 0 `sem_estado`.
  - Total: 33.722 respostas 202 e 430 respostas 429.
- **Banco do host depois da fila drenar:** 60.899 `confirmed`, 13.840 `expired` e 0 `pending`.
  - `verificar-rpm` com código 0: **overselling 0** (868 eventos, 60.899 ativas) e invariantes da saga convergidas.
- **Fila `admission.requests`:** no máximo 2.502 mensagens.
- **Saga:**

  | Métrica | Valor |
  |---|---|
  | Compensações (inline e reaper) | 0 e 0 |
  | Órfãs e `compensating` | 0 em todas as amostras |
  | Sagas em voo (`saga_reservando`) | no máximo 484 |
  | Lag de devolução | n 10.539, p50 111 ms, p95 619 ms, máx. 1.226 ms |
  | `lag_stock` | no máximo 120 |
  | Fim do bloco | devolução pendente 0, órfã inversa 0 |

- **Réplicas × tempo** (`autoescala/replicas-20261030-094150.csv`, em UTC; local = UTC − 3):
  - `reservation`: stand-by às 12:59:01, no degrau de 32k (uso 0,58); promovida às 13:02:30, no de 44k (uso 0,83);
  - `backend`: stand-by às 12:59:30 (uso 0,61); promovida às 13:02:58 com 0 ativas na leitura do scaler (uso 999,999; o log do `lb` mostra o gw1 DOWN às 13:02:41 e às 13:03:02, e UP às 13:02:48);
  - `admission`: stand-by às 13:01:36, descartada às 13:04:38;
  - `identity`, `catalog` e `notification` ficaram em 1.
- **Os 5xx são do `lb`, de novo (#207)** (`autoescala/lb-estado-r5-b2.log` e `show stat`):
  - às 13:02:41 o health check do gw1 estoura os 2 s (`Layer7 timeout`) e o `lb` o tira do ar com 2.890 sessões ativas: "backend 'gateway' has
    no server available";
  - o gw1 volta às 13:02:48 e cai de novo às 13:03:02, com 2.542 sessões;
  - no `show stat`, o backend `gateway` tem `econ` = `hrsp_5xx` = 6.476, contra 6.272 5xx do k6. Os servidores `gw1`/`gw2` têm 0 5xx
    próprios, e `reservation` e `admission` têm 0 `econ`.

## Comparação R4 × R5 (braço sem autoescala)

Mesma escada sequencial, mesmos parâmetros do k6 e a mesma regra do X: p95 de janela de 30 s acima de 1 s, fora do aquecimento.

| | R4 bloco 1 (`46496`, sem saga) | R5 bloco 1 (`59713`, com saga) |
|---|---|---|
| Degraus completos / 5xx / descartes | 14 / 0 / 0 | 14 / 0 / 0 |
| X pelo `report-degraus` (1º degrau com p95 de janela > 1 s) | 20k (a frio, 1.340,5 ms) | 20k (a frio, 1.944,3 ms) |
| 1º degrau degradado fora do aquecimento | **32k** (26k limpo) | **38k** (26k e 32k limpos; 44k com 1.035 ms) |
| Depois do joelho | estável até 98k: p95 de janela 0,30–0,77 s de 50k a 98k | estável até 98k: p95 de janela 0,27–0,87 s de 50k a 98k |
| p50 / p95 / p99 a 20k (ms) | 7,0 / 1.005,8 / 1.736,9 | 12,5 / 1.551,7 / 2.516,3 |
| p50 / p95 / p99 a 32k (ms) | 217,3 / 1.430,3 / 1.950,7 | 14,3 / 436,1 / 900,8 |
| p50 / p95 / p99 a 56k (ms) | 4,7 / 377,9 / 654,7 | 5,7 / 281,2 / 520,3 |
| p50 / p95 / p99 a 98k (ms) | 5,2 / 748,4 / 1.253,6 | 8,2 / 763,3 / 1.137,6 |
| Taxa de 5xx | 0 em todos os degraus | 0 em todos os degraus |
| 202 / 429 no total | 258.600 / 382.921 | 268.772 / 359.068 |
| 1º degrau com 429 | 44k (4.130) | 50k (7.814) |
| Tempo até admitir p95 | 2,2–3,0 s até 38k; 15,0–29,2 s de 44k a 98k | 2,4–6,4 s até 44k; 9,0–12,1 s de 50k a 68k; 19,1–24,2 s de 74k a 98k |
| Compensações por minuto | — (sem saga) | 0 (inline e reaper) |
| Órfãs e tempo até resolver | — | 0 órfãs; sem amostra de tempo |
| Lag de devolução p50 / p95 / máx. | — (devolução síncrona na mesma transação) | 118 / 448 / 1.568 ms |
| Banco depois da fila drenar | 151.319 `confirmed`, 167.425 `expired` | 158.155 `confirmed`, 160.527 `expired`, 2.035 `pending` (expiradas depois) |
| Fila `admission.requests` (máx.) / dead-letter | 4.419 / 0 | 4.418 / 0 |
| Conexões ativas no pooler (máx.) / esperando lock (máx.) | 246 / 243 | 242 / 235 |
| CPU do host (média do contador na coleta inteira) / máx. | 75,0 / 114 | 78,8 / 114 |
| Overselling no CAS | 0 | 0 |

Leitura:
- **Neste host, com este X, a saga não custou capacidade no braço base.** Os 14 degraus passaram de novo sem 5xx e sem descartes. De 50k a 98k
  o p95 de janela ficou na mesma faixa (0,27–0,87 s contra 0,30–0,77 s), e o overselling seguiu em 0.
  - O custo aparece no p50 a frio e no 20k (12,5 ms contra 7,0 ms), e de leve nos degraus mais altos (p50 de 7,2–8,3 ms contra
    3,6–5,2 ms em 86k–98k): é o salto a mais para o `stock` e os dois commits a mais por reserva.
- **Entre 26k e 32k a R5 foi melhor que a R4**: p95 de 436 ms contra 1.430 ms em 32k, com 106 respostas 202 contra 15.001.
  - Hipótese, não medida separadamente: na saga, o lock da linha quente do `eventcap` só cobre o CAS e o commit do `stock`. Na R4 ele cobria
    também o `walletevent` e o append do event store, na mesma transação.
  - Com a linha menos tempo travada, há menos rajadas acima de 0,8 X no contador de 200 ms, e a fila liga mais tarde (38k contra 32k).
  - Esse efeito se confunde com o contador do `admission` (#206), que liga a fila por rajada. Uma escada só por braço não separa os dois.
- **A saga não deixou rastro de falha:** 0 compensações, 0 órfãs, 0 órfã inversa e devolução pendente 0 ao fim. As 160.527 devoluções
  assíncronas (expirações) chegaram ao `quant` com p95 de 448 ms, e o group `stock` nunca passou de 108 mensagens de lag.

## Comparação R4 × R5 (braço C, autoescala calibrada)

| | R4 bloco 3 (`50350`, sem saga) | R5 bloco 2 (`138518`, com saga) |
|---|---|---|
| Degraus até a parada | 3 completos + 38k parcial | 4 completos + 44k parcial |
| Parada (p95 de janela de 60 s > 5 s) | 38k (6,00 s) | 44k (6,41 s) |
| 1º degrau degradado fora do aquecimento | 26k | 32k (26k limpo, com p95 de 189 ms) |
| p50 / p95 / p99 a 20k (ms) | 7,7 / 1.257,1 / 2.052,0 | 15,7 / 2.111,3 / 3.128,2 |
| p50 / p95 / p99 a 26k (ms) | 251,9 / 1.498,0 / 2.071,3 | 12,6 / 189,4 / 474,7 |
| p50 / p95 / p99 a 32k (ms) | 554,7 / 2.731,9 / 3.884,3 | 183,1 / 1.535,8 / 2.230,5 |
| p50 / p95 / p99 a 38k (ms) | 2.119,8 / 6.001,4 / 6.928,9 (parada) | 245,5 / 1.346,5 / 1.888,0 |
| Erro: 5xx no degrau da parada (reserva / confirma) | 7.557 / 1.980 (24,1% das reservas) | 5.142 / 1.130 (14,2% das reservas) |
| Descartes no degrau da parada | 4.609 | 6.610 |
| Antes da parada | 0 5xx | 0 5xx |
| Causa dos 5xx | health check do `lb` (#207): `econ` = `hrsp_5xx` | o mesmo: `econ` = `hrsp_5xx` = 6.476 |
| 202 / 429 no total | 24.983 / 1.121 | 33.722 / 430 |
| Réplicas | `reservation` e `backend` 1 → 2 a partir do 32k | `reservation` e `backend` com stand-by no 32k, promovidas no 44k; `admission` com stand-by |
| Compensações por minuto | — | 0 |
| Órfãs e tempo até resolver | — | 0 órfãs; sem amostra de tempo |
| Lag de devolução p50 / p95 / máx. | — | 111 / 619 / 1.226 ms |
| Banco depois da fila drenar | 40.424 `confirmed`, 11.942 `expired` | 60.899 `confirmed`, 13.840 `expired` |
| CPU do host (média na coleta inteira) / máx. | 72,3 / 114 | 64,8 / 114 |
| Overselling no CAS | 0 | 0 |

Leitura:
- **O braço C com a saga parou um degrau depois do da R4** (44k contra 38k), pelo mesmo mecanismo: o health check do `lb` tira do ar o
  gateway saturado (#207). Esse limite é do `lb` neste host, e não da saga. O gateway satura antes do `reservation`/`stock`: os servidores
  `rs1`/`rs2` não têm `econ`.
- Entre 26k e 38k a R5 ficou abaixo da R4 no p95, como no braço base. A hipótese é a mesma: o lock da linha quente do `eventcap` dura menos
  na saga, e a fila liga mais tarde. O 20k a frio foi pior (2,1 s contra 1,3 s de p95), como no bloco 1.
- **Com autoescala, este host continua sem ficar estável acima do X.** O braço sem autoescala segue sendo o que cumpre o papel (bloco 1).

## Aceite (#180)

- Mesmo protocolo e configuração da R4 (escada aos poucos, `pg_test_fsync` &lt; 1 ms, RAM do gerador ≥ 8 GB, banco limpo por bloco, kit do mesmo
  commit; só a saga muda): **cumprido nos dois blocos**. O `netsh dynamicport` do gerador fica para o usuário reverter.
- CAS com overselling 0, conferido no banco do host: **cumprido** (`verificar-rpm` RC 0 nos blocos 1 e 2); também 0 no bloco abortado.
- Órfãs resolvidas em tempo limitado, medido: **cumprido**, com 0 órfãs nos dois blocos (coluna `saga_orfas` e `verificar-rpm` sem código 4).
  Não houve órfã para medir o tempo até resolver; o dry-run da #204 mediu ~10–12 s com queda provocada.
- Resultados em `08-…` com README e linha nova no `results/README.md`: **cumprido**.
- Tabela R4 × R5 (X, p50/p95/p99, erro, compensações, órfãs, tempo até resolver, lag de devolução): **feita para os dois braços**.
- A seção do artigo saiu do aceite (comentário "Atualização de aceite (2026-10-29)" da #180): nada em `docs/artigo/`.

## Anomalias

- **Bloco abortado (`Deg-57569`).** O k6 do gerador foi morto pelo reaper de memória do Claude Code ("the system is running low on memory").
  Foi a mesma causa do `Deg-28100` da R4.
  - Pela coleta do host, a carga foi de 11:22:51 a 11:40:16. O k6 completou 10 degraus (20k a 74k) e morreu 16 s depois do início do de 80k.
  - O `POST /bff/event-wallets: EOF` das 11:24:12 foi uma requisição isolada e a única linha impressa pelo `--quiet`, não o fim do teste.
  - Nenhum container caiu ou reiniciou: `RestartCount` 0 e `OOMKilled` false. Não houve `ERROR` no `reservation` nem no `stock`, e a RAM
    livre do host ficou em pelo menos 5,2 GB.
  - Overselling 0 e sagas convergidas (`verificar-rpm` RC 0). Lag de devolução: n 104.009, p50 122 ms, p95 467 ms.
  - Os arquivos parciais ficam fora do repo. A retomada (`Deg-59713`) rodou depois de um reset completo da stack, pedido pelo usuário, com
    o Claude Code do gerador sem o reaper.
- **20k a frio** de novo acima de 1 s no p95 de janela (1.944 ms), como na R4 (1.340 ms) e na etapa 06: o `report-degraus` marca o X nele.
- **Projeção de disponibilidade mais atrasada:** o lag do group `reservation` (consumer da projeção do braço `naive`, fora do caminho `cas`)
  chegou a 169.662 mensagens (`lag_projecao_ms` máx. 341 s), contra 118.598 (225 s) na R4. Drena depois do bloco e não afeta o CAS.
- **RAM livre do host** mais baixa que na R4 (mínimo de 3,5 GB contra 12,7 GB), com o `stock` como JVM a mais. Não houve pressão
  visível: nenhum container reiniciou.
- **Causa dos 5xx do bloco 2 (#207, a mesma da R4):** o health check do `lb` (`GET /actuator/health`, `inter 2s`, `fall 3`) divide as 300
  threads do Tomcat com o tráfego. Com o gateway saturado, o check estoura os 2 s e o `lb` tira a réplica com milhares de sessões ativas.
  - Nesse intervalo, toda requisição nova recebe 503 do próprio `lb` (`econ` = `hrsp_5xx`).
  - O scaler lê a mesma queda: 0 ativas no `backend`, uso 999,999, e promove a stand-by.
  - O bloco 1 não tem `lb`: lá o gateway saturado só fica lento.
  - O follow-up é o #207, depois da R5 e fora do Batch 2.
- **Limitação do sinal (#206):** o `adm:hot` é o RPM da janela de 200 ms do evento mais quente e não é suavizado. Ele oscila entre 0 e ~2× o
  oferecido. No bloco 2 o máximo lido foi 49.119, contra 76.578 no bloco 3 da R4. A calibragem mexe só nas capacidades e no
  `AUTOESCALA_DESCE_SEG`, sem mudar o código.
- **Espera de 17 h entre o preparo e o bloco 2:** o gerador ficou offline em 29/10. O bloco 2 rodou em 30/10, com a stack subida do zero sobre
  os mesmos volumes, banco limpo e seed novo. O `pg_test_fsync` deu 0,405 ms.
- O cabeçalho do `verificacoes-r5.log` traz `printenv` ausente: a imagem slim do `reservation` não tem `printenv`. É cosmético, como na R4.
- **Probe do `admission` no `gerar-imagens-slim.sh`** desatualizado desde a #47: ele cria o `eventcap` no `reservation` em vez do `stock`
  (ver "Configuração"). É follow-up; a imagem foi validada pelo e2e.

## Desvios do protocolo

- **Matriz não rodou**, como na R4 (o gerador só roda `git checkout` + `k6 run`). O CAS foi conferido no banco do host por `-Verificar`.
- **`USUARIOS` 1000**, como na R4 (a etapa 06 usou 200).
- **Reset da stack entre o bloco abortado e o bloco 1**, pedido pelo usuário: o banco nasceu dos init scripts, e não da migração. Os dois
  caminhos têm a mesma forma de schema, como o verify da `20261029` confere.
  - Efeito colateral bom: os tópicos voltaram a 1 partição. O bloco 1 da R5 ficou com 1 partição, como o bloco 1 da R4; antes do reset estavam em 3.
- **Latência dos passos da saga fora:** o logger `saga.timing` ficou desligado. Ligá-lo infla a latência do bloco, e um bloco só para ela
  não entrou nesta passada.
- **Sem telemetria do gerador** no modo direto: a saturação do gerador é lida só por `iteracoes_descartadas` (0) e `rpm_efetivo` (= alvo).
- `netsh dynamicport` do gerador fica para o usuário reverter.

## Arquivos

- `degraus-59713.csv` e `degraus-138518.csv`: uma linha por degrau, com as colunas da #178 (o parcial da parada inclusive).
- `plano-degraus-*.json`: o plano e a linha exata do k6.
- `gerador/summary-degraus-*.json`: os resumos do k6, vindos dos refs `R5-gerador-01` e `R5-gerador-02`.
- `host-telemetria/`, por bloco (`r5-b1`, `r5-b2`):
  - `telemetria-host-*.csv`: CPU, frequência e RAM;
  - `coleta-host-*.csv`: 36 colunas, com as da R5 (`lag_stock`, `lag_stock_catalog`, `saga_reservando`, `saga_orfas`, `saga_compensando`);
  - `eventos-*.csv`, `pgss-*.csv` e `registro-*.txt`;
  - `saga-*.csv`: compensações por minuto;
  - `resumo-saga-*.txt`: tempo até resolver, lag de devolução e fim do bloco;
  - `verificacoes-r5.log`: overselling e invariantes da saga dos dois blocos;
  - `pg_test_fsync-r5*.txt`.
- `autoescala/`: `replicas-20261030-094150.csv` (réplicas × tempo do bloco 2), `scaler-r5-b2.log` e `lb-estado-r5-b2.log` (ciclo de vida dos
  servidores no HAProxy, com horário).
- Fora do repo: o bloco abortado (`Deg-57569`) e o bloco 2 sem carga (`Deg-61967`).
