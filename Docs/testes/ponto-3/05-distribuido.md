# Etapa 05: Fase 7 (serviços separados) — Rodada 3 (#34, ponto 3)

## O que estava implementado

- `Fase_7` em `20aae4e` (ainda não mergeada na `main`: o PR #155 aguardava o merge do usuário). Código da #32 e da #33.
- O monólito virou o `gateway` (módulo `monolito`) e extraiu dois serviços, cada um com Dockerfile, imagem e container próprios:
  - `notification`: consumer idempotente do tópico `identity.notification`; manda o e-mail por SMTP.
  - `reservation`: `eventcap` (CAS) + `walletevent` (ES), schema `reservation`, event store e relay próprios, expiração e a
    projeção de disponibilidade do braço `naive`. API interna `/internal/**`, só na rede do compose, protegida por
    `X-Internal-Token`.
- O `gateway` chama o `reservation` por HTTP: braço `cas` em **1** chamada (CAS atômico no serviço); braço `naive` em
  **2** (disponibilidade e depois a reserva), com a janela check-then-act incluindo a rede.
- `catalog` e `identity` continuam no processo do `gateway`. `/bff/**` inalterado.

## Configuração

- Host: Ryzen 7 7700X, Ethernet 2,5 GbE (192.168.68.64), Docker com os dados em **SSD NVMe** (`fsync` ≈ 0,39 ms).
- Gerador: Ryzen 5 7600, Ethernet 1 Gbps (192.168.68.54), k6 v2.2.0, psql 16.15, plano Alto desempenho, portas dinâmicas
  TCP `start=10000 num=55535` nas escadas.
- `reservation`: Tomcat 300, Hikari 1000, virtual threads off. `gateway`: Hikari 350. `notification`: Hikari 3.
  Cliente HTTP `gateway → reservation`: pool de 400, evict de idle em 20 s, timeout de resposta de 10 s.
  Pool do Supavisor 245, `max_connections` 300, relay e consumer ligados.
- Banco **limpo antes de cada bloco** (`limpar-banco.sh`, local), inclusive o refino da escada.
- Baseline de rede (`baseline-20261024-131430.txt`, não versionado aqui; ver `04b-fase6-es-cabo/` para o do dia): HTTP p50 15,8 ms /
  p95 18,0 ms (cabo).

## Ressalvas

- **O PR #155 (`Fase_7` → `main`) não estava mergeado** quando a rodada rodou; o código medido é o da `Fase_7` (`20aae4e`), o
  mesmo que vai para a `main`.
- A rodada mudou **junto com a arquitetura**: o Hikari do monólito (1000 → 350), o pool HTTP de 400, o timeout de 10 s e o
  token interno. A queda ou o ganho não são atribuíveis só ao salto de rede.
- O X da escada tem resolução de 1k RPM e uma escada por configuração; o refino rodou sobre banco limpo, ao contrário do 04b.
- Os 5xx não puderam ser separados por origem (timeout do gateway × pool HTTP × `reservation`): não houve nenhum.
  `backend` e `reservation` terminaram a escada com 0 `WARN`/`ERROR` nos logs.
- O `docker stats --no-stream` não serviu como medida de CPU (valores de 1–3% sob carga, sem janela de amostragem); não
  é usado.
- O `netsh dynamicport` ficou ativo no gerador até o fim do dia (não revertido durante as rodadas).

## Blocos

| Bloco | Teste | Host | Resultado |
|---|---|---|---|
| 1 | matriz naive (N 100/200 × 10) | `naive` | oversell 80 (N=100, 10/10) e 180 (N=200, 9/10; 168 na rep 1) |
| 2 | matriz CAS (N 100/200 × 10) | `cas` | oversell **0** nas 20, 0 erros 5xx |
| 3 | escada grossa 40k–80k | `cas` | 50k limpo (243 ms); satura em 60k (1,78 s); acima, efetivo ~60–61k |
| 4 | refino 50k–58k (passo 1k) | `cas`, banco limpo | **X ≈ 58k RPM** (1,94 s); 51k–57k entre 260 e 482 ms |
| 5 | aleatório 45 min | `cas` | 0 erros, 0 descartes; reserva p95 6,6 ms |

## Arquivos

- `matriz-naive.csv`, `matriz-cas.csv`: 20 linhas cada (N ∈ \{100, 200\} × 10 repetições, capacity 20, `PCT_CONFIRMA=100`).
  Naive: p95 97–345 ms (N=100) e 189–274 ms (N=200); vazão 249–763 e 608–889 req/s. CAS: p95 106–176 ms e 156–205 ms;
  vazão 529–870 e 870–1183 req/s. `lag_obs_*` = -1 quase sempre (a projeção ficou mais rápida que o polling).
- `degraus-640677.csv`: escada grossa. 40k é o degrau de aquecimento (p95 de janela 897 ms, cauda da partida a frio).
  60k já satura (1.782 ms, 0 descartes); 70k e 80k travam o efetivo em ~60–61k RPM (~1000 req/s) com p95 ~2,35–2,4 s e
  9.187 / 20.196 descartes. 0 erros 5xx e 0 outros.
- `degraus-642947.csv`: refino 50k–58k. O 50k é aquecimento (1,66 s, partida a frio). De 51k a 57k a pior janela de
  30 s fica entre 260 e 482 ms; **58k é o primeiro degrau saturado** (1.944 ms, p99 2,27 s). 0 erros 5xx, 0 outros, 0 descartes.
- `resultados-aleatorio.csv`: `Ale-644172`, semente 617706, 1k–12k RPM, passo 30 s, 30% de leitura, 200 usuários,
  `PCT_CONFIRMA=100`. 146.400 aceitas (todas confirmadas), 48.614 lotado, 0 erros 5xx, 0 outros, 0 descartes. p50 / p95 /
  p99 (ms): reserva 4,8 / 6,6 / 9,3; confirma 3,1 / 4,5 / 6,9; busca 16,0 / 19,9 / 25,9; evento 2,4 / 3,7 / 6,2; carteira
  4,6 / 10,1 / 26,3; pior requisição 165,6 ms.
- `baseline-20261024-131430.txt`: latência base de rede do gerador no início da tarde (HTTP p50 15,8 / p95 18,0 ms, n = 30).
- `gerador/`: o que ficou só no gerador e entrou depois (2026-10-28):
  - `summary-degraus-640677.json`, `summary-degraus-642947.json`, `summary-ale-644172.json`: resumos do k6 da escada grossa, do
    refino e do aleatório.
  - `telemetria-gerador-degraus-640677.csv` e `-642947.csv`: CPU/RAM do gerador na grossa e no refino.
  - `telemetria-gerador-degraus-641371.csv`: escada de ~15 min entre a grossa e o refino que não gerou CSV (sem linha no
    resultado; só a telemetria ficou).
  - `telemetria-gerador-matriz-20261024-133949.csv` (20 s, execução interrompida), `-134234.csv` e `-134629.csv` (~2 min cada):
    telemetria das matrizes; o braço de cada arquivo não ficou registrado.

## Leitura

- **Overselling.** CAS: 0 em 20 de 20. Naive: no teto (80 / 180) em 19 de 20; na rep 1 de N=200 a projeção chegou a refletir
  parte da lotação (168). Mesmo resultado do ponto 2.
- **X ≈ 58k RPM**, contra ≈ 56k (ponto 2, Wi-Fi) e ≥ 60k (ponto 2 refeito no cabo, `04b-fase6-es-cabo`, refino inconclusivo). No
  cabo, o distribuído fica ~3% abaixo do teto do ponto 2; o teto de vazão (~61k req/min) é o mesmo.
- **Aleatório.** O p95 de cada operação ficou na faixa da #109 (pós-pooler, sem ES): reserva 6,6 ms (#109: 5,7), evento 3,7
  (3,4), carteira 10,1 (12,6), busca 19,9 (15,0). O ponto 2 (04, Wi-Fi) tinha 36,2 ms na reserva. Como o código do ponto 3 também
  grava no event store, isso indica que o aumento do p95 observado no ponto 2 vinha em boa parte do Wi-Fi, não do ES. A
  confirmação direta (aleatório do código do ponto 2 no cabo) não foi feita.

## Telemetria do host

`host-telemetria/telemetria-host-r3-*.csv`: CPU, frequência e RAM do host a cada 1 s (epoch em ms, UTC). `r3-matriz-naive-*`
cobre a 1ª tentativa e a rodada da matriz naive; `r3-escada-*`, a escada grossa e o início do refino; `r3-aleatorio-*` (2256 amostras, ~37 dos 45 min), o
aleatório. O refino 50k–58k e a matriz CAS rodaram em janelas sem arquivo próprio (a telemetria de 50–75 min não cobriu todos).
