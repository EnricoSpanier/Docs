# Etapa 07: Rodada 4, admission acima do X, com e sem autoescala (issue #179)

## O que estava implementado

- `Batch_2` em `35955ef` (host e gerador no mesmo commit): a configuração distribuída da etapa 06 mais o `admission` (#41 contador de RPM no Redis, #42 fila no RabbitMQ
  com worker pool, #43 gatilho 80/70 com histerese, 202 e consulta de estado), a autoescala (#111/#112, opção A: override do compose +
  HAProxy + scaler no host), as imagens slim (#177) e o kit da R4 (#178). Sem a saga (#47), que fica para a Rodada 5.

## Configuração

- Host: Ryzen 7 7700X, 2,5 GbE onboard (192.168.68.64), Docker com os dados em SSD NVMe: `pg_test_fsync` fdatasync **0,367 ms** (03:00) e
  **0,389 ms** (08:1x, antes do bloco 1), &lt; 1 ms (`host-telemetria/pg_test_fsync-r4*.txt`).
- Gerador: EnzoAMD (192.168.68.54), k6 2.2.0, kit em `35955ef` (o mesmo do host), RAM livre 9,3 GB antes da rodada e 10,2 / 10,1 / 10,1 GB ao
  fim dos blocos 1 / 2 / 3; `netsh dynamicport` em 10000/55535 (o usuário reverte).
- Stack com `docker-compose.carga.yml` + `rpm/docker-compose.rpm.yml` + `docker-compose.slim.yml` (+ `docker-compose.autoescala.yml` no
  braço C): `max_connections` 300, pool do Supavisor 245, READPATH `cas`, `ADMISSION_X_RPM` 56000 (fila liga a 0,8 X × réplicas, volta a
  0,7), janela do contador 200 ms (buckets de 50 ms), TTL da fila 30 s, 5 mensagens em espera por usuário.
  - Sem autoescala: Hikari do `reservation` 1000, worker pool do `admission` 32.
  - Braço C: Hikari 300 por réplica do `reservation`, worker pool 10 por réplica do `admission`, `lb` (HAProxy 3.2.25) na 8081; tópicos
    `identity.notification` e `reservation.wallet` com 3 partições (irreversível, por isso o braço C veio depois).
- Imagens slim (`gerenciador-eventos-<serviço>.slim`) geradas do código de `35955ef`; as de `backend`, `catalog` e `reservation` foram
  regeradas antes do bloco 1 (a S5 as tinha sobrescrito com o código da saga), conferido pelo `application.properties` do jar.
- Banco limpo antes de cada bloco (`limpar-banco.sh`: `TRUNCATE` de `public`/`reservation`/`catalog`/`identity`, `FLUSHDB`, purge das
  filas, chave do JWT apagada, serviços religados). Seed pelo host (`preparar-degraus.ps1`), o gerador só roda `git checkout` + `k6 run`.

## Escada (igual nos dois braços)

Sequencial, 20k → 98k RPM, passo 6k, 14 degraus de 60 s (espaço de 46 s, porque há acompanhamento), `USUARIOS=1000` (capacidade 500 por
evento, 868 eventos), `PCT_CONFIRMA=100`, `MAX_VUS=3000`, `PCT_ACOMPANHA=5` (5% das 202 consultam o estado a cada 1000 ms até 35 s),
`PARADA_P95_MS=5000` por janela de 60 s, `SETUP_S=90`, sem `Idempotency-Key` própria.

## Comandos

Host (Git Bash, pasta principal em `35955ef`); `F` = `-f docker-compose.yml -f carga/docker-compose.carga.yml -f carga/rpm/docker-compose.rpm.yml -f docker-compose.slim.yml`
(mais `-f docker-compose.autoescala.yml` no braço C):

```bash
cd Projeto && export RESERVATION_READPATH=cas PG_MAX_CONNECTIONS=300 PG_POOLER_POOL_SIZE=245
docker compose $F up -d --wait
# braço C: scaler no host, mesmos -f e ambiente (bloco 3: AUTOESCALA_GATEWAY_RPS=1600 AUTOESCALA_ADMISSION_RPS=1600 AUTOESCALA_IDENTITY_RPS=200 AUTOESCALA_DESCE_SEG=120)
AUTOESCALA_COMPOSE_ARQUIVOS='docker-compose.yml carga/docker-compose.carga.yml carga/rpm/docker-compose.rpm.yml docker-compose.slim.yml docker-compose.autoescala.yml' Projeto/autoescala/scaler.sh
# por bloco (scaler parado na limpeza)
cd carga && bash ./limpar-banco.sh
powershell.exe -NoProfile -File degraus/preparar-degraus.ps1 -HostIp 192.168.68.64 -MaxConnections 300 -PoolHikari 1000   -RpmInicio 20000 -RpmPasso 6000 -RpmMax 98000 -Duracao 60 -Usuarios 1000 -MaxVus 3000 -Mapeamento sequencial   -PctAcompanha 5 -ParadaP95Ms 5000 -ParadaJanelaS 60 -SetupS 90 -Arranjo 'sem-autoescala+slim'   # braço C: -PoolHikari 300 -Arranjo 'autoescala+slim' -ParamsAutoescala '...'
bash ./coleta-host.sh r4-b<n> 3000 &   ;   powershell.exe -NoProfile -File telemetria-host.ps1 -Rotulo r4-b<n> -DuracaoS 3000 &
# depois do k6: resumo trazido do ref R4-gerador-NN (git show origin/R4-gerador-NN:Projeto/carga/results/summary-degraus-<id>.json)
powershell.exe -NoProfile -File degraus/csv-do-resumo.ps1 -Plano results/plano-degraus-<id>.json -Resumo results/summary-degraus-<id>.json
bash ../../docs/carga/harness/report-degraus.sh results/degraus-<id>.csv results/degraus-<id>.html
powershell.exe -NoProfile -File rpm/subir-host-rpm.ps1 -Verificar -Prefixo Deg-<id>      # código 3 = overselling no CAS
```

Gerador (Windows PowerShell, raiz do clone): `git checkout 35955efb1116ff1247d94fcc56cf22d017d662b7` e a linha `k6 run` impressa pelo
`preparar-degraus.ps1` (guardada em `linha_k6` de cada `plano-degraus-<id>.json`); depois `git add -f` do resumo, commit e
`git push origin HEAD:refs/heads/R4-gerador-NN` (um ref por bloco; o resumo foi lido no host por `git show`).

## Blocos

| Bloco | Escada | Braço | Resultado |
|---|---|---|---|
| — | `Deg-28100` | sem autoescala + slim | **abortado, não usar**: o k6 foi morto no gerador por pressão de memória do sistema no 1º degrau (fora do repo) |
| 1 | `degraus-46496` | sem autoescala + slim | 14 degraus completos, 0 5xx, 0 descartes, overselling **0** |
| 2 | `degraus-49019` | autoescala + slim, parâmetros provisórios | **parada** no 3º degrau (32k, p95 de janela 5,58 s); 4.175 5xx (3.148 reserva, 1.027 confirma), 1.162 descartes; overselling **0** |
| 3 | `degraus-50350` | autoescala + slim, calibrada | **parada** no 4º degrau (38k, p95 de janela 6,00 s); 9.537 5xx (7.557 reserva, 1.980 confirma), 4.609 descartes; overselling **0** |

### Bloco 1 (`degraus-46496`, sem autoescala)

| RPM alvo | p50 | p95 | p99 | p95 pior janela 30 s | 202 | 429 | admitir p50 / p95 (ms) | ponta a ponta p95 (ms) |
|---|---|---|---|---|---|---|---|---|
| 20k | 7,0 | 1.005,8 | 1.736,9 | 1.340,5 | 905 | 0 | 2.022 / 3.033 | 1.522 |
| 26k | 7,0 | 394,5 | 757,4 | 419,2 | 0 | 0 | — | 396 |
| 32k | 217,3 | 1.430,3 | 1.950,7 | 1.457,2 | 15.001 | 0 | 1.005 / 2.179 | 1.839 |
| 38k | 458,0 | 1.717,7 | 2.190,6 | 1.760,7 | 18.498 | 0 | 2.649 / 2.941 | 2.952 |
| 44k | 380,2 | 1.658,7 | 2.123,8 | 1.728,7 | 22.434 | 4.130 | 9.457 / 15.923 | 8.623 |
| 50k | 4,6 | 282,7 | 561,1 | 301,5 | 26.677 | 17.571 | 12.046 / 15.054 | 13.066 |
| 56k | 4,7 | 377,9 | 654,7 | 385,0 | 23.828 | 24.901 | 14.041 / 18.085 | 14.060 |
| 62k | 4,1 | 342,2 | 596,3 | 362,9 | 24.092 | 29.870 | 14.046 / 16.062 | 14.059 |
| 68k | 3,6 | 332,0 | 557,7 | 367,6 | 25.246 | 33.866 | 13.042 / 15.047 | 13.058 |
| 74k | 3,6 | 334,9 | 582,7 | 348,2 | 24.375 | 39.930 | 13.049 / 16.055 | 13.053 |
| 80k | 4,6 | 372,1 | 669,9 | 372,2 | 21.485 | 48.663 | 16.084 / 19.099 | 15.074 |
| 86k | 3,9 | 386,9 | 637,1 | 407,3 | 21.950 | 52.829 | 15.043 / 18.068 | 14.046 |
| 92k | 3,6 | 487,9 | 886,7 | 557,4 | 19.101 | 60.891 | 17.054 / 26.071 | 12.075 |
| 98k | 5,2 | 748,4 | 1.253,6 | 771,3 | 15.008 | 70.270 | 22.109 / 29.157 | 8.085 |

Latências em ms, de todas as respostas do POST (201, 202, 409 e 429). Efetivo = alvo em todos os degraus, 0 5xx, 0 `outros`, 0 descartes,
0 `timed_out` e 0 `sem_estado` entre as acompanhadas (12.838 acompanhadas: 8.820 admitidas, 4.018 `rejected`). Total: 258.600 respostas
202 e 382.921 429. Banco do host depois da fila drenar: 151.319 `confirmed`, 167.425 `expired` (as 202 não acompanhadas viram `pending` e
expiram), 0 evento acima da capacidade. Fila `admission.requests`: máx. 4.419 mensagens (bem abaixo do teto de 100.000), 0 ao fim;
dead-letter (`admission.timed_out`) 0 em todas as amostras e `timed_out` 0 no k6.

### Bloco 2 (`degraus-49019`, braço C com os parâmetros provisórios)

| RPM alvo | efetivo | p50 | p95 | p99 | p95 pior janela 30 s | 5xx reserva / confirma | descartes | 202 | 429 |
|---|---|---|---|---|---|---|---|---|---|
| 20k | 20.001 | 1.014,6 | 3.397,8 | 4.511,0 | 3.906,4 | 0 / 0 | 0 | 5.061 | 167 |
| 26k | 26.001 | 683,9 | 2.607,7 | 3.405,5 | 2.655,7 | 0 / 0 | 0 | 11.238 | 0 |
| 32k (parcial) | ver CSV | 1.302,5 | 5.580,7 | 6.650,9 | 6.142,8 | 3.148 / 1.027 | 1.162 | 6.407 | 1.099 |

Parada `p95_acima_de_5000ms_em_janela_de_60s_no_degrau_32000` (k6 código 99, esperado com a parada ligada); o k6 chegou às 3000 VUs no
degrau de 32k. Banco depois da fila drenar: 27.638 `confirmed`, 7.257 `expired`, 2.259 `pending`, que expiraram nos 2 min seguintes
(9.516 `expired`, 0 `pending`): nenhuma reserva órfã; overselling 0.

Réplicas × tempo (`autoescala/replicas-20261029-084951.csv`, horário UTC; o seed + logins começam ~11:58):
- `identity`: stand-by sobe nos logins do setup (11:53 e 11:58, uso 0,78–0,82 com 100 req/s por réplica) e é descartada;
- `reservation`: stand-by em 12:00:01 (uso 0,75 com 20k oferecidos), promovida em 12:02:40 (uso 1,22), **desce em 12:04:10 no meio do
  degrau de 32k** (uso 0,218);
- `backend`: stand-by em 12:00:18 (uso 0,78 = 391 req/s com 500 por réplica), promovida em 12:00:48; 3ª réplica em 12:02:02, promovida em
  12:02:42; desce para 2 e 1 em 12:05:40 e 12:06:56;
- `admission`: stand-by em 12:00:53, descartada em 12:05:46; `catalog` e `notification` ficam em 1.

### Bloco 3 (`degraus-50350`, braço C calibrado)

Só configuração do scaler, a partir do bloco 1: `AUTOESCALA_GATEWAY_RPS=1600` e `AUTOESCALA_ADMISSION_RPS=1600` (uma réplica aguentou ~1.633
reservas/s), `AUTOESCALA_IDENTITY_RPS=200` (sem stand-by nos logins do setup) e `AUTOESCALA_DESCE_SEG=120` (maior que o espaço de 46 s mais
um degrau); o resto no padrão (coluna `params_autoescala` do CSV).

| RPM alvo | p50 | p95 | p99 | p95 pior janela 30 s | 5xx reserva / confirma | descartes | 202 | 429 |
|---|---|---|---|---|---|---|---|---|
| 20k | 7,7 | 1.257,1 | 2.052,0 | 1.613,0 | 0 / 0 | 0 | 1.891 | 0 |
| 26k | 251,9 | 1.498,0 | 2.071,3 | 1.602,8 | 0 / 0 | 0 | 6.021 | 0 |
| 32k | 554,7 | 2.731,9 | 3.884,3 | 3.242,0 | 0 / 0 | 0 | 15.089 | 1.121 |
| 38k (parcial) | 2.119,8 | 6.001,4 | 6.928,9 | 6.050,8 | 7.557 / 1.980 | 4.609 | 1.982 | 0 |

Parada `p95_acima_de_5000ms_em_janela_de_60s_no_degrau_38000` (k6 código 99), 3000 VUs no degrau de 38k. Banco depois da fila drenar: 40.424
`confirmed`, 8.969 `expired`, 2.973 `pending`, que expiraram em seguida (11.942 `expired`, 0 `pending`): nenhuma órfã; overselling 0.
Réplicas (`autoescala/replicas-20261029-091215.csv`, UTC): nada sobe até o 32k; `reservation` com stand-by em 12:25:22, promovida em
12:26:54; `backend` com stand-by em 12:25:44, promovida em 12:27:16. Os dois ficam em 2 até descer (`reservation` às 12:29:55, `backend` às 12:30:04; o scaler parou às 12:31:09), e entre 12:27:16 e 12:27:58 o
`backend` oscila de 0 a 2 ativas pelas quedas do `lb`; `identity`, `catalog`,
`admission` e `notification` ficam em 1.

## Comparação com a Rodada R (etapa 06)

Mesma escada sequencial e mesma regra do X (p95 de janela de 30 s acima de 1 s, fora do aquecimento). A R não tinha `admission` nem `lb`
(1 réplica de cada); usou 200 usuários e imagens originais; a R4, 1000 usuários e slim.

| | R (06, `b072346`) | R4 bloco 1 (sem autoescala) | R4 bloco 2 (C provisório) | R4 bloco 3 (C calibrado) |
|---|---|---|---|---|
| 1º degrau degradado fora do aquecimento | **56k** (54k limpo) | **32k** (26k limpo) | 20k (já no 1º degrau) | 26k |
| Depois do joelho | colapso a ~42k efetivos (58k e 60k), descartes 15,6–18,0k | estável até 98k: efetivo = alvo, p95 de janela 0,30–0,77 s de 50k a 98k | parada em 32k | parada em 38k |
| p50 / p95 / p99 a 20k (ms) | 4,1 / 5,8 / 8,5 | 7,0 / 1.005,8 / 1.736,9 (a frio) | 1.014,6 / 3.397,8 / 4.511,0 | 7,7 / 1.257,1 / 2.052,0 |
| p50 / p95 / p99 a 32k (ms) | 5,2 / 36,6 / 76,2 | 217,3 / 1.430,3 / 1.950,7 | 1.302,5 / 5.580,7 / 6.650,9 | 554,7 / 2.731,9 / 3.884,3 |
| p50 / p95 / p99 a 56k (ms) | 215,3 / 1.141,3 / 1.984,1 | 4,7 / 377,9 / 654,7 | — | — |
| Taxa de 5xx | 0 em todos os degraus | 0 em todos os degraus | 10,2% no 32k (0 antes) | 24,1% no 38k (0 antes) |
| Tempo até admitir p50 / p95 | — (sem fila) | 1,0–2,6 / 2,2–3,0 s até 38k; 9,5–22,1 / 15,0–29,2 s de 44k a 98k | 11,5–11,6 / 16,1–18,9 s | 1,0–17,2 / 1,0–20,2 s |
| Réplicas × tempo | 1 de cada | 1 de cada | reservation 1→2→1 (desce no meio do 32k), backend 1→3, admission e identity com stand-by | reservation e backend 1→2 a partir do 32k |
| Overselling no CAS | 0 | 0 | 0 | 0 |

Leitura:
- **Abaixo do X, a R4 é mais lenta que a R** (32k: p95 de 1,43 s contra 37 ms). O contador de 200 ms vê rajadas acima do oferecido e
  liga a fila já em 20k–44k. Fila e caminho síncrono passam a disputar a mesma linha do `eventcap`, e cada reserva ganha o salto ao
  `admission`.
- **Acima do X, o modo de alta carga cumpre o papel sem autoescala.** De 50k a 98k o sistema fica estável:
  - sem 5xx, sem descartes e com o efetivo igual ao alvo;
  - a fila drena (0 ao fim, dead-letter 0);
  - a R colapsava logo depois do X.
  - O preço é a espera até admitir (15–29 s no p95) e o 429 por usuário.
- **Com autoescala, neste host, o sistema não fica estável acima do X**: o `lb` derruba o gateway saturado (ver "Anomalias"). Mais
  réplicas também não ganham capacidade aqui: CPU compartilhada, linha quente do `eventcap`, e X(1) = X(2) no dry-run da #178.

## Aceite (#179)

- CAS com overselling 0 em todos os blocos, conferido no banco do host (`-Verificar`, RC 0): **cumprido**.
- Estável acima do X **sem autoescala** (bloco 1, até 98k, 0 5xx, fila drenando, dead-letter registrada): **cumprido**.
- Estável acima do X **com autoescala** (braço C): **não cumprido**. Os blocos 2 e 3 param abaixo do X, com 503 do `lb` (`econ`): o health
  check no pool do Tomcat tira o gateway saturado do ar. Follow-up **#207** (depois da R5, fora do Batch 2) e limitação do sinal **#206**.
- Matriz: fora (desvio abaixo).

## Anomalias

- **Bloco 1, 202 já em 20k e degradação entre 32k e 44k.** O 20k é o degrau a frio (p95 de janela 1,34 s; o `report-degraus` marca o X
  nele, como na etapa 06). De 32k a 44k o p95 de janela fica em 1,46–1,76 s com 47–51% das respostas em 202: o contador (janela de 200 ms)
  vê rajadas acima do RPM oferecido (`redis_hot` chega a 145k com no máximo 98k oferecidos) e liga a fila abaixo de 0,8 X; com a fila ligada,
  os 32 workers e o caminho síncrono disputam a mesma linha do `eventcap` (até 243 sessões esperando lock, pool real de 245 cheio). Acima
  de 50k a fila e o limite por usuário absorvem o excesso: a latência de todas as respostas cai (p95 0,28–0,75 s), mas a espera até admitir
  vai a 15–29 s e o 429 chega a 72% das respostas em 98k.
- **429 = limite de 5 mensagens em espera por usuário**, não fila cheia (máx. 4.419 de 100.000). Com 1000 usuários e espera de ~15 s, cada
  usuário passa de 5 acima de ~44k. É o comportamento do desenho; mais usuários reduziriam o 429.
- **Bloco 2 (braço C) já lento em 20k e parado em 32k.** Evidência (`host-telemetria/*r4-b2*`, `autoescala/`, estatísticas do `lb`):
  1. **Sinal do reservation instável.** O scaler usa `adm:hot` (RPM da janela de 200 ms do evento mais quente). Amostrado a cada ~6–10 s,
     ele oscila de 0 a 1,5 (no 20k do braço C a coleta leu de 7k a 47k, 4 de 11 amostras entre 38k e 47k, contra 15–21k no bloco 1). Subiu o reservation com 20k oferecidos e o
     **desceu no meio do degrau de 32k**: os 60 s de `AUTOESCALA_DESCE_SEG` cobriram o espaço de 46 s sem carga entre os degraus mais um
     degrau engasgado (uso 0–0,2).
  2. **Capacidades provisórias baixas para o que o bloco 1 mediu.** Com `AUTOESCALA_GATEWAY_RPS=500` o scaler subiu 2 gateways extras
     (12:00 e 12:02), mais a stand-by do `admission` e duas do `identity` (`AUTOESCALA_IDENTITY_RPS=100` contra os logins do setup). No
     bloco 1, uma réplica de cada aguentou 98k RPM (~1.633 reservas/s) sem 5xx. São 6 JVMs subindo no mesmo host, 4 delas durante a escada (as 2 stand-bys do `identity` subiram no setup). A CPU do host
     (média por janela de 30 s, mesmo contador nos dois blocos) já estava perto do teto nos dois braços: 20k / 26k / 32k = 113 / 112 / 110 no
     braço C contra 95 / 90 / 107 no bloco 1, e 56–66 contra 38–50 no setup. As subidas pesam, mas a CPU sozinha não separa os dois braços.
  3. **Os 5xx são do `lb`, não dos serviços.** No `show stat` do HAProxy, o backend `gateway` tem `hrsp_5xx` = `econ` = 4.175 (= 3.148 + 1.027
     do k6) e os servidores `gw1..gw3` têm 0 5xx próprios. O mecanismo é o health check do `lb`, no item abaixo.
  4. **O pool não explica a diferença:** o pool real é o do Supavisor (245) nos dois braços e ficou cheio nos dois (`pg_ativas` 245–246); o
     Hikari 300 por réplica contra 1000 está atrás do mesmo 245.
- **Causa dos 5xx dos blocos 2 e 3: o health check do `lb` derruba o gateway saturado** (`autoescala/lb-estado-r4-b2-b3.log`). O
  `GET /actuator/health` do HAProxy (`inter 2s`, `fall 3`) divide as 300 threads do Tomcat com o tráfego. Com o gateway saturado, o check
  estoura os 2 s (`Layer7 timeout`) e o `lb` tira a réplica com milhares de sessões ativas: "backend gateway has no server available".
  - Bloco 2: gw1, gw2 e gw3 caem às 12:03:42–43.
  - Bloco 3: gw1 cai às 12:27:05 com 2.992 sessões, e gw1/gw2 alternam DOWN/UP até 12:27:52.
  - Nesses intervalos toda requisição nova recebe 503 do próprio `lb`: no `show stat`, o backend `gateway` tem `econ` = `hrsp_5xx` (4.175 no
    bloco 2; 13.845 acumulado depois do bloco 3, ~9.670 dele, contra 9.537 do k6). Os servidores não têm 5xx próprios.
  - O scaler lê a mesma queda: em 12:27:16 e 12:27:39 o `backend` aparece com 0 ativas, uso 999,999; ele promove a stand-by em 12:27:16 (em 12:27:39 já não há stand-by).
  - O bloco 1 não tem `lb`: o gateway saturado só fica lento (p95 de 1,5–1,8 s em 38k e 44k) e não é ejetado.
  - O braço C também é mais lento antes disso, com 4 saltos a mais pelo `lb` por reserva (gateway → admission e gateway → reservation): em
    32k o p95 foi de 2,73 s, contra 1,43 s no bloco 1.
- **Follow-up #207 (health check do gateway no `lb`)**, depois da R5 e fora do Batch 2. Caminhos possíveis: um `timeout check`/`fall` mais
  tolerante, o health check fora do pool do Tomcat, ou nunca tirar o último servidor ativo.
- **Limitação conhecida (follow-up #206): o `adm:hot` não é suavizado.** É o RPM da janela de 200 ms do evento mais quente, lido pelo scaler
  a cada laço; no sequencial ele oscila entre 0 e ~3,6× o oferecido (135k no degrau de 38k do bloco 1). O bloco 3 calibra só as capacidades e o `AUTOESCALA_DESCE_SEG`, sem
  mudar código, então essa oscilação continua no sinal do reservation.
- O `registro-r4-b<n>-*.txt` da coleta também não lê o ambiente dos containers `reservation` e `admission` (mesmo motivo). Os valores da
  seção "Configuração" foram lidos por `docker inspect` (só nomes públicos) antes de cada braço.
- O cabeçalho do `verificacoes.log` traz `printenv` ausente: as imagens slim do `reservation` não têm `printenv`. É cosmético; o readpath
  `cas` vem do backend, e a contagem de overselling é por `psql`.

## Desvios do protocolo

- **Matriz não rodou** (opção b da sessão de interface): o `rodar-matriz.ps1` semeia por Git Bash/curl, usa arquivo de credenciais e
  `Remove-Item` no gerador, fora do que o gerador da madrugada pode rodar. O CAS foi conferido no banco do host por `-Verificar` a cada bloco.
- **`USUARIOS` 1000** (a etapa 06 usou 200): com 200 usuários o limite de 5 em espera por usuário seria uma parede de 429 acima do X, e o
  seed pelo `lb` no braço C só passa ~1000 usuários. No sequencial a disputa instantânea é a mesma (todas as reservas do momento caem no
  mesmo evento); muda o tempo que cada evento fica quente.
- **Imagens slim** nos dois braços, contra as imagens originais da etapa 06: a comparação mistura o slim e o `admission`.
- **Sem telemetria do gerador** no modo direto: a saturação do gerador é lida só por `iteracoes_descartadas` e `rpm_efetivo`.
- `netsh dynamicport` do gerador fica para o usuário reverter.

## Arquivos

- `degraus-46496.csv`, `degraus-49019.csv`, `degraus-50350.csv`: uma linha por degrau (o parcial da parada inclusive), com as colunas da
  #178 (`reservas_202`, `recusadas_429`, `admitir_*`, `fim_a_fim_*`, `parada`, `arranjo`, `params_autoescala`); `plano-degraus-*.json`: plano
  e linha exata do k6.
- `gerador/summary-degraus-*.json`: resumos do k6 (vindos dos refs `R4-gerador-01..03`).
- `host-telemetria/`: por bloco, `telemetria-host-r4-b<n>-*.csv` (CPU, frequência, RAM), `coleta-host-r4-b<n>-*.csv` (lag, outbox,
  conexões, fila, Redis, réplicas), `eventos-r4-b<n>-*.csv` (por evento no Redis), `pgss-r4-b<n>-*.csv` (`pg_stat_statements`),
  `registro-r4-b<n>-*.txt` (variáveis públicas); `verificacoes-r4.log` (overselling por bloco); `pg_test_fsync-r4*.txt`.
- `autoescala/`: `replicas-*.csv` e `scaler-r4-b<n>.log` dos blocos 2 e 3; `lb-estado-r4-b2-b3.log` (ciclo de vida dos servidores no HAProxy).
- O bloco abortado (`Deg-28100`) não está aqui (fora do repo).
