# Etapa 06: Batch 1, configuração final distribuída — Rodada R

## O que estava implementado

- `Batch_1` em `b072346` (ainda não mergeada na `main`). Fase 7 completa: o monólito virou só o `gateway`, e
  `notification` (#32), `reservation` (#33), `catalog` (#35) e `identity` (#36) são serviços, cada um com Dockerfile, imagem,
  container e schema próprios, event store e relay próprios onde há ES. O `gateway` chama `reservation`, `catalog` e `identity`
  por HTTP interno (`/internal/**`, `X-Internal-Token`) e valida o JWT RS256 sem estado pelo JWKS do `identity` (claim `uid`).
- Compose final da #37 (healthchecks, `notification-seek`) e harness definitivo da #38 (`coleta-host.sh`, mapeamento
  `sequencial`/`intercalado` da escada).
- Contrato da #57 (reserva amarrada ao token) e esquema da #58 (`timestamptz`, `idx_walletevent_event_id`).

## Configuração

- Host: Ryzen 7 7700X, Ethernet 2,5 GbE onboard (192.168.68.64, rede Privada), Docker com os dados em **SSD NVMe**
  (`pg_test_fsync` fdatasync 0,43 ms, medido no meio da rodada).
- Gerador: Ryzen 5 7600, Ethernet 1 Gbps (192.168.68.54), k6 v2.2.0, psql 16.15, plano Alto desempenho, portas dinâmicas
  TCP `start=10000 num=55535`.
