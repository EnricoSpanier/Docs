# Etapa 10: a rodada da #227 no Kubernetes (K0, K1, K2), issue #228

A #227 (etapa 09) mediu o efeito de tirar o Postgres do host no compose. Esta etapa repete a mesma escada no cluster kind da branch `K8s`
(#197/#205) em três blocos, cada um num cluster novo:

| Bloco | Trilha | Autoescala | Banco | Pools |
|---|---|---|---|---|
| **K1** | `nenhuma` | travada em 1 | Dell (192.168.68.50:5433) | R5 (`K8S_POOLS=r5`) |
| **K2** | `b1` (Istio) | 1..3 | Dell | os do cluster (soma 1492), pool real 245 |
| **K0** | `nenhuma` | travada em 1 | dentro do cluster (PVC novo) | R5 |

O K0 é o controle: separa o efeito do db remoto do efeito do Kubernetes.

**Ordem:** o plano era K1, K2, K0. **O K0 rodou primeiro.** A limpeza do banco do Dell antes do K1, um `TRUNCATE ... RESTART IDENTITY` pelo
`limpar-banco.sh` em modo cluster, foi negada pelo classificador de permissões da sessão que roda a rodada até o usuário liberá-la. O K0
não depende dela: ele sobe com o banco dentro do cluster, num PVC novo e vazio, e não toca o Dell. Depois vieram o K1 e o K2.

Parâmetros por bloco e comandos: `Projeto/k8s/README.md`, "Rodada com o db remoto".

## K0 (`Deg-296361`), 2026-11-01

### Configuração

- **Cluster:** kind de um nó no host da R5 (Ryzen 7 7700X, 2,5 GbE, 192.168.68.64). Branch `Issue-228`, commits 9a7d1b7 e a826c8d.
  - `K8S_OVERLAY=rodada SLIM_TAG=k8s K8S_POOLS=r5 Projeto/k8s/cluster.sh up --trilha nenhuma`, sem `K8S_DB_REMOTO`.
  - Imagens `*.slim:k8s`, as mesmas da verificação pós-R5 da `K8s`.
- **Stack:**
  - db no cluster, com `max_connections` 300 e pool real do Supavisor 245;
  - Hikari: reservation 1000, stock 250, identity 100, catalog 100, backend 10, notification 3; 32 workers no `admission`;
  - 7 ScaledObjects com `maxReplicaCount` 1;
  - gateway pelo NodePort 30081, publicado na 8081 do host.
- **Seed:** 1000 usuários e 868 eventos com capacidade 500 (`preparar-degraus.ps1` no host; host com `user_id=1`).
  - O 1º preparo abortou depois do seed, por um redirecionamento `2>&1` do operador no PowerShell.
  - O cluster foi recriado para o seed começar num banco vazio, sem TRUNCATE.
- **Gerador:** EnzoAMD, k6 2.2.0, clone em 850d38e. O k6 é idêntico ao do commit do plano (`git diff` vazio em `carga-degraus.js`,
  `lib-admissao.js`, `lib-mapeamento.js` e `docs/carga/harness`). RAM livre: 7,68 GB depois do disparo e 10,05 GB no fim (relato da sessão
  do gerador, sem fonte versionada).
- **Escada:** a mesma da #227. Sequencial de 20k a 98k RPM, passo de 6k, 14 degraus de 60 s.
  - `USUARIOS` 1000, `PCT_CONFIRMA` 100, `MAX_VUS` 3000;
  - `PCT_ACOMPANHA` 5, `CONSULTA_MS` 1000, `TETO_CONSULTA_S` 35;
  - `PARADA_P95_MS` 5000, `PARADA_JANELA_S` 60, `SETUP_S` 90.
- **k6:** de 08:37:03Z a 09:02:48Z, código de saída 0. Os 1000 logins do setup levaram 28,4 s, contra ~12 s no compose (log do gerador,
  sem fonte versionada).

### Resultado

| RPM alvo | p50 | p95 | p99 | p95 pior janela 30 s | 202 | 429 | admitir p95 (ms) | ponta a ponta p95 (ms) |
|---|---|---|---|---|---|---|---|---|
| 20k | 27,4 | 910,6 | 1.492,5 | 1.056,4 | 797 | 0 | 2.212 | 1.007 |
| 26k | 298,6 | 1.771,6 | 2.402,8 | 1.789,1 | 12.009 | 0 | 2.023 | 2.260 |
| 32k | 692,1 | 2.169,9 | 2.860,2 | 2.232,2 | 14.758 | 0 | 7.296 | 4.249 |
| 38k | 752,6 | 2.094,6 | 2.594,4 | 2.100,9 | 15.432 | 5.715 | 21.162 | 14.232 |
| 44k | 170,2 | 1.781,4 | 2.442,6 | 2.024,1 | 19.628 | 10.797 | 19.387 | 12.065 |
| 50k | 4,2 | 462,2 | 729,2 | 497,2 | 22.332 | 20.577 | 17.064 | 15.065 |
| 56k | 3,6 | 414,7 | 656,1 | 424,0 | 21.334 | 27.370 | 19.056 | 17.057 |
| 62k | 3,6 | 403,5 | 666,3 | 413,1 | 20.882 | 33.044 | 19.067 | 16.077 |
| 68k | 3,7 | 433,3 | 688,7 | 460,1 | 20.750 | 38.381 | 19.201 | 16.083 |
| 74k | 3,5 | 407,7 | 650,7 | 424,3 | 21.252 | 43.123 | 18.644 | 15.062 |
| 80k | 3,2 | 397,2 | 620,2 | 410,0 | 20.558 | 49.410 | 19.065 | 15.108 |
| 86k | 3,6 | 456,8 | 782,1 | 473,9 | 19.467 | 55.323 | 20.072 | 15.129 |
| 92k | 3,6 | 462,1 | 797,3 | 466,3 | 19.853 | 60.012 | 19.161 | 15.050 |
| 98k | 4,1 | 496,8 | 876,9 | 516,7 | 18.525 | 66.700 | 21.104 | 14.072 |

As latências estão em ms e cobrem todas as respostas do POST. A tabela sai de `degraus-296361.csv` e o HTML é `degraus-296361.html`.

- **5xx:** 0 em todos os degraus, nas reservas e nas confirmações. Efetivo = alvo, 0 descartes, sem parada.
- **1º degrau degradado (p95 ≥ 1 s), sem contar o 20k a frio:** **26k**. Na #227 (compose, db no Dell) foi 32k e na R5 (compose, db local), 38k.
  Aqui a regra usa o p95 do degrau inteiro; a etapa 09 usou o p95 da pior janela de 30 s, então a comparação com ela é aproximada.
- **Overselling:** 0 (`host-telemetria/verificacoes-k0.log`).
  - Na execução final (linhas 28 e 33–34): 868 eventos, capacidade 434.000, 144.942 ativas (todas confirmed) e 164.450 expired;
    `eventos_com_overselling` 0.
  - Na 1ª execução, enquanto o job de expiração ainda varria as pending (linhas 6 e 11–13): 156.245 ativas = 144.942 confirmed + 11.303
    pending, mais 153.147 expired, soma de 309.392 (a mesma soma da final).
- **Sagas** (`verificar-rpm`, rc 0): 0 velhas, 0 hold `held` com saga compensated, 0 devolução pendente, 0 órfã inversa, 0 `quant`
  divergente (`capacity − quant` do `stock.eventcap` contra as ativas).
  - No fim do bloco (`resumo-saga`): 0 compensações, `devolucao_pendente` 0, `orfa_inversa` 0, 0 sagas `reserving` e 0 `compensating`.
  - Lag de devolução da vaga (n 164.450): p50 111 ms, p95 338 ms, máximo 1.945 ms. Na R5 o p95 foi 448 ms.
- **CPU do host durante o k6** (`telemetria-host`): média 83,5%, incluindo o setup e as pausas; só nos degraus de carga, 85,3%. RAM livre
  mínima de 21,8 GB.

**Ruído:**
- **17 respostas "outros" no degrau de 26k** (CSV): o POST `/bff/event-wallets` recebeu EOF, numa rajada às 08:40:28Z (hora do log do
  gerador, sem fonte versionada). A conexão foi fechada do lado do servidor, no caminho NodePort (kube-proxy) → pod do gateway.
- Não houve 5xx. Sem restart de pod pelo `kubectl get pods` da sessão (sem fonte versionada).

**Leitura contra a #227** (compose, db no Dell):
- No K0 a fase lenta é mais longa: de 26k a 44k, com p50 entre 170 e 753 ms.
- Os 429 começam em 38k (5.715, contra 325).
- De 50k para cima o p50 cai a 3–4 ms, mas a admissão é mais lenta: p95 de admitir entre 17 e 21 s (contra 11–14 s) e ponta a ponta entre
  14 e 17 s (contra 10–12 s).
- **Isso ainda não isola nenhum fator:** o K0 tem o Kubernetes com o db local, e a #227 tem o compose com o db remoto. O efeito do db remoto
  no cluster sai da comparação K0 × K1. O efeito do Kubernetes com o db remoto sai de K1 × #227.

### Notas de método

- **Coleta em modo cluster** (`coleta-host.sh` com `CARGA_K8S`): 1390 amostras em 2400 s, `duracao_amostra_ms` com p50 1.275 e p95 3.756.
  O intervalo efetivo passa de 1 s. Na #227 o p95 foi 5.856, então não é mais cara que a do compose.
- **A finalização da coleta foi regenerada.** O `coleta-host.sh` foi editado (correções da #228) enquanto a coleta rodava. O bash lê o script
  aos poucos e, no fim, deu erro de sintaxe antes da finalização. O CSV ficou inteiro.
  - O `pgss`, o `saga-*.csv` e o `resumo-saga` foram gerados depois, com o mesmo `INICIO_ISO` (08:36:34Z) e sem resetar o
    `pg_stat_statements`.
  - **O `pgss` inclui as consultas das duas execuções do `verificar-rpm`**, que rodaram antes da finalização. São poucas chamadas perto da
    carga, mas aparecem no top 25.
- **`registro-*.txt`: o env dos containers saiu vazio.** O harness lia o env por `kubectl exec <pod> -- printenv`, e as imagens slim não
  têm `printenv` (nem `sh`). Pelo mesmo motivo, a coleta usou o `ORPHAN_MS` default de 30000, o mesmo valor do serviço.
  - A #228 passou a ler o env do spec do Deployment (volta 5).
  - Env do K0 reconstruído do render da mesma config (`K8S_OVERLAY=rodada K8S_POOLS=r5 cluster.sh renderizar --trilha nenhuma`, sem
    `K8S_DB_REMOTO`):

    | Serviço | Variável | Valor |
    |---|---|---|
    | reservation | `SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE` | 1000 (literal no spec) |
    | stock | idem | 250 (literal) |
    | identity / catalog | idem | 100 / 100 (literal) |
    | notification | idem | 3 (literal) |
    | admission | `ADMISSION_WORKER_CONCURRENCY` | 32 (literal) |
    | supabase-pooler | `POOLER_DEFAULT_POOL_SIZE` | 245 (literal) |
    | db | `max_connections` | 300 (args do StatefulSet) |
    | admission | `ADMISSION_X_RPM`, `_RESERVATION_REPLICAS`, `_QUEUE_ON`, `_SYNC_BELOW` | via `envFrom` do Secret `env-admission`; defaults do compose 56000 / 1 / 0,8 / 0,7 |
    | reservation | `SERVER_TOMCAT_THREADS_MAX`, `RESERVATION_SAGA_ORPHAN_MS`, `_REAPER_SCAN_MS` | via `envFrom` do Secret `env-reservation`; default do compose para o Tomcat: 300; os outros dois ficam no default do serviço |
    | backend | `RESERVATION_READPATH` | ausente: default `cas` do `application.properties` |

  - O que vem por `envFrom` sai do `docker compose config` resolvido, com as mesmas regras da R5, e não aparece no spec. Os literais
    batem com o que foi conferido no Deployment ao vivo durante a validação.
  - **Gatilho do `admission`** (`ADMISSION_X_RPM`, `ADMISSION_RESERVATION_REPLICAS`, `ADMISSION_QUEUE_ON`, `ADMISSION_SYNC_BELOW`):
    - No K0 e no K1, as quatro variáveis vêm do **Secret** `env-admission` (`envFrom.secretRef`; não há ConfigMap). Não há literal no
      spec, e o `admission` não registra esses valores no log.
    - O Secret não foi lido. Os valores saíram da mesma fonte de que o `cluster.sh` gera o Secret: o `docker compose -f
      docker-compose.yml config` resolvido, com o mesmo `Projeto/.env`. Um filtro que só deixa passar essas quatro chaves rodou antes do
      stdout.
    - Resultado: **56000 / 1 / 0,8 / 0,7**, igual à R5 e à #227. O `.env` não mudou entre o K0 e o K1, então os dois blocos usam os
      mesmos valores.
- **`verificar-rpm`:** a 1ª execução abortou depois das tabelas, por dois defeitos do harness em modo cluster, corrigidos na #228:
  - o stderr "Defaulted container" do kubectl virava erro no PS 5.1;
  - uma variável local colidia com o parâmetro `ValidateSet` `$ReadPath`.

  Saída das duas execuções: `host-telemetria/verificacoes-k0.log`.
- **`/actuator/health` na 8081 responde 401 no cluster.** `MANAGEMENT_SERVER_PORT=8090` leva o actuator para a porta de management, das
  probes da #197/#207, e na 8090 a resposta é 200. O preparo da escada passou a checar só o alcance. Imagem, SecurityConfig e `/bff/**` são
  os mesmos.

### Arquivos

- `degraus-296361.csv`, `degraus-296361.html`, `plano-degraus-296361.json`
- `gerador/summary-degraus-296361.json`: resumo do k6, do ref temporário `K8S-gerador-K0` (6459b84)
- `host-telemetria/`: `coleta-host-*`, `eventos-*`, `pgss-*`, `registro-*`, `resumo-saga-*`, `saga-*`, `telemetria-host-*` e
  `verificacoes-k0.log`

## K1 (`Deg-308164`), 2026-11-01

### Configuração

- **Cluster:** o mesmo host do K0, num cluster novo. Branch `Issue-228` em **67c0ef8**: o harness já lê o env pelo spec do Deployment
  (volta 5).
  - `K8S_OVERLAY=rodada SLIM_TAG=k8s K8S_POOLS=r5 K8S_DB_REMOTO=192.168.68.50:5433 Projeto/k8s/cluster.sh up --trilha nenhuma`, depois
    `cluster.sh db-teste` com rc 0 (TCP e `SELECT 1` pelo Supavisor).
  - A stack é a do K0 (mesmos Hikari, 32 workers, ScaledObjects em 1, NodePort 30081). Só o banco muda: o Postgres do Dell, com
    `max_connections` 300, pelo Service sem seletor do componente `db-remoto`.
- **Limpeza antes do bloco:** `CARGA_K8S=kind-gerenciador limpar-banco.sh`, com rc 0. Foi liberada pelo usuário direto na sessão.
  - Depois dela: `event`, `walletevent`, `eventcap` e o `event_store` do reservation zerados.
  - Em `identity.users` fica 1 linha: o usuário que a sonda do próprio `limpar-banco` cria para conferir o JWKS. Por isso o host do seed é
    o `user_id=2`.
  - Também: FLUSHDB do Redis, purge de `admission.requests` e `admission.timed_out`, e a chave do JWT apagada.
- **Seed e escada:** os mesmos do K0. 1000 usuários e 868 eventos com capacidade 500, mesma escada e mesmos parâmetros do k6.
- **Gerador:** clone em 850d38e, como no K0. O código k6 é idêntico ao de 67c0ef8 (`git diff` vazio em `carga-degraus.js` e
  `Projeto/carga/k6`). RAM livre: 9,92 GB antes e 10,19 GB no fim (relato da sessão do gerador, sem fonte versionada).
- **k6:** de 11:54:00Z a 12:19:41Z, com código de saída 0 e sem parada por p95. Os 1000 logins do setup levaram 28,2 s (log do gerador, sem
  fonte versionada).
- **Coleta no Dell:** sessão DB, `~/coleta-227.sh` com saída `coleta-k8s-K1`, de 11:53:54Z a 12:34:14Z, com o vigia ligado.

### Resultado

| RPM alvo | p50 | p95 | p99 | p95 pior janela 30 s | 202 | 429 | admitir p95 (ms) | ponta a ponta p95 (ms) |
|---|---|---|---|---|---|---|---|---|
| 20k | 25,1 | 1.795,6 | 2.356,0 | 2.059,6 | 431 | 0 | 1.251 | 3.021 |
| 26k | 24,7 | 293,9 | 569,9 | 298,6 | 0 | 0 | — | 303 |
| 32k | 122,7 | 1.073,6 | 1.517,1 | 1.118,0 | 3.472 | 0 | 1.021 | 941 |
| 38k | 325,9 | 1.504,5 | 2.050,9 | 1.525,2 | 18.120 | 0 | 2.559 | 2.334 |
| 44k | 64,6 | 1.275,6 | 1.914,1 | 1.310,9 | 25.857 | 3.916 | 11.793 | 8.857 |
| 50k | 6,5 | 321,8 | 526,4 | 340,0 | 30.406 | 12.747 | 10.051 | 10.049 |
| 56k | 5,7 | 296,2 | 507,7 | 307,7 | 30.627 | 18.069 | 11.046 | 10.066 |
| 62k | 4,8 | 308,5 | 496,8 | 323,7 | 29.381 | 24.557 | 12.033 | 11.044 |
| 68k | 4,2 | 298,5 | 502,2 | 315,1 | 28.919 | 30.210 | 12.074 | 11.058 |
| 74k | 4,7 | 1.001,9 | 1.756,2 | 1.585,6 | 26.274 | 36.854 | 14.045 | 12.057 |
| 80k | 4,3 | 335,2 | 525,0 | 349,1 | 26.173 | 42.896 | 14.051 | 12.057 |
| 86k | 4,3 | 386,7 | 621,2 | 445,8 | 24.212 | 50.532 | 14.105 | 13.056 |
| 92k | 4,1 | 344,9 | 601,9 | 348,2 | 24.200 | 55.837 | 16.108 | 12.097 |
| 98k | 4,6 | 341,5 | 543,3 | 341,8 | 24.380 | 60.895 | 15.065 | 13.058 |

As latências estão em ms e cobrem todas as respostas do POST. A tabela sai de `degraus-308164.csv`, e o gráfico está em `degraus-308164.html`.

- **5xx:** 0 em todos os degraus, nas reservas e nas confirmações. Nenhum "outros" nem EOF.
- **Descartes:** só no 74k. O k6 descartou 229 iterações (efetivo de 73.772 para um alvo de 74.000) e avisou "Insufficient VUs" às 12:11:40Z
  (hora do log do gerador, sem fonte versionada).
- **O p95 de 1.001,9 ms do 74k tem duas explicações possíveis, sem isolar qual pesou:**
  - **Hipótese 1, o gerador:** chegou aos 3000 VUs e descartou iterações.
  - **Hipótese 2, o servidor:** às 12:11:39Z o pool do Supavisor reabre (`pg_conexoes` 182 → 247 na `coleta-host`) com `pg_espera_lock` em 200.
    O aviso de VUs vem 1 s depois. A pior janela de 30 s do degrau (a 1ª) tem p95 de 1.585 ms e a seguinte, 286 ms. De 80k a 98k, com o mesmo
    `MAX_VUS`, não houve descarte.
  - No 80k o p95 voltou a 335 ms.
- **1º degrau degradado (p95 ≥ 1 s), sem contar o 20k a frio:** **32k**. O 74k também passa de 1 s (ver acima).
  - No K0 o primeiro foi 26k, na #227 foi 32k e na R5, 38k.
- **Overselling:** 0.
  - 868 eventos e capacidade total de 434.000.
  - 178.356 ativas: 158.690 confirmed + 19.666 pending, que batem na mesma leitura.
  - Nenhum evento com overselling.
- **Sagas** (`verificar-rpm`, rc 0): convergidas.
  - Pelo `verificar-rpm`: 0 velhas, 0 hold `held` com saga compensated, 0 devolução pendente, 0 órfã inversa, 0 `quant` divergente.
  - No fim do bloco (`resumo-saga`): 0 compensações, `devolucao_pendente` 0, `orfa_inversa` 0, 0 sagas `reserving` e 0 `compensating`.
  - Lag de devolução da vaga (n 186.750): p50 220 ms, p95 622 ms, máximo 1.494 ms. No K0 o p95 foi 338 ms e na R5, 448 ms.
- **Dell, pela coleta da sessão DB:**
  - **Conexões** (`pg_stat_activity` a cada 5 s):
    - Pico de 263 de 300, a primeira vez às 11:55:55Z, com platô em 262–263.
    - Ficou em 250 ou mais de 11:55:50Z a 12:24:26Z, com uma queda para 192–198 entre 12:08:40Z e 12:11:37Z (62k–68k), que a `coleta-host`
      também mostra (`pg_conexoes` 247 → 177 → 247). Fora dessa queda, o pool do Supavisor (245) ficou cheio.
    - Pico de 243 active às 11:59:48Z.
  - **CPU** (vmstat): us+sy com pico de 62% às 12:01:10Z. Média de 18,1% na janela da carga (12,4% na coleta inteira).
  - **PSI avg10** (`dell/psi.txt`): cpu some com máximo de 12,02 (12:01:44Z) e io some com máximo de 13,95 (12:09:00Z).
  - **NVMe:** %util médio de 44,9% na janela da carga (27% na coleta inteira), com só 5 de 2.421 amostras em 90% ou mais.
  - **Vigia:** nenhum evento. Sem restart, sem mudança de health, sem falha de psql, sem passar de 270 conexões e sem "too many clients",
    FATAL ou PANIC.
- **CPU do host durante o k6** (`telemetria-host`): média de 86,2%, incluindo o setup e as pausas; só nos degraus de carga, 88,4%. RAM livre
  mínima de 23,3 GB. O `cpu_pct` passa de 100 porque é a `PercentProcessorUtility`, na escala da frequência
  (`lib-telemetria.ps1`, linha 4): com o turbo, o uso passa da frequência base.

**K0 × K1, o efeito do db remoto no cluster:**
- A fase lenta encolheu: o p50 passa de 100 ms só em 32k–38k. No K0 isso ia de 26k a 44k, com o p50 chegando a 753 ms.
- Os 429 começam em 44k (3.916). No K0 começavam em 38k (5.715).
- De 50k para cima: admitir p95 de 10 a 16 s (K0: 17–21 s) e ponta a ponta p95 de 10 a 13 s (K0: 14–17 s).
- **O porquê não está isolado.** A hipótese de que o host deixa de dividir a CPU com o Postgres **não é sustentada pelos dados**: a CPU do host
  foi maior no K1 (86,2%) que no K0 (83,5%), e por degrau o K1 fica igual ou acima (99–105% contra 95–103%). Além do banco, K0 e K1 diferem na
  ordem (o K0 rodou primeiro), no horário e no harness (a826c8d × 67c0ef8).

**K1 × #227, o efeito do Kubernetes com o db remoto:**
- O 1º degrau degradado é o mesmo (32k).
- Acima de 50k, a admissão fica perto da da #227 (admitir 11–14 s, ponta a ponta 10–12 s).
- O lag de devolução da vaga é parecido: p95 de 622 ms no K1 contra 640 ms na #227 (README da etapa 09).

### Notas de método

- **Coleta em modo cluster:** 1273 amostras em 2400 s, `duracao_amostra_ms` com p50 1.249 e p95 4.804. A finalização foi normal (o
  script não foi editado durante a coleta).
- **`registro-*.txt`:** o env agora sai do spec do Deployment.
  - Os literais aparecem: Hikari 1000/250 e 32 workers.
  - O que vem por `envFrom` sai vazio, como já documentado no K0: o gatilho do `admission` e o Tomcat e a saga do `reservation`. Os
    valores são os mesmos do K0, 56000 / 1 / 0,8 / 0,7.
- **O `pgss` inclui as consultas do `verificar-rpm`.** Ele rodou às ~12:21Z, antes de a coleta fechar (12:33Z), como no K0.
- **`verificar-rpm`:** rodou depois da escada, sem carga no Dell. Saída em `host-telemetria/verificacoes-k1.log`.

### Arquivos

- `degraus-308164.csv`, `degraus-308164.html`, `plano-degraus-308164.json`
- `gerador/summary-degraus-308164.json`: resumo do k6, do ref temporário `K8S-gerador-K1` (2271066)
- `host-telemetria/`: `coleta-host-*`, `eventos-*`, `pgss-*`, `registro-*`, `resumo-saga-*`, `saga-*`, `telemetria-host-*` e
  `verificacoes-k1.log`
- `dell/`: coleta do Dell pela sessão DB (pacote do ref temporário `K8sDB-dell-K1`, d67101f, sha256 `1fb86b77…cf440`, 5.922.538 bytes,
  conferido):
  - `mpstat.txt`, `vmstat.txt`, `psi.txt`, `pg_activity.csv`, `inicio.txt` e `fim.txt`;
  - `iostat-nvme0n1.txt` e `sar-filtrado.csv`, com o mesmo recorte da #227. O `sar.csv` original (38,7 MB) e o `sar.bin` (61,7 MB) não
    entraram.

## K2 (`Deg-331542`), 2026-11-01

### Configuração

- **Cluster:** o mesmo host do K0 e do K1, num cluster novo. Branch `Issue-228` em **e4f862f** (o harness é o do K1; desde 67c0ef8 só mudou
  `results/`).
  - `K8S_OVERLAY=rodada SLIM_TAG=k8s K8S_DB_REMOTO=192.168.68.50:5433 Projeto/k8s/cluster.sh up --trilha b1`, depois `cluster.sh db-teste`
    com rc 0.
  - Sem `K8S_POOLS`: valem os pools do cluster (soma 1492) e o pool real de 245 do Supavisor. Os 7 ScaledObjects têm mínimo 1 e máximo 3, e o
    Istio põe um sidecar em cada pod dos serviços.
- **Primeira tentativa abortada:** o gerador ficou sem RAM e o usuário decidiu abortar e repetir. Os brutos estão em `K2-abortado/`, fora
  da análise.
- **Limpeza antes da repetição:** `CARGA_K8S=kind-gerenciador limpar-banco.sh`, com rc 0. Foi liberada pelo usuário direto na sessão.
  - Os mesmos zeros do K1, com 1 linha em `identity.users` (a sonda).
  - Seed novo, com outro sufixo.
- **Seed e escada:** os mesmos do K0 e do K1. 1000 usuários e 868 eventos com capacidade 500, mesma escada e mesmos parâmetros do k6.
- **Réplicas no início (ressalva):** o seed tem 1000 cadastros com bcrypt e fez o KEDA subir o `identity` para 3 e o `stock` para 2 (pelo
  `kubectl` da sessão, sem fonte versionada).
  - Às 18:24:00Z, já no setup do k6, o `stock` tinha voltado a 1 e o `identity` estava em 2. O resto estava em 1.
  - Ainda no setup, o `backend` foi a 2 às ~18:24:14Z e o `identity` voltou a 3 (`coleta-host`). Os dois entraram na carga escalados: backend 2 e
    identity 3.
  - O braço C da R4 e da R5 parte de tudo em 1. Aqui não deu para esperar o cooldown: o k6 já tinha arrancado.
- **Gerador:** clone em 850d38e, como no K0 e no K1, com o jogo e o Steam fechados. Relato da sessão do gerador, sem fonte versionada:
  - RAM livre de 9,93 GB antes (no K1, 9,92 GB), mínima de 3,08 GB às 18:26:14Z e 9,90 GB no fim.
  - O k6 chegou a 7,0 GB: com p50 de ~3 s, as VUs ficam presas. CPU do gerador no máximo em 56%.
- **k6:** de 18:23:47Z a 18:26:20Z, com código de saída **99** (parada por p95). Os 1000 logins do setup levaram 15,8 s (log do gerador, sem
  fonte versionada). A carga começou às ~18:25:19Z (1º insert na `coleta-host`).
- **Coleta no Dell:** sessão DB, `~/coleta-227.sh` com saída `coleta-k8s-K2`, de 18:23:36Z a 18:27:04Z, com o vigia ligado.

### Resultado

| RPM alvo | efetivo | p50 | p95 | p99 | p95 pior janela 30 s | 202 | 429 | 5xx | descartes |
|---|---|---|---|---|---|---|---|---|---|
| 20k | 18.773 | 2.943,5 | **5.019,6** | 6.388,0 | 5.567,3 | 2.025 | 0 | 0 | 0 |

As latências estão em ms. A tabela sai de `degraus-331542.csv`, e o gráfico está em `degraus-331542.html`.

- **Parada no 1º degrau:** p95 de 5.020 ms na janela de 60 s, **20 ms acima do limite de 5.000 ms** (`PARADA_P95_MS`).
  - Os degraus de 26k a 98k não rodaram.
  - É a regra de parada de todos os blocos e foi mantida: o K2 não se repete até passar.
  - O 20k (a frio) deu p95 de 0,91 s no K0 e 1,8 s no K1. Aqui ele passou do limite.
- **5xx:** 0, nas reservas e nas confirmações. Nenhum "outros", descarte, EOF ou "Insufficient VUs".
- **Overselling:** 0.
  - 868 eventos e capacidade total de 434.000.
  - 10.001 ativas: 9.309 confirmed + 692 pending.
  - Nenhum evento com overselling.
- **Sagas** (`verificar-rpm`, rc 0): convergidas.
  - Pelo `verificar-rpm`: 0 velhas, 0 hold `held` com saga compensated, 0 devolução pendente, 0 órfã inversa, 0 `quant` divergente.
  - No fim do bloco (`resumo-saga`): 0 compensações, 0 `reserving` e 0 `compensating`. Não houve cancelamento nem expiração na janela, então
    não há amostra do lag de devolução.
- **Fila (202):** das 66 reservas acompanhadas, as 66 deram `rejected`. No K1, no mesmo degrau, foram 18 acompanhadas: 2 admitidas e 16
  rejeitadas.
  - **Motivo:** contei todos os resultados da fila no Redis (`adm:res:*`, consulta avulsa, sem fonte versionada): 2.061, sendo 1.846
    `rejected` e 215 `pending`, 0 `timed_out`. Todos os 1.846 `rejected` têm o motivo **"Evento lotado"**.
  - Os 2.061 resultados passam em 36 as 2.025 respostas 202 do CSV. A explicação provável são as tentativas em voo quando o k6 parou: o
    gateway enfileirou, mas a resposta 202 não chegou a ser contada.
  - É o 400 de negócio que o `reservation` devolve ao worker do `admission` quando o CAS no `stock` acha o evento cheio.
  - **É esperado:** no mapeamento sequencial a carga se concentra num evento por vez. A fila liga quando o evento fica quente, e o worker
    processa a mensagem depois que as 500 vagas dele já foram tomadas pelo caminho síncrono.
  - A fração rejeitada é praticamente igual à do K1: 89,6% de todos os resultados no K2, contra 88,9% (16 de 18) na amostra do K1.
  - A amostra acompanhada parece enviesada no tempo: 0 das 66 em `pending`, contra 10,4% de `pending` no total.
  - No K2 a fila durou mais: ficou com mensagens por ~1 min (18:25:19Z a 18:26:19Z), com pico de 842 em `admission.requests`. No 20k do K1 foram
    ~6 s, com pico de 538 (`coleta-host`, `rabbit_requests`).
  - Nenhum `rejected` veio de timeout ou erro do worker: esses casos voltam à fila com backoff e, vencido o prazo, viram `timed_out`, e houve
    0.
- **Réplicas no 20k** (`coleta-host`; backend/reservation/identity/catalog/admission/notification):
  - 18:25:19Z, a carga começando: 2/1/3/1/1/1;
  - 18:26:04Z: 2/1/3/1/2/1;
  - 18:26:07Z: 3/1/3/1/2/1;
  - 18:26:16Z: 3/1/2/1/2/1;
  - 18:26:19Z: 3/1/2/1/3/1.
  - Fim: o `stock` (fora das colunas da coleta) estava em 3 pelo `kubectl` às 18:26:56Z (sem fonte versionada). O `reservation` ficou em 1:
    ele escala pelo `adm:hot`, que não passou do gatilho.
- **CPU do host no 20k** (`telemetria-host`, na mesma janela nos dois blocos: os primeiros 60 s de carga, a partir do 1º insert na `coleta-host`):
  - K2: média de **109,5%** e máxima de 113%;
  - K1: média de 97,5% e máxima de 112%;
  - K0: média de 95,7%.
  - RAM livre mínima do host no K2: 19,9 GB.
- **Dell, pela coleta da sessão DB:** não saturou.
  - Conexões: pico de 262 de 300 (primeiro às 18:26:23Z; o pool ficou cheio e ocioso depois do k6), pico de 161 active às 18:26:18Z e pico de
    30 idle in transaction às 18:25:32Z.
  - CPU us+sy com pico de 33%; média de 13,4% na janela da carga (7% na coleta inteira).
  - NVMe com %util máximo de 60,9% e médio de 41,1% na janela da carga (13% na coleta inteira).
  - Vigia: nenhum evento.
- **Espera de lock no Postgres** (`coleta-host`, `pg_espera_lock`): máximo de 153 no 20k. No K1, 124 no mesmo degrau.

**Leitura (hipótese, não isolada): CPU do host.**
- O host passou de 100% durante o degrau, e o Dell e o gerador ficaram longe do limite. A hipótese é que, no nó único do kind, os sidecars do
  Istio (b1) e as JVMs novas da autoescala disputam os mesmos núcleos. Escalar num nó só não adiciona CPU, só a divide.
- **Nem a CPU como gargalo nem o custo do Istio foram isolados.** Do K1 para o K2 mudam vários fatores ao mesmo tempo:
  - o Istio, com um sidecar por pod;
  - a autoescala 1..3;
  - os Hikari: o `registro` do K2 dá reservation 200 e stock 60, contra 1000 e 250 no K1;
  - os workers do `admission`: 32 por réplica, até 96 consumidores com 3 réplicas;
  - as réplicas que já começaram escaladas (backend 2, identity 3);
  - um degrau só, a frio.
- O `pool_hikari` 1000 do CSV e do plano do K2 é o rótulo do `preparar` (o parâmetro `-PoolHikari`), não o pool real do reservation (200).

### Notas de método

- **Coleta em modo cluster:** 148 amostras do início da coleta (18:23:31Z) ao SIGINT (18:27:27Z), parada assim que as sagas zeraram. A
  telemetria foi parada junto.
- **`verificar-rpm`:** rodou depois da escada, sem carga no Dell. Saída em `host-telemetria/verificacoes-k2.log`.
- **A contagem dos motivos no Redis** foi feita depois do `verificar`, por `kubectl exec` no pod do Redis, com a senha só dentro do pod
  (como no `limpar-banco`). A saída não foi versionada; o cluster já foi apagado.

### Arquivos

- `degraus-331542.csv`, `degraus-331542.html`, `plano-degraus-331542.json`
- `gerador/summary-degraus-331542.json`: resumo do k6, do ref temporário `K8S-gerador-K2` (ea6cb24)
- `host-telemetria/`: `coleta-host-*`, `eventos-*`, `pgss-*`, `registro-*`, `resumo-saga-*`, `saga-*`, `telemetria-host-*` e
  `verificacoes-k2.log`
- `dell/`: coleta do Dell pela sessão DB (pacote do ref temporário `K8sDB-dell-K2`, 5c0491e, sha256 `687c2812…f453a` conferido):
  - `mpstat.txt`, `vmstat.txt`, `psi.txt`, `pg_activity.csv`, `inicio.txt` e `fim.txt`;
  - `iostat-nvme0n1.txt` e `sar-filtrado.csv`, com o mesmo recorte do K1.

## K2-repeticao (`Deg-335785`), 2026-11-01

O usuário pediu que o K2 fosse refeito e que, se ele parasse de novo, o motivo fosse investigado. O K2 da seção anterior fica como está.

### Configuração

- **Cluster:** novo, com a config do K2. Branch `Issue-228` em **a7da861** (o harness é o do K2; desde e4f862f só mudou `results/` e READMEs).
  - `K8S_OVERLAY=rodada SLIM_TAG=k8s K8S_DB_REMOTO=192.168.68.50:5433 Projeto/k8s/cluster.sh up --trilha b1`, depois `cluster.sh db-teste`
    com rc 0.
  - **Sem `K8S_POOLS=r5`, como no K2:** o `cluster.sh` só aceita r5 com a autoescala travada em 1. Valem os pools do cluster
    (`host-telemetria/registro-*`): reservation 200 e stock 60. Os outros são os literais do overlay, com soma 1492 e pool real de 245.
- **Limpeza:** `CARGA_K8S=kind-gerenciador limpar-banco.sh`, com rc 0. Liberada pelo usuário direto na sessão, com os mesmos zeros e 1 linha em
  `identity.users`.
- **Réplicas antes do k6:**
  - Depois do seed, o KEDA estava em identity 3, catalog 2 e stock 2.
  - Esperei todas voltarem a 1, o que aconteceu às 19:35:17Z, cerca de 1 min depois do seed, conferido pelo `kubectl`. Só então o k6 foi
    disparado.
  - O setup do k6 (1000 logins com bcrypt) levou o identity de novo a 2 e a 3 (`pods/replicas-*`, às 19:36:38Z e 19:36:53Z). Nos degraus de
    carga ele voltou a 1. É o comportamento do braço.
- **Gerador:** 850d38e, sem jogo aberto.
  - RAM livre de 9,81 GB no disparo, mínima de 2,23 GB às 19:41:42Z (o k6 chegou a 8,0 GB com as VUs presas) e 9,97 GB no fim. CPU no máximo
    em 48%.
  - Fonte: `gerador/telemetria-gerador-k2rep-335785.csv`, o monitor de 10 s.
- **k6:** de 19:35:57Z a 19:42:01Z, com código de saída **99** (parada por p95 no 32k). Os logins do setup levaram 28,9 s
  (`gerador/k6-console-335785.log`).
- **Coleta no Dell:** sessão DB, `coleta-k8s-K2-rep`, de 19:35:53Z a 19:43:08Z.
- **Coletor por pod (novo):** `pods/coleta-pods.sh`, a cada 5 s. Grava três CSVs:
  - `top-pods-*`: o `kubectl top pods --containers`;
  - `cgroup-cpu-*`: `cpu.stat` e `cpu.max` do cgroup v2 de cada container no nó kind, incluindo o `istio-proxy`, que é native sidecar;
  - `replicas-*`: as réplicas de cada Deployment.

  **É carga extra no host que o K2 não tinha:** com o cluster ocioso, a CPU do host foi de 16,7% sem o coletor para 18,9% com ele, cerca de +2,2
  pontos (60 s em cada caso, `host-telemetria/telemetria-host-ocioso-*`).

### Resultado

| RPM alvo | efetivo | p50 | p95 | p99 | p95 pior janela 30 s | 202 | 5xx (reserva / confirma) | descartes |
|---|---|---|---|---|---|---|---|---|
| 20k | 20.001 | 1.795,0 | 4.841,3 | 5.904,8 | 5.224,0 | 5.592 | 0 / 0 | 0 |
| 26k | 26.001 | 1.550,5 | 3.222,5 | 3.992,4 | 3.278,2 | 6.798 | **67 / 1** | 0 |
| 32k (parcial) | 25.015 | 4.453,1 | **5.940,9** | 6.689,8 | 6.050,6 | — | 0 / 0 | **5.227** |

A tabela sai de `degraus-335785.csv`, e o gráfico está em `degraus-335785.html`.

- **Parada no 32k:** p95 de 5.941 ms na janela de 60 s. O k6 chegou aos 3000 VUs ("Insufficient VUs", 19:41:16Z, no console do k6) e
  descartou 5.227 iterações.
- **Desde o 20k o p50 fica em 1,5–1,8 s.** No mesmo degrau, o K0 e o K1 ficaram em 25–27 ms. O 20k sozinho repete o do K2 (p95 de 4,8 s contra
  5,0 s), agora partindo de 1 réplica.
- **5xx:** 67 na reserva e 1 na confirmação, todos no 26k. É a primeira vez que aparecem na etapa 10.
  - O k6 não registra o código, e nenhum serviço logou ERROR (gateway, reservation, stock, admission, identity e catalog, pelo `kubectl logs`).
  - O gateway logou só 3 avisos de "admission indisponível", com fail-open.
  - O log de acesso do Istio está desligado. A origem fica em aberto.
  - Candidatos: um 503 do Envoy durante as trocas de réplica, já que backend, admission e stock escalaram entre 19:38:06Z e 19:38:27Z e o
    identity desceu às 19:39:03Z; ou uma réplica nova do reservation, que subiu às 19:40:16Z e saiu às 19:43:01Z, e cujos logs se perderam.
- **Overselling:** 0 (`host-telemetria/verificacoes-k2rep.log`): 868 eventos, 31.883 ativas (30.939 confirmed + 944 pending) e 4.617 expired.
- **Sagas** (`verificar-rpm`, rc 0): convergidas, com 0 velhas, 0 held com saga compensated, 0 devolução pendente, 0 órfã inversa e 0 `quant`
  divergente.
- **Fila:** 5.592 respostas 202 no 20k. No K1 foram 431, e no K2, 2.025.
  - Das acompanhadas, 94 de 263 foram admitidas no 20k e 141 de 334 no 26k.
  - `admission.requests` chegou a 2.060 mensagens (`coleta-host`).
- **Host** (`telemetria-host`): CPU média de 105,4% no 20k (máxima de 113%) e de 96,6% na janela de carga inteira. RAM livre mínima de
  20,2 GB.
- **Postgres** (`coleta-host`): espera de lock com máximo de 179; `pg_conexoes` com máximo de 248.
- **Dell, pela coleta da sessão DB:** não saturou.
  - Pico de 263 conexões às 19:39:26Z, com o pool do Supavisor cheio.
  - Pico de 182 active às 19:41:17Z e de 39 idle in transaction às 19:39:36Z.
  - CPU us+sy com pico de 43% e média de 12,3% na coleta inteira; NVMe com %util máximo de 74% e médio de 22% na coleta inteira.
  - O log do Postgres roda com `log_min_messages=fatal`, então ERROR e WARNING não aparecem nele.

### Investigação: o que os dados por pod mostram

Janela da carga: de 19:37:28Z (fim do setup) a 19:42:01Z. Fontes: `pods/cgroup-cpu-*` e `pods/top-pods-*`.

- **O RabbitMQ bateu no limite de CPU.** Média de 1,18 núcleo com limite de 2 (`cpu.max` 200000/100000), throttling em **19% dos períodos**
  (480 de 2.584) e 29,5 s de throttling na janela.
  - Nenhum outro container passou de 5% dos períodos.
  - Com a fila ligada desde o 20k (5.592 respostas 202), o RabbitMQ entra no caminho de cada reserva enfileirada.
- **O gateway não espalhou a carga.** O KEDA subiu o backend para 3 réplicas, mas uma delas (`rjmxc`) ficou com 572 m de CPU em média e as
  duas novas com 127 m cada.
  - A hipótese é que a entrada do k6 pelo NodePort reaproveita as conexões keep-alive já abertas no pod original, porque o balanceamento é
    por conexão. Por isso a réplica nova não alivia o gateway.
  - Entre gateway e reservation o Istio balanceia por requisição: as duas réplicas do reservation dividiram a CPU (0,61 e 0,73 núcleo).
- **Sidecars:** o `istio-proxy` do gateway quente usou 0,55 núcleo, quase o mesmo que o próprio gateway (0,60), e o do reservation, 0,33. O
  `istio-proxy` não tem limite de CPU (`cpu.max` `max`), então não sofre throttling.
- **A CPU somada dos containers** (`top`) teve média de 7,0 núcleos e máxima de 13,7 na janela.
- **O host não foi o único fator.** A CPU do host ficou em 96,6% na janela inteira, abaixo da do K2 (109,5% no 20k). Mesmo assim, o p50 já
  estava em 1,8 s no 20k.

**Hipóteses para o p95 do braço b1, nenhuma isolada:**
1. **RabbitMQ com throttling** no limite de 2 núcleos, com a fila ligada desde o 20k. A fila liga muito mais que no K1 (5.592 contra 431
   respostas 202), o que pode ser causa e efeito ao mesmo tempo: a latência alta concentra rajadas no contador do `admission`.
2. **Entrada sem balanceamento:** o gateway escala, mas a carga fica na réplica original.
3. **Custo do Istio:** um sidecar por pod, com quase 1:1 de CPU no gateway quente.
4. **Pools menores** que no K1: reservation 200 contra 1000 e stock 60 contra 250.
5. **CPU do host**, perto do teto no 20k.

O cluster ficou no ar para a investigação.

### Arquivos

- `degraus-335785.csv`, `degraus-335785.html`, `plano-degraus-335785.json`
- `gerador/`: `summary-degraus-335785.json`, `telemetria-gerador-k2rep-335785.csv` (o monitor de RAM e CPU) e `k6-console-335785.log`. Vêm
  do ref temporário `K8S-gerador-K2-rep` (edbd70e).
- `host-telemetria/`: `coleta-host-*`, `eventos-*`, `pgss-*`, `registro-*`, `resumo-saga-*`, `saga-*`, `telemetria-host-*`,
  `telemetria-host-ocioso-*` (custo do coletor por pod) e `verificacoes-k2rep.log`
- `pods/`: `coleta-pods.sh`, `top-pods-*`, `cgroup-cpu-*` e `replicas-*`
- `dell/`: coleta do Dell pela sessão DB (ref temporário `K8sDB-dell-K2-rep`, 562bf5c, sha256 `f8cec76d…f27ef`, 1.091.168 bytes, conferido),
  com o mesmo recorte do K1.

## K2-pos-231 (`Deg-473284`), 2026-11-03, issue #237

O K2 refeito com o `stock` da #231: 1 réplica fixa, Hikari 245, `Recreate` e sem ScaledObject. O `admission` ficou com `K8S_ADMISSION_MIN=1`
para o A/B da #231: o render só difere no stock, mas na execução a autoescala divergiu do K2-repetição. A análise completa, as fontes e a regra de
janela estão em [`K2-pos-231/README.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/Projeto/carga/results/10-k8s-db-remoto/K2-pos-231/README.md).

| | Parada | 20k p50 / p95 | 26k p50 / p95 | 32k p50 / p95 | 5xx | Overselling |
|---|---|---|---|---|---|---|
| K2 | 20k | 2.943,5 / 5.019,6 | — | — | 0 | 0 |
| K2-repeticao | 32k | 1.795,0 / 4.841,3 | 1.550,5 / 3.222,5 | 4.453,1 / 5.940,9 | 67 / 1 (26k) | 0 |
| K2-pos-231 | 32k | 891,1 / 2.875,9 | 1.436,7 / 2.970,8 | 3.963,9 / 5.515,2 | 0 | 0 |

**Leitura:**
- **Ponto de parada:** a #231 não o mudou. Com ela o b1 parou no mesmo 32k do K2-repetição, que, sem a #231, também tinha passado do 20k.
- **Latência:** bem menor no 20k (p50 de 891 contra 1.795 ms) e próxima no 26k (1.437 contra 1.551 ms), com 1 rodada por config. A variação
  entre rodadas da mesma config é grande: no 20k o K2 deu 2.944 e o K2-repetição 1.795.
- **Limite provável agora, não isolado:** o lock da linha quente no Dell.
  - O pool real de 245 ficou cheio, com até 239 sessões esperando lock (`coleta-host`; 236 em `Lock/transactionid` no Dell).
  - O Dell ficou com CPU e disco sobrando.

## Versão do harness por bloco

- K0: #228 em a826c8d, com as correções de `-c` e da variável `ReadPath` aplicadas só no `verificar` final.
- K1: 67c0ef8.
- K2: e4f862f.
- K2-repeticao: a7da861 (o código k6 do gerador, em 850d38e, é idêntico em todos os blocos).
- K2-pos-231: ada814b (topo da `Issue-232`), o mesmo k6 em 850d38e.
