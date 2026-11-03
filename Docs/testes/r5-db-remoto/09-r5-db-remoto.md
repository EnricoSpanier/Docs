# Etapa 09: R5-db-remoto, braço base da R5 com o Postgres numa máquina dedicada (issue #227)

Repete o bloco 1 da R5 (`degraus-59713`, etapa 08) com uma diferença: o container `db` (Supabase Postgres 17) sai do host e vai para um Dell
dedicado. É a opção A da #227: o Supavisor e todos os serviços seguem no host, e só a conexão pooler → db atravessa a rede. Um bloco, em
2026-11-01, com o k6 das 05:04:08Z às ~05:29:46Z (02:04 às 02:29, horário local; `duracao_s` de 1.537,8 s no resumo do k6).

## O que estava implementado

- O código de `850d38e`, o mesmo da R5. O host rodou a `Issue-227` (`e157d53`), igual a `850d38e` fora de docs, resultados e do override
  novo. O gerador fez checkout de `850d38e`.
- **Nota sobre o plano:** o `plano-degraus-283330.json` e a coluna `commit` do CSV registram `e157d53`, o HEAD da `Issue-227` no host na
  hora do seed. O k6 que rodou é o de `850d38e`: o `git diff 850d38e e157d53 -- Projeto/carga/degraus Projeto/carga/*.js docs/carga/harness`
  sai vazio.
- As 7 imagens slim são as da R5 (`:r5-850d38e`):
  - backend 7f48f4894a94, identity 5392c7408fb4, catalog d0a2ee3e15a5 e reservation 786fe8acaeb8;
  - stock 03bf3568efde, notification b2bf00ec4d9e e admission 599eeac0e283.
- **Override `Projeto/docker-compose.db-remoto.yml`**, somado aos 4 `-f` do bloco 1 da R5:
  - o `db` local sai do `up` (profile `db-local`);
  - `supabase-pooler` e `meta` apontam para `${DB_REMOTO_HOST}:5433`, sem default (sem a variável, o compose recusa);
  - o `redpanda` usa um volume novo (`redpanda-data-db-remoto`), e os tópicos nascem com 1 partição, como no bloco 1 da R5. O volume
    antigo, com 3 partições do braço C, ficou intacto;
  - um cliente `psql` de longa duração (`gerenciador-db-remoto`) compartilha a rede de uma ponte TCP (`gerenciador-db-ponte`, `alpine/socat`,
    127.0.0.1:5432 → Dell:5433). Assim o kit roda com `CONTAINER_DB`/`CARGA_DB=gerenciador-db-remoto` sem mudar `limpar-banco.sh`,
    `coleta-host.sh` nem `subir-host-rpm.ps1`;
  - as senhas ficam só dentro do container: a do usuário do app vem pela mesma variável que o `db` base usa, e a do `supabase_admin` (usada
    pela coleta) vem do `supabase/.env` montado só-leitura. As duas vão para um pgpass com modo 600, e não há `PGPASSWORD` global.

## Configuração

- **Host:** igual à R5. Ryzen 7 7700X, 2,5 GbE onboard (192.168.68.64), Docker com os dados em SSD NVMe. Sem o `db`, ele roda o pooler,
  os 7 serviços, Redpanda, Redis e RabbitMQ.
- **Dell (banco):** Latitude 3420, Ubuntu, i5-1135G7, 14 GB, NVMe, Ethernet 1 Gb (192.168.68.50:5433). Container `gerenciador-db` com
  `supabase/postgres:17.6.1.136` e os init scripts da `main`, banco novo, firewall liberando só o host.
- **Gerador:** EnzoAMD (192.168.68.54), k6 2.2.0, clone em `850d38e`. RAM livre de 9,35 GB antes e 9,63 GB ao fim. Rodou com
  `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1`.
- **Stack** (como no bloco 1 da R5):
  - `max_connections` 300, pool do Supavisor 245, READPATH `cas`, `ADMISSION_X_RPM` 56000;
  - Hikari: reservation 1000, stock 250, identity 100, catalog 100 e backend 10;
  - worker pool do `admission` 32;
  - reaper com os defaults (30000 / 5000 ms) e logger `saga.timing` desligado.