- Stack com `docker-compose.carga.yml` + `rpm/docker-compose.rpm.yml`: `max_connections` 300, pool do Supavisor 245, relay e
  consumer ligados. `reservation`: Tomcat 300, Hikari 1000. `gateway`: Hikari 10 (não usa JDBC desde a #36). `identity` e
  `catalog`: Hikari 100. `notification`: Hikari 3.
- Banco **limpo antes de cada bloco** (`limpar-banco.sh`, local: `TRUNCATE` em `public`, `reservation`, `catalog` e
  `identity`, chave do JWT apagada e backend religado), `RESERVATION_READPATH` conferido por `printenv` antes de cada bloco.
- Baseline de rede (`baseline-20261028-000236.txt`): HTTP p50 13,9 ms / p95 15,6 ms / máx 17,8 ms (n=30); o host não responde
  ICMP.

## Ressalvas

- **A `Batch_1` não estava mergeada na `main`** quando a rodada rodou; o código medido é o de `b072346`.
- **A escada grossa sequencial (`degraus-931618`) começou a frio em 40k** e entrou em colapso já no 1º degrau; os degraus de
  cima herdaram o host atolado. Os refinos com aquecimento (`degraus-936649` e `degraus-938039`) a substituem; ela fica
  registrada como medida.
- O degrau de aquecimento de cada refino estoura a cauda (p95 de janela 1,4–2,1 s) por partida a frio. O `report-degraus`
  marca o X nele; a leitura abaixo o descarta.
- A comparação com a etapa 05 é entre códigos diferentes: entre `20aae4e` e `b072346` saíram o `catalog` (#35) e o
  `identity` (#36) do processo do `gateway`, e mudou o contrato da reserva (#57).
- Diagnóstico `Rpm-932720` (taxa fixa 40k, 110 s, vários eventos): efetivo 37.276, reserva p50 / p95 / p99 405 / 933 /
  1.153 ms, 0 5xx; o k6 do `test-rpm` bateu no teto de 500 VUs (3.386 descartes). Serviu para localizar a contenção da escada
  a frio (abaixo), não como medida de X.

## Blocos

| Bloco | Teste | Host | Resultado |
|---|---|---|---|
| 1 | matriz CAS (N 100/200 × 10) | `cas` | oversell **0** nas 20, 0 erros 5xx |
| 2 | matriz naive (N 100/200 × 10) | `naive` | oversell no teto: 80 (N=100, 10/10) e 180 (N=200, 10/10) |
| 3 | escada grossa sequencial 40k–80k, a frio | `cas` | colapso desde 40k (efetivo 39–44k, p95 de janela 3,3–3,9 s) |
| — | diagnóstico 40k (`test-rpm`) | `cas` | contenção na linha do `eventcap` (abaixo) |
| 4 | escada grossa intercalada 40k–120k | `cas` | 60k limpo (303 ms); 80k e acima, efetivo 62–86k com p50 > 1 s |
| 5 | refino intercalado 58k–76k | `cas` | 60k–76k limpos (p95 de janela 14–56 ms) |
| 5b | refino intercalado 74k–92k | `cas` | 76k–84k limpos; **86k 1º degradado** (1,12 s); 88k+ efetivo ~80–82k |
| 6 | refino sequencial 18k–40k | `cas` | todos limpos (p95 de janela 6 → 160 ms) |
| 6b | refino sequencial 38k–60k | `cas` | 40k–54k limpos (169 → 357 ms); **56k 1º degradado** (1,67 s); 58k+ colapso ~42k |
| 7 | aleatório 45 min | `cas` | 0 erros, 0 descartes, oversell 0; reserva p95 6,7 ms |

## Arquivos

- `matriz-cas.csv`, `matriz-naive.csv`: 20 linhas cada (N ∈ \{100, 200\} × 10 repetições, capacity 20, `PCT_CONFIRMA=100`).
  CAS: p95 104–200 ms (N=100) e 141–329 ms (N=200); vazão 457–877 e 556–1124 req/s. Naive: p95 109–291 e 172–297 ms; vazão
  286–662 e 528–913 req/s. `lag_obs_max` lido em poucas linhas (máx 79–158 ms); nas outras a projeção foi mais rápida que o
  polling de 250 ms. Overselling do CAS conferido também no banco do host (0 evento acima da capacidade).
- `degraus-931618.csv`: escada grossa sequencial (a frio, ver Ressalvas).
- `degraus-932968.csv`: escada grossa intercalada. 40k é aquecimento (p50 19 ms, p95 de janela 2,1 s); 60k limpo; 80k, 100k e
  120k com efetivo 61,8k / 85,6k / 61,6k e 18–58k descartes.
- `degraus-933734.csv`, `degraus-935110.csv`: refino intercalado. Último degrau limpo **84k** (p95 de janela 62 ms); 86k
  degrada (efetivo 85.700, p95 de janela 1.120 ms, p50 228 ms, 301 descartes); 88k–92k travam em ~80–82k.
- `degraus-936649.csv`, `degraus-938039.csv`: refino sequencial. Último degrau limpo **54k** (p95 de janela 357 ms, p50
  165 ms); 56k degrada (1.669 ms, sem descarte); 58k e 60k colapsam em ~42k efetivos (p50 ~3,1 s, 15,6k e 18,0k descartes).
- `resultados-rpm.csv`: o diagnóstico `Rpm-932720`.
- `resultados-aleatorio.csv`: `Ale-939580`, semente 617706 (a da etapa 05), 1k–12k RPM, passo 30 s, 30% de leitura, 200
  usuários × 1.464 eventos, `PCT_CONFIRMA=100`. 146.400 aceitas (todas confirmadas, conferido no host: 0 overselling), 48.615
  lotado, 83.706 leituras, 0 erros 5xx, 0 outros, 0 descartes. p50 / p95 / p99 (ms): reserva 4,7 / 6,7 / 8,0; confirma
  3,1 / 5,5 / 8,1; leitura 3,9 / 27,5 / 32,2 (p95 por endpoint: evento 5, carteira 8, busca 32); pior requisição 182,3 ms.
- `gerador/`: `summary-*.json` e `perfil-ale-939580.json` do k6 e a telemetria do gerador (`telemetria-gerador-*.csv`).
- `host-telemetria/`: `telemetria-host-r-*.csv` (CPU, frequência e RAM do host a cada 1 s), `coleta-host-r-*.csv` (lag da
  projeção e dos consumers, outbox por serviço, conexões do Postgres) e `pgss-r-*.csv` (`pg_stat_statements` da janela), um
  conjunto por bloco; `verificacoes-aleatorio.log` é o `verificar-rpm` do aleatório.

## Leitura

- **Overselling.** CAS: 0 em 20 de 20 na matriz e 0 no aleatório. Naive: no teto (80 / 180) em 20 de 20. Mesmo resultado dos
  pontos 2 e 3.
- **X sequencial ≈ 56k RPM** (evento disputado: `U` reservas seguidas no mesmo evento), contra ≈ 58k na etapa 05, que usava o
  mesmo padrão de disputa antes de a coluna `mapeamento` existir. O limite é a linha quente do `eventcap`. O `pg_stat_statements` acumulado
  desde o início da coleta da escada sequencial até o fim do diagnóstico (escada a frio + `Rpm-932720`) deu média de 344 ms
  no `UPDATE` do CAS, e durante o diagnóstico `Rpm-932720` havia 186 sessões esperando lock de transação e as 300 threads do
  Tomcat do `reservation` esperando o banco (snapshot e thread dumps ao vivo, fora dos CSVs). Depois do joelho, a vazão **cai** para ~42k (colapso por fila), não fica no teto.
- **X intercalado ≈ 86k RPM** (a carga se espalha pelos eventos: capacidade do host sem a linha quente). Depois do joelho, o
  efetivo se segura em ~80–82k. A linha quente custa ~35% do teto.
- **Aleatório.** Reserva e confirmação praticamente iguais às da etapa 05 (p95 6,7 contra 6,6 ms; 5,5 contra 4,5 ms). A leitura
  subiu (busca p95 32 contra 19,9 ms), compatível com o salto a mais `gateway → catalog → reservation` e o `identity` separado.
