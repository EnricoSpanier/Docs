# Etapa 04: Fase 6 (CQRS + Event Sourcing) — Rodada 2 (#31)

## O que estava implementado

- Monólito modular da Fase 5 (`identity`, `catalog`, `reservation`, `notification`, `gateway`), no mesmo processo.
- Fase 6 (CQRS + ES), `main` em `1ee6fbe` (merge do PR #145):
  - `catalog` e o lado wallet de `reservation` event-sourced (`event_store` + `event_outbox` + relay).
  - Broker Redpanda (container dev, só na rede `gerenciador-net`).
  - Braço `naive`: lê a projeção `event_availability` alimentada pelo consumer do tópico; o lag é o real do
    pipeline (medido em `lag_obs_*`), não mais um timer. A coluna `lag_ms` vale sempre 0.
  - Braço `cas`: `eventcap` relacional com `UPDATE` condicional (CAS), inalterado.
- `rodar-matriz.ps1` espera o pipeline ficar ocioso (`Wait-Estavel`) antes de cada repetição.

## Configuração

- Tomcat 300 threads, Hikari 1000, pool do Supavisor 245, `max_connections` 300.
- Gerador: AMD Ryzen 5 7600, k6 v2.2.0, psql 16.15, plano de energia Alto desempenho, portas dinâmicas TCP
  `start=10000 num=55535`.

## Ressalvas

- Rede em Wi-Fi, com IPs novos. Baseline de 2026-10-19 (`baseline-20261019-074604.txt`): HTTP p50 26,6 ms /
  p95 42,9 ms, ping médio 18,55 ms (máx. 180 ms). Nas rodadas anteriores: p50 ~14,9 ms / p95 ~19 ms. A comparação
  de latência com as etapas anteriores fica com essa ressalva; a de overselling não é afetada.
- O `setup-gerador.ps1` não ajustou o plano de energia (GUID errado no script); o plano Alto desempenho foi ativado
  à mão antes das rodadas.
- Estado do banco: os blocos 1 a 3b (matrizes naive e CAS, escadas com e sem consumer) rodaram sobre banco
  **acumulado** (sem limpeza entre eles; o backlog do consumer foi crescendo). Do bloco 4 em diante, o banco do host é
  **limpo antes de cada teste** (TRUNCATE em todas as tabelas, tópicos e consumer group do Redpanda apagados,
  backend reiniciado).
- Rede: hoje o gerador e o host estão em Wi-Fi; o cabo volta no fim de semana.

## Período

2026-10-19.

## Blocos

| Bloco | Teste | Host | Banco | Resultado |
|---|---|---|---|---|
| 1 | matriz naive (N 100/200 × 5) | `naive`, consumer ligado | acumulado | oversell máximo (80 / 180) |
| 2 | matriz CAS (N 100/200 × 5) | `cas`, consumer ligado | acumulado | oversell 0 |
| 3 | escada X (grossa + refino) | `cas`, consumer ligado | acumulado | X ≈ 56k RPM |
| 3b | escada X (grossa + refino) | `cas`, consumer **desligado** | acumulado | X ≈ 61k RPM |
| 4 | aleatório 45 min | `cas`, consumer ligado | limpo | 0 erros; p95 4,5×–9,6× o da #109 |
| 5 | escada X (grossa + refino) | `cas`, consumer **em lote** (`:146`) | limpo | X ≈ 58k RPM (55k é pico isolado) |

Todos com `max_connections` 300, pool do Supavisor 245, Hikari 1000 e Tomcat 300. Referência: pós-pooler sem ES
(etapa 03), X ≈ 78k.

## Arquivos

- `host-lag/`: amostras do offset lag do consumer group (mensagens), gravadas no host. Três arquivos têm `ts`
  provavelmente em UTC (a confirmar), exatamente 3:00:00 à frente do `-NNNNNN` do nome do arquivo, que é o horário do
  gerador (UTC−3); o `lag-poll-cas` está no
  horário local do gerador.
  - `lag-poll-escada-20261019-075856.csv` (`ts,total_lag`, 1 s, 5.219 amostras, 10:58:57 a 12:28:55): blocos 3 e 3b.
    Máximo com o consumer ligado: 362.342 (grossa) e 578.674 (refino, 187.917 herdados). Depois do fim do bloco 3 o valor
    para de drenar (564.215, depois 792.777): consumer desligado para o 3b.
  - `lag-poll-aleatorio-20261019-101744.csv` (`ts,total_lag`, 1 s, 3.495 amostras, 13:17:45 a 14:17:44): passa do fim
    do teste (14:05:33 no relógio do host) e pega o início do bloco 5. Recorte usado: a janela do teste (término menos
    2702 s), 2.625 amostras, média 2,9, máximo 49.
  - `lag-poll-escada146-20261019-111138.csv` (`ts,total_lag`, 1 s, 2.096 amostras, 14:11:38 a 14:47:54): bloco 5. Máximo
    66.333 (grossa) e 118.606 (refino). O 0 em 14:22:26 é o reset do banco entre as escadas.
  - `lag-poll-cas-20261019-075645.csv` (`ts,offset_lag,outbox`, 80 amostras de ~1,5 s, 07:56:46 a 07:58:42): nomeada
    para a matriz CAS; a cobertura completa da matriz não foi conferida. Máximos: offset lag 21, outbox 3.

Os `.html` (gráficos do `make report-matriz` / `make report-degraus`) não são versionados: regeneram-se a partir dos
CSVs.

- `baseline-20261019-074604.txt`: latência base de rede do gerador (`make setup-gerador`).
- `matriz-naive.csv`: matriz do braço `naive` (10 linhas: N ∈ \{100, 200\} × 5 repetições, capacity 20,
  `PCT_CONFIRMA=100`), host em `READPATH=naive`. Oversell máximo em todas as repetições (80 em N=100, 180 em N=200),
  0 erros 5xx. `lag_obs_disparo` = -1 em todas, por construção (a linha do evento na projeção só nasce com a 1ª reserva, depois do disparo).
- `matriz-cas.csv`: matriz do braço `cas` (10 linhas, mesmo protocolo), host em `READPATH=cas`. Oversell 0 em todas
  as repetições (20 confirmadas; 80 / 180 recusadas como lotado), 0 erros 5xx.
- Escada X com CAS: roda depois das duas matrizes, sobre o mesmo volume (o banco não foi limpo entre os blocos).
  Pool do Supavisor 245, `max_connections` 300, Hikari 1000, `MAX_VUS` 3000, 200 usuários, degraus de 60 s.
  - `degraus-181953.csv`, `.html` e `summary-degraus-181953.json`: escada grossa de 40k a 120k, passo 10k. Satura em
    60k (p95 de janela 1,28 s, 877 timeouts TCP de leitura, 277 descartes); acima de 70k o efetivo trava em ~63k RPM
    com p95 ~2,3 s. 0 erros 5xx.
  - `degraus-183194.csv`, `.html` e `summary-degraus-183194.json`: refinamento de 50k a 60k, passo 1k; o 1º degrau é
    aquecimento. **X ≈ 56k RPM** (p95 de janela 1,84 s), firme: 0 descartes, 0 outros e 0 erros 5xx em todos os
    degraus. Pós-pooler sem ES (etapa 03): X ≈ 78k.
  - Host durante a escada (`host-lag/lag-poll-escada-*.csv`): lag máximo do consumer group da projeção de **~362 mil**
    mensagens na grossa e **~579 mil** no refino; o relay acompanhou (`event_outbox` = 0). (Os ~793 mil que aparecem
    depois no mesmo arquivo são do 3b, com o consumer desligado: o lag só acumula, não é o consumer atual.)
- Escada 3b, ES **sem consumer** (host com `EVENTS_CONSUMER_ENABLED=false` em override local, não versionado; relay
  ligado, append no `event_store`/outbox igual). Isola o custo do consumer: ES com consumer (bloco 3, X ≈ 56k) ×
  ES sem consumer (3b) × pós-pooler sem ES (etapa 03, X ≈ 78k). O 3b rodou depois do bloco 3, sobre o mesmo banco
  acumulado e com o consumer desligado: o lag do grupo ficou em 564.215 mensagens (fim do bloco 3) e subiu a 792.777 no 3b (1ª tentativa abortada ou
  grossa; a captura não distingue), sem ser consumido (não é lag do consumer atual).
  - 1ª tentativa (40k a 120k) abortada no degrau de 80k por falta de memória no gerador, sem CSV; o host não foi
    afetado. Refeita só até 80k.
  - O host trocou de IP durante a sessão (DHCP do Wi-Fi), sem efeito nos resultados já coletados: a 2ª tentativa
    abortou antes do seed (backend inacessível no IP antigo) e a escada foi relançada no IP novo.
  - `degraus-188193-sem-consumer.csv`, `.html` e `summary-degraus-188193-sem-consumer.json`: escada grossa de 40k a
    80k, passo 10k. 60k limpo (p95 de janela 590 ms); satura em 70k (efetivo ~59k, p95 2,56 s, 10.612 descartes).
    0 erros 5xx e 0 outros.
  - `degraus-188802-sem-consumer.csv`, `.html` e `summary-degraus-188802-sem-consumer.json`: refinamento de 60k a
    70k, passo 1k; o 1º degrau é aquecimento. O report marca X = 60k (p95 de janela 1005 ms, no limite), mas é o
    degrau de aquecimento e o mesmo degrau ficou em 590 ms na grossa; descontado ele, **X ≈ 61k RPM** (1,64 s,
    0 descartes). De 62k em diante o efetivo trava em ~60–65k. 0 erros 5xx e 0 outros em todos.
  - Leitura: pós-pooler sem ES ≈ 78k → append + relay, sem consumer ≈ 61k → ES com consumer ≈ 56k. Cerca de 17k da
    queda vêm do append no caminho quente; o consumer custa mais ~4–5k (2 a 5k conforme o critério e o consumer). Uma
    escada por camada, e as camadas **não diferem só pelo que foi ligado**: o ponto 1 (78k) rodou no cabo e em banco
    limpo; os blocos 3 e 3b, no Wi-Fi e em banco acumulado (o 3b depois do 3). O Tomcat não explica (a `degraus-39710`, da
    etapa 03, com 300 threads, deu o mesmo teto do ponto 1). Os ~17k incluem Wi-Fi e estado do banco.
- Bloco 4, aleatório de 45 min (`Ale-190276`), sobre **banco limpo**, host em `cas` com consumer ligado. Mesmo perfil
  da `Ale-913561` / `Ale-29057` (semente 617706, 1k–12k RPM, passo 30 s, 30% de leitura, 200 usuários,
  `PCT_CONFIRMA=100`).
  - `resultados-aleatorio.csv` (1 linha), `summary-ale-190276.json`, `perfil-ale-190276.json`.
  - 146.400 aceitas = 1464 × 100, todas confirmadas; 48.617 `lotado`; 0 erros 5xx, 0 outros, 0 descartes.
  - p50 / p95 / p99 (ms), contra a `Ale-29057` (#109, pós-pooler sem ES): reserva 10,8 / 36,2 / 62,0 (era
    3,9 / 5,7 / 10,7); confirma 8,7 / 29,7 / 56,0 (2,1 / 5,0 / 8,8); busca 58,8 / 128,3 / 222,4 (11,4 / 15,0 / 21,8);
    evento 7,9 / 32,7 / 58,1 (1,9 / 3,4 / 6,2); carteira 16,6 / 56,9 / 105,1 (3,2 / 12,6 / 25,0). O p95 ficou de 4,5×
    (carteira) a 9,6× (evento) maior; deltas do p95: reserva +30,5 ms, confirma +24,7, evento +29,3, carteira +44,3,
    busca +113,3. A baseline de HTTP subiu ~12 ms no p50 e ~24 ms no p95 contra o cabo. A origem é **hipótese** (ES no
    banco e Wi-Fi, sem separar): o evento, só leitura, subiu como a reserva, compatível com jitter do Wi-Fi, e só a
    busca e a carteira excedem a rede com clareza.
  - Host durante o aleatório (`host-lag/lag-poll-aleatorio-*.csv`, recortado na janela do teste: 2.625 amostras): lag do
    consumer em média 2,9 mensagens (máx. 49). O **backlog** do consumer não é a causa da alta de latência. Não houve
    aleatório com o consumer desligado.
- Bloco 5 (extra), escada com o **consumer em lote** (issue #146, até 500 mensagens por transação), sobre banco
  limpo, host em `cas`. Compara com o bloco 3 (consumer atual, X ≈ 56k) e o 3b (sem consumer, X ≈ 61k). O backend
  rodou a imagem local `:146`, montada com as classes da branch `Issue-146`: o Maven Central estava bloqueado na rede do host (erro
  PKIX de certificado), então a imagem não pôde ser construída pelo `docker compose build` normal.
  - `degraus-193515-consumer-lote.csv`, `.html` e `summary-degraus-193515-consumer-lote.json`: escada grossa de 40k
    a 80k, passo 10k. 50k limpo (p95 de janela 351 ms); 60k já com 1,76 s; acima de 70k o efetivo trava em ~58–59k.
    0 erros 5xx e 0 outros.
  - Host durante a escada (`host-lag/lag-poll-escada146-*.csv`): lag máximo do consumer em lote de **~66 mil** mensagens
    na grossa e **~119 mil** no refino, contra ~362 mil / ~579 mil do consumer atual no bloco 3. Com janelas iguais: no degrau de 80k, 179.634 (bloco 3)
    contra 66.333 (≈ 2,7×); no refino, o bloco 3 cresceu 390.757 (578.674 menos 187.917 herdados) contra 118.606
    (≈ 3,3×). O 0 que aparece em 14:22:26 (de 42.463) é o reset do banco entre as escadas, não drenagem. Drenagem com a
    carga parada: ~741 msg/s (lote, 14:21:52 a 14:22:20) contra ~457 msg/s (atual, 11:19:17 a 11:25:39). O p95 em 60k
    não melhorou com o lote (1,76 s contra 1,28 s de janela); a **hipótese** é que o consumer em lote disputa mais com a
    reserva (troca entre projeção fresca e vazão de escrita num banco compartilhado), mas no 60k do bloco 3 houve 877
    `outros` e 277 descartes fora do p95 (p99 de 4816 ms) contra 0 e 0 no bloco 5 (p99 de 1813 ms), e o banco estava
    acumulado no 3 e limpo no 5.
  - `degraus-194168-consumer-lote.csv`, `.html` e `summary-degraus-194168-consumer-lote.json`: refinamento de 50k
    a 60k, passo 1k, sobre banco limpo de novo; o 1º degrau é aquecimento. A regra estrita do report marca 55k (p95
    de janela 1077 ms, no limite), mas é **pico isolado**: 56k e 57k voltam a ficar abaixo de 1 s (991 / 990 ms) e a
    degradação sustentada começa em 58k (1,81 s; 59k e 60k também acima de 1 s). Pelo critério do artigo (primeiro
    degrau de saturação sustentada), **X ≈ 58k RPM**. 0 erros 5xx e 0 outros; só 60k teve descartes (302).
  - Leitura: consumer em lote ≈ 58k, contra ≈ 56k do consumer atual e ≈ 61k sem consumer: empata em vazão com o atual
    (dentro da resolução de 1k, uma escada por camada). O lote mantém a projeção mais em dia (backlog ≈ 2,7× a 3,3×
    menor com janelas iguais), sem ganhar vazão de escrita.