- **GUCs** (`banco/gucs-dell.txt` e `banco/gucs-comparacao.txt`): **iguais** às do `db` local da R5.
  - `shared_buffers` e `effective_cache_size` 128MB, `work_mem` 4MB, `maintenance_work_mem` 64MB.
  - `synchronous_commit` on, `wal_level` logical, `max_wal_size` 1GB, `checkpoint_timeout` 5min, `fsync` on, `wal_buffers` 4MB e
    `full_page_writes` on.
  - As da R5 saíram, sem subir o db, do `postgresql.conf` da imagem, do volume `db-config` e do `postgresql.auto.conf` (vazio), com o
    `max_connections` dado pelo override rpm.
- **O que difere entre o host e o Dell:**

  | | Host (R5) | Dell (R5-db-remoto) |
  |---|---|---|
  | CPU do banco | Ryzen 7 7700X, dividido com o resto da stack | i5-1135G7, só o banco |
  | `pg_test_fsync`, fdatasync | 0,378–0,421 ms por operação, seção de uma escrita de 8kB (`08-rodada5-saga/host-telemetria/pg_test_fsync-r5*.txt`) | ~0,79 ms por operação (informado pela sessão do Dell, #227; não versionado); `f_await` sob carga ~0,52 ms (`dell/iostat-nvme0n1.txt`) |
  | Rede pooler → db | rede bridge do Docker, no mesmo host | NAT do Docker Desktop → Ethernet 1 Gb → Dell |

- **RTT host → Dell** (`banco/rtt.txt`, com a stack ociosa, depois do seed):
  - `select 1` por psql na mesma sessão, pelo caminho do pooler (rede do Docker até `Dell:5433`): p50 **0,447**, p95 **0,604**, p99
    **0,751** ms (n 500);
  - pela ponte (o caminho do kit): 0,562 / 0,704 / 0,982 ms;
  - TCP connect a partir do Windows: 0,152 / 0,197 / 0,305 ms; ping abaixo de 1 ms.
- **Preparo:**
  - `config --quiet` passou com e sem `DB_REMOTO_HOST`.
  - `up -d --wait`, sem `--build`.
  - Smoke pelo pooler: seed de 2 usuários, depois reserva 201 e confirmação 200.
  - Banco limpo pelo kit (`limpar-banco.sh` pela ponte).
  - Seed pelo host: 1000 usuários e 868 eventos com capacidade 500, host com `user_id=2`.

## Escada

A mesma do bloco 1 da R5: sequencial de 20k a 98k RPM, passo de 6k, 14 degraus de 60 s.
- `USUARIOS=1000`, `PCT_CONFIRMA=100`, `MAX_VUS=3000`;
- `PCT_ACOMPANHA=5`, `CONSULTA_MS=1000`, `TETO_CONSULTA_S=35`;
- `PARADA_P95_MS=5000`, `PARADA_JANELA_S=60`, `SETUP_S=90`, sem `Idempotency-Key` própria.

Só mudam `SUFIXO`/`RUN_ID`, que agora são 283330.

## Comandos

Host (Git Bash, pasta principal na `Issue-227`). `F` é `-f docker-compose.yml -f carga/docker-compose.carga.yml -f carga/rpm/docker-compose.rpm.yml -f docker-compose.slim.yml -f docker-compose.db-remoto.yml`:

```bash
cd Projeto && export RESERVATION_READPATH=cas PG_MAX_CONNECTIONS=300 PG_POOLER_POOL_SIZE=245 DB_REMOTO_HOST=192.168.68.50
docker compose $F up -d --wait
cd carga && CONTAINER_DB=gerenciador-db-remoto bash ./limpar-banco.sh
$env:CARGA_DB='gerenciador-db-remoto'; ./degraus/preparar-degraus.ps1 -HostIp 192.168.68.64 -MaxConnections 300 -PoolHikari 1000 -RpmInicio 20000 -RpmPasso 6000 -RpmMax 98000 -Duracao 60 -Usuarios 1000 -MaxVus 3000 -Mapeamento sequencial -PctAcompanha 5 -ParadaP95Ms 5000 -ParadaJanelaS 60 -SetupS 90 -Arranjo 'sem-autoescala+slim+saga+db-remoto'   # PowerShell
CONTAINER_DB=gerenciador-db-remoto bash ./coleta-host.sh r5db 0 &   ;   powershell.exe -NoProfile -File telemetria-host.ps1 -Rotulo r5db -DuracaoS 7200 &
# fim do k6: a coleta segue até saga_reservando = saga_compensando = 0; então Ctrl+C (gera saga-*.csv e resumo-saga-*.txt)
powershell.exe -NoProfile -File degraus/csv-do-resumo.ps1 -Plano results/plano-degraus-283330.json -Resumo results/summary-degraus-283330.json
bash ../../docs/carga/harness/report-degraus.sh results/degraus-283330.csv results/degraus-283330.html
$env:CARGA_DB='gerenciador-db-remoto'; ./rpm/subir-host-rpm.ps1 -Verificar -Prefixo Deg-283330   # PowerShell; 3 = overselling, 4 = órfã
```

Gerador: `git checkout 850d38ed0b07e1c4694f95e6c1d0a1a89a8fb67f`, depois a linha `k6 run` (`linha_k6` do plano, trocando o checkout), o
`git add -f` do resumo e `git push origin HEAD:refs/heads/R5DB-gerador-01` (`56e337e`). O ref era temporário e já foi removido do
remoto; o conteúdo está em `gerador/summary-degraus-283330.json`, com o mesmo blob do commit `56e337e`.

## Bloco (`degraus-283330`)

| RPM alvo | p50 | p95 | p99 | p95 pior janela 30 s | 202 | 429 | admitir p50 / p95 (ms) | ponta a ponta p95 (ms) |
|---|---|---|---|---|---|---|---|---|
| 20k | 30,9 | 1.754,7 | 2.665,0 | 2.138,8 | 1.571 | 0 | 2.024 / 3.549 | 2.712 |
| 26k | 28,9 | 343,0 | 716,0 | 345,2 | 0 | 0 | — | 329 |
| 32k | 225,9 | 1.364,0 | 1.834,3 | 1.385,6 | 6.285 | 0 | 1.007 / 1.017 | 1.140 |
| 38k | 600,5 | 2.116,7 | 2.828,4 | 2.418,5 | 17.629 | 325 | 2.925 / 13.187 | 4.031 |
| 44k | 13,4 | 962,3 | 1.619,9 | 1.060,3 | 30.262 | 2.833 | 8.028 / 9.794 | 8.056 |
| 50k | 8,2 | 300,0 | 544,1 | 303,5 | 28.968 | 14.831 | 10.056 / 14.082 | 12.084 |
| 56k | 7,5 | 294,8 | 510,4 | 300,9 | 29.539 | 19.222 | 10.063 / 12.063 | 11.070 |
| 62k | 6,9 | 291,2 | 509,5 | 305,1 | 29.792 | 24.154 | 10.051 / 12.056 | 10.105 |
| 68k | 6,2 | 294,6 | 512,3 | 327,1 | 29.811 | 29.269 | 10.046 / 11.062 | 10.086 |
| 74k | 5,6 | 267,9 | 468,2 | 268,0 | 29.835 | 34.508 | 11.037 / 12.088 | 11.065 |
| 80k | 5,2 | 255,3 | 447,7 | 283,2 | 28.317 | 42.309 | 11.048 / 12.079 | 11.097 |
| 86k | 6,1 | 339,0 | 520,5 | 378,0 | 26.551 | 48.293 | 12.063 / 13.089 | 12.068 |
| 92k | 6,1 | 301,8 | 501,6 | 314,0 | 26.735 | 53.294 | 12.064 / 14.061 | 12.070 |
| 98k | 7,0 | 410,3 | 597,9 | 470,2 | 25.052 | 60.179 | 13.058 / 14.109 | 11.490 |

As latências estão em ms e cobrem todas as respostas do POST (201, 202, 409 e 429).

- Em todos os degraus: efetivo = alvo, 0 5xx, 0 `outros` e 0 descartes. `k6 run` saiu com código 0, sem parada.
- Das 15.365 reservas acompanhadas: 10.329 admitidas, 5.036 `rejected`, 0 `timed_out` e 0 `sem_estado`. No total, 310.347 respostas 202 e
  329.217 respostas 429.
- **Banco do Dell depois da fila drenar** (`host-telemetria/verificacoes-r5db.log`):
  - 154.455 `confirmed`, 186.477 `expired` e 10.403 `pending`. As `pending` são 202 não acompanhadas e expiram em seguida pelo job;
  - 164.958 ativas e **0 evento acima da capacidade**.
- **Fila `admission.requests`:** no máximo 4.412 mensagens e 0 ao fim. A dead-letter ficou em 0.
- **Saga** (`host-telemetria/resumo-saga-r5db-*.txt`, `saga-r5db-*.csv` e as colunas `saga_*`/`lag_stock` da coleta):

  | Métrica | Valor |
  |---|---|
  | Compensações por minuto (inline / reaper) | **0 / 0** (`saga-r5db-*.csv` só com o cabeçalho) |
  | Órfãs (`saga_orfas`) e `saga_compensando` | **0** em todas as amostras |
  | Sagas em voo (`saga_reservando`) | no máximo 295, 0 ao fim do k6 |
  | Lag de devolução | n 176.377, p50 **224 ms**, p95 **640 ms**, máx. 1.958 ms |
  | `lag_stock` | no máximo 117, 0 ao fim |
  | Fim do bloco | devolução pendente 0, órfã inversa 0, sagas `reserving` 0 e `compensating` 0 |
  | `verificar-rpm -Prefixo Deg-283330` | RC 0: overselling 0 e invariantes da saga convergidas (velhas 0, hold `held` com saga `compensated` 0, devolução pendente 0, órfã inversa 0, `quant` divergente 0) |

## Comparação R5 bloco 1 × R5-db-remoto (braço sem autoescala)

A escada, os parâmetros do k6, o código e as imagens são os mesmos. A regra do X também: p95 de janela de 30 s acima de 1 s, fora do aquecimento.

| | R5 bloco 1 (`59713`, db no host) | R5-db-remoto (`283330`, db no Dell) |
|---|---|---|
| Degraus completos / 5xx / descartes | 14 / 0 / 0 | 14 / 0 / 0 |
| X pelo `report-degraus` (1º degrau com p95 de janela > 1 s) | 20k (a frio, 1.944,3 ms) | 20k (a frio, 2.138,8 ms) |
| 1º degrau degradado fora do aquecimento | **38k** (26k e 32k limpos; 44k com 1.035 ms) | **32k** (1.385,6 ms; 26k limpo com 345 ms; 38k com 2.418,5 ms e 44k com 1.060 ms) |
| Depois do joelho (p95 de janela de 50k a 98k) | 0,27–0,87 s | **0,27–0,47 s** |
| p50 / p95 / p99 a 20k (ms) | 12,5 / 1.551,7 / 2.516,3 | 30,9 / 1.754,7 / 2.665,0 |
| p50 / p95 / p99 a 26k (ms) | 10,9 / 100,1 / 307,4 | 28,9 / 343,0 / 716,0 |
| p50 / p95 / p99 a 32k (ms) | 14,3 / 436,1 / 900,8 | 225,9 / 1.364,0 / 1.834,3 |
| p50 / p95 / p99 a 38k (ms) | 353,6 / 1.602,8 / 2.302,7 | 600,5 / 2.116,7 / 2.828,4 |
| p50 / p95 / p99 a 56k (ms) | 5,7 / 281,2 / 520,3 | 7,5 / 294,8 / 510,4 |
| p50 / p95 / p99 a 80k (ms) | 5,1 / 591,3 / 989,3 | 5,2 / 255,3 / 447,7 |
| p50 / p95 / p99 a 98k (ms) | 8,2 / 763,3 / 1.137,6 | 7,0 / 410,3 / 597,9 |
| Taxa de 5xx | 0 em todos os degraus | 0 em todos os degraus |
| 202 / 429 no total | 268.772 / 359.068 | 310.347 / 329.217 |
| 1º degrau com 202 em volume / com 429 | 38k / 50k (7.814) | 32k (6.285) / 38k (325) |
| Tempo até admitir p95 | 2,4–6,4 s até 44k; 9,0–12,1 s de 50k a 68k; 19,1–24,2 s de 74k a 98k | 1,0–3,5 s até 32k; 9,8–13,2 s em 38k–44k; 11,1–14,1 s de 50k a 98k |
| Compensações por minuto | 0 (inline e reaper) | 0 (inline e reaper) |
| Órfãs e tempo até resolver | 0 órfãs; sem amostra de tempo | 0 órfãs; sem amostra de tempo |
| Lag de devolução p50 / p95 / máx. | 118 / 448 / 1.568 ms | 224 / 640 / 1.958 ms |
| Banco depois da fila drenar | 158.155 `confirmed`, 160.527 `expired`, 2.035 `pending` | 154.455 `confirmed`, 186.477 `expired`, 10.403 `pending` |
| Fila `admission.requests` (máx.) / dead-letter | 4.418 / 0 | 4.412 / 0 |
| Pooler: conexões ativas (máx.) / esperando lock (máx.) | 242 / 235 | 242 / 237 |
| CPU do host, contador na coleta inteira (média / máx.) | 78,8 / 114 | 84,6 / 113 |
| CPU do host do início do 1º ao fim do 14º degrau (média) | 85,7 | 93,2 |
| CPU do host por degrau (média) | 95 a 20k e 26k; 103–111 de 32k a 98k | 105–106 a 20k e 26k; 108–112 de 32k a 98k |
| RAM livre do host: início da coleta → mínimo (consumo) | 10,5 → 3,5 GB (~7,0 GB) | 37,5 → 32,7 GB (~4,9 GB) |
| Lag do consumer da projeção (`lag_reservation`, máx.) | 169.662 | 434.392 |
| Overselling no CAS | 0 | 0 |

Leitura:
- **O banco fora do host não mudou a corretude nem a estabilidade:** de novo 14 degraus sem 5xx e sem descartes, overselling 0, 0 compensações
  e 0 órfãs.
- **Entre 26k e 38k ficou pior.** O p95 de 26k foi de 100 para 343 ms, o primeiro degrau degradado veio um passo antes (32k contra 38k), e a
  fila ligou mais cedo: 6.285 respostas 202 em 32k contra 106, e 429 já em 38k.
  - Hipótese: cada transação passa a pagar o RTT (~0,45 ms de ida e volta, p50 do `select 1`) e o flush do WAL no disco do Dell
    (`f_await` ~0,52 ms sob carga). O lock da linha quente do `eventcap` fica mais tempo travado por commit, e o contador do `admission`
    vê mais rajadas acima de 0,8 X.
  - Explicação concorrente: o host já estava no teto de CPU a 20k e 26k (105–106 contra 95 na R5; ver "Gargalo"), o que também
    deixaria o caminho síncrono mais lento nesses degraus.
  - Com uma escada só, não dá para separar a rede, o disco e a CPU do host.
- **A partir de 74k ficou melhor:** p95 de janela de 0,27–0,47 s contra 0,41–0,87 s, e o tempo até admitir p95 ficou em 12,1–14,1 s
  contra 19,1–24,2 s.
  - Hipótese: com a fila já ligada desde 32k, o worker pool (32) drena num ritmo estável.
  - Não foi CPU liberada: a CPU do host foi maior em todos os degraus (105–112 contra 95–111).
  - A RAM não serve de evidência. O consumo no bloco foi menor (~4,9 contra ~7,0 GB, do início da coleta ao mínimo), mas o estado
    inicial difere: 37,5 GB livres no início contra 10,5 GB na R5, provavelmente pelo restart do Docker Desktop antes do preparo (ver
    "Anomalias e desvios").
  - A causa não está medida.
- **A devolução assíncrona da vaga ficou mais lenta** (p95 de 640 contra 448 ms), mas sem acumular: `lag_stock` no máximo 117, devolução
  pendente 0 ao fim.
- **A projeção de disponibilidade (braço `naive`, fora do caminho `cas`) ficou bem mais atrasada:** 434 mil mensagens de lag contra 170 mil, e
  ainda ~428 mil no fim da coleta. O `EventAvailabilityConsumer` é em lote desde a #146 (`max.poll.records` 500, um commit por lote), mas
  dentro do lote os statements saem por evento. A hipótese é que cada um paga o RTT até o Dell; o custo por evento não foi medido.

## Dell (coleta da máquina do banco)

O coletor da sessão do Dell gravou de 05:03:57Z a 05:33:00Z, a cada 1 s, e cobre o k6 inteiro. Arquivos em `dell/`, vindos do
`coleta-227.tar.gz` (sha256 `81271167…44c63`, informado pela coleta; não verificável pelo repo, porque o tar não foi versionado). O ref
`R5DB-dell-01` que o trouxe era temporário e já foi removido; o conteúdo está nesta pasta:
- `mpstat.txt` e `vmstat.txt`;
- `iostat-nvme0n1.txt`: o iostat filtrado no disco do banco (timestamps, `avg-cpu` e a linha `nvme0n1`);
- `psi.txt`: `/proc/pressure` de cpu, io e memória;
- `pg_activity.csv`: contagem por `state` do `pg_stat_activity`, a cada 5 s;
- `inicio.txt` e `fim.txt`;
- `sar-filtrado.csv`.

O `sar.csv` original tinha 27,9 MB. Dele ficaram só as seções de CPU (todas as CPUs), memória, `runq`/load, disco `nvme0n1`, interface
`enp44s0` (Ethernet) e PSI. O `sar.bin` (44 MB) não entrou.

Janelas por degrau em UTC: o degrau k começa em 05:05:38Z + k × 106 s (o `SETUP_S` de 90 s depois do início do k6, às 05:04:08Z, com
60 s de degrau e 46 s de espaço) e dura 60 s. Valores são médias na janela, com o máximo depois da barra.

| RPM alvo | CPU Dell % (méd/máx) | iowait % | `nvme0n1` util % | w/s | flush/s | f_await (ms) | w_await (ms) | PSI cpu some % | PSI io some / full % | `active` no Postgres (méd/máx) | CPU do host (méd/máx) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 20k | 19,1 / 39,0 | 5,7 | 49,6 | 1.505 | 748 | 0,52 | 0,36 | 1,1 | 6,7 / 6,1 | 19 / 132 | 105 / 113 |
| 26k | 23,7 / 36,2 | 7,1 | 63,9 | 1.887 | 935 | 0,52 | 0,38 | 0,9 | 8,1 / 7,3 | 23 / 100 | 106 / 113 |
| 32k | 42,7 / 65,0 | 5,7 | 64,8 | 1.904 | 943 | 0,51 | 0,38 | 6,2 | 8,1 / 5,8 | 176 / 243 | 108 / 113 |
| 38k | 40,8 / 59,6 | 5,8 | 64,0 | 1.783 | 883 | 0,71 | 0,56 | 7,5 | 9,4 / 7,1 | 184 / 240 | 111 / 113 |
| 44k | 30,5 / 59,3 | 6,5 | 66,6 | 1.924 | 946 | 0,53 | 0,38 | 3,1 | 8,7 / 6,9 | 61 / 203 | 110 / 113 |
| 50k | 23,7 / 29,6 | 6,7 | 62,5 | 1.842 | 910 | 0,53 | 0,37 | 1,6 | 8,2 / 7,1 | 38 / 99 | 112 / 113 |
| 56k | 27,7 / 38,2 | 7,1 | 66,6 | 1.946 | 959 | 0,53 | 0,37 | 2,3 | 8,7 / 7,4 | 49 / 105 | 110 / 113 |
| 62k | 30,4 / 45,3 | 7,2 | 69,4 | 2.030 | 985 | 0,54 | 0,45 | 2,9 | 9,3 / 7,7 | 41 / 105 | 110 / 113 |
| 68k | 29,1 / 36,9 | 7,6 | 72,5 | 2.117 | 1.019 | 0,55 | 0,47 | 2,3 | 9,6 / 8,1 | 49 / 119 | 111 / 113 |
| 74k | 29,9 / 40,0 | 7,7 | 74,2 | 2.189 | 1.052 | 0,53 | 0,40 | 2,5 | 9,7 / 8,0 | 41 / 115 | 111 / 113 |
| 80k | 31,1 / 40,5 | 7,6 | 74,3 | 2.233 | 1.051 | 0,52 | 0,38 | 2,6 | 9,7 / 8,0 | 43 / 106 | 111 / 113 |
| 86k | 38,0 / 51,0 | 7,0 | 72,9 | 2.199 | 1.025 | 0,55 | 0,38 | 4,9 | 9,4 / 7,3 | 62 / 135 | 110 / 113 |
| 92k | 38,0 / 49,5 | 7,0 | 72,8 | 2.180 | 1.028 | 0,54 | 0,82 | 5,1 | 9,7 / 7,5 | 64 / 122 | 110 / 113 |
| 98k | 32,8 / 39,0 | 7,3 | 72,5 | 2.192 | 1.014 | 0,54 | 0,85 | 3,4 | 9,6 / 7,7 | 69 / 132 | 110 / 113 |

O PSI vem da diferença do contador `total` na janela, e não do `avg10`. O `active` é a contagem `state = active` do `pg_activity.csv`. O iowait
é o `%iowait` do `mpstat` (igual no `sar`, no `vmstat` e no `avg-cpu` do `iostat`). A CPU do host
é o contador da `telemetria-host` (utilidade do processador, que passa de 100 com turbo; o máximo observado é ~113–114). Com a stack ociosa, nos
~10 s antes do k6, a CPU do Dell ficou em ~3–7% (média ~5%; fora a 1ª amostra, do arranque do coletor).

Gargalo (leitura com hipóteses; nada aqui foi isolado por experimento):
- **O Dell não saturou em nenhum degrau.**
  - A CPU média ficou entre 19% e 43%, com pico de 65%, e o PSI de CPU ficou abaixo de 8%.
  - O disco fez ~750–1.050 flushes/s com ~0,52 ms cada (`f_await`; 0,71 ms em 38k). O PSI de io ficou em ~7–10% (`some`) e o `%util` em
    50–74%. Num NVMe, `%util` não indica saturação, porque há várias filas.
  - Hipótese: do lado do Dell, o custo é a latência de cada commit (flush do WAL mais o RTT), não falta de capacidade.
- **O host ficou no teto de CPU desde o 1º degrau:** 105–112 de média contra o máximo de ~113. Na R5 o host ficou em 95 a 20k e 26k e só
  encostou no teto a partir de 32k–38k (103–111).
  - Não é volume de 202: a 20k e 26k os 202 são quase iguais (1.571 contra 1.654), e a CPU já foi 105–106 contra 95.
  - A hipótese é a rede do Docker Desktop no Windows: o tráfego container → LAN passa pela pilha de rede dele, e ela come CPU do host. Isso
    não está medido separadamente.
- **Em 32k–38k aparece a fila de lock na linha quente do `eventcap`.** O `active` no Postgres sobe para 176–184 de média (243 de máximo) e a
  coleta do host vê 125–127 conexões esperando lock em média.
  - No Dell, a CPU sobe de 23,7% (26k) para 42,7% (32k), puxada por `%usr` e `%sys` (`%sys` de 2,7 para 8,1). O disco é que fica estável:
    iowait de 7,1 para 5,7–5,8%, w/s e flush/s quase iguais, `f_await` 0,51 ms em 32k e 0,71 ms em 38k.
  - Hipótese: cada commit dura mais (flush ~0,5 ms mais RTT ~0,45 ms), o lock da linha fica mais tempo preso, e a fila de lock se forma um
    degrau antes da R5, o que seria compatível com o 1º degrau degradado em 32k.
  - Explicação concorrente: o host já estava no teto de CPU a 20k e 26k (105–106 contra 95 na R5), o que também atrasaria o caminho síncrono
    e a liberação do lock.
- **Resumo (hipótese):** na faixa até 44k, o candidato principal é o lock da linha quente, esticado pela latência de commit do banco remoto,
  com a CPU do host no teto como explicação concorrente. Acima dela, com a fila do `admission` ligada, o candidato é a CPU do host. O Dell
  não saturou em nenhum dos dois casos. Uma escada só não separa rede, disco e CPU do host.
- **`pg_test_fsync` do Dell:** não veio no pacote da coleta. O ~0,79 ms por operação foi informado pela sessão do Dell citada na #227 e não
  está em nenhum arquivo versionado. A evidência versionada do disco é o `f_await` sob carga (~0,52 ms, `dell/iostat-nvme0n1.txt`).

## Aceite (#227)

- Override versionado (profile do `db`, pooler/meta em `${DB_REMOTO_HOST}:5433` sem default, volume novo do `redpanda`, cliente `psql`);
  `config --quiet` passa e, sem `DB_REMOTO_HOST`, recusa com mensagem clara. O compose base não muda: **cumprido**.
- Senha só por env ou arquivo montado dentro do container, nunca em linha de comando nem em log: **cumprido**.
- GUCs do Dell iguais às do `db` da R5 (`max_connections` 300 etc.): **cumprido**; o disco e a CPU diferem e estão registrados acima.
- Smoke pelo pooler antes da escada: **cumprido**.
- Escada com os parâmetros do `Deg-59713`, só `SUFIXO`/`RUN_ID` novos, rodada no gerador: **cumprido**.
- `verificar-rpm` sem código 3 nem 4 e overselling 0 no CAS: **cumprido** (RC 0).
- Coleta do host (36 colunas e telemetria), RTT e coleta do Dell (CPU, disco, conexões, PSI, com horário UTC): **cumprido**. O `pg_test_fsync` do Dell não veio no pacote; o valor (~0,79 ms) foi informado pela sessão do Dell, citado na #227, e não está versionado.
- Resultados em `09-…`, com README, tabela R5 × R5-db-remoto e linha no `results/README.md`: **cumprido**. Nada em `docs/artigo/`.

## Anomalias e desvios

- **20k a frio** acima de 1 s no p95 de janela (2.139 ms), como em todas as rodadas anteriores. O `report-degraus` marca o X nele.
- O Docker Desktop do host não subia antes do preparo: o `engine.sock` do secrets engine ficou travado, e o usuário o apagou como admin.
  A stack subiu do zero sobre os volumes existentes, com o volume novo do Redpanda.
- O Dell foi recriado (`max_connections` de 100 para 300) com a stack do host já no ar, antes do smoke. O pooler reconectou sozinho, e o
  `limpar-banco.sh` reiniciou os serviços depois.
- A coleta do host leu o `pg_stat_statements` do banco do Dell pelo cliente, como o kit faz com o `CONTAINER_DB`
  (`host-telemetria/pgss-r5db-*.csv`).
- A coleta pelo cliente levou ~1,5 s por amostra com a stack ociosa e até 7,3 s sob carga; na R5 foram ~2 s e 7,1 s. O `INTERVALO_S` real é
  esse.
- O cabeçalho do `verificacoes-r5db.log` mostra `printenv` ausente nas imagens slim. É cosmético, como na R4 e na R5.
- A matriz não rodou, como na R4 e na R5. Sem telemetria do gerador, e a latência dos passos da saga ficou fora (logger desligado).

## Arquivos

- `degraus-283330.csv` e `degraus-283330.html`: uma linha por degrau e o relatório.
- `plano-degraus-283330.json`: o plano e a linha do k6.
- `gerador/summary-degraus-283330.json`: o resumo do k6 (veio do ref temporário `R5DB-gerador-01`, `56e337e`, já removido; mesmo blob).
- `host-telemetria/`:
  - `telemetria-host-r5db-*.csv`, `coleta-host-r5db-*.csv` (36 colunas), `eventos-r5db-*.csv`, `pgss-r5db-*.csv` e `registro-r5db-*.txt`;
  - `saga-r5db-*.csv` e `resumo-saga-r5db-*.txt`;
  - `verificacoes-r5db.log`.
- `banco/`: `rtt.txt` (com os brutos `rtt-psql-*.txt`), `gucs-dell.txt` e `gucs-comparacao.txt`.
- `dell/`: coleta do Dell (ver "Dell"): `mpstat.txt`, `vmstat.txt`, `iostat-nvme0n1.txt`, `psi.txt`, `pg_activity.csv`, `sar-filtrado.csv`, `inicio.txt` e `fim.txt`.
