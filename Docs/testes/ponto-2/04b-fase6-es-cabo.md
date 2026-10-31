# Etapa 04b: ponto 2 refeito no cabo (controle da Rodada 3)

Repete o protocolo reduzido do ponto 2 (etapa 04, Fase 6 CQRS + ES, Rodada 2 / #31) com o **mesmo código** e na
**rede cabeada**, para a Rodada 3 (ponto 3) ser comparada com o ponto 2 na mesma rede. A etapa 04 (Wi-Fi) fica como
registro do ponto 2.

## O que rodou

- Código do ponto 2: `main` em `1ee6fbe` (merge do PR #145) + #146 (imagem local `gerenciador-eventos-backend:146`),
  em worktree separado e projeto compose `ponto2` (volumes novos, schema antigo em `public`).
- Host: Ryzen 7 7700X, Ethernet 2,5 GbE (192.168.68.64); gerador: Ryzen 5 7600, Ethernet 1 Gbps (192.168.68.54).
- Configuração: Tomcat 300, Hikari 1000, pool do Supavisor 245, `max_connections` 300, relay e consumer ligados.
- Baseline de rede (`baseline-20261024-092806.txt`): HTTP p50 14,4 ms / p95 15,8 ms (n = 30), contra 26,6 / 42,9 ms no
  Wi-Fi (etapa 04) e ~14,9 / 19 ms no cabo das rodadas anteriores.

## Ressalva: disco do Docker

A 1ª tentativa (matriz e escada) rodou com os dados do Docker em **HDD** (`fsync` ≈ 30 ms por `fdatasync`, medido
com `pg_test_fsync`): o `UPDATE eventcap` (linha quente) segurava o lock até o commit e a escada travou em ~90 req/s
(p50 ≈ 28 s). Os dados do Docker foram movidos para SSD NVMe (`fsync` ≈ 0,39 ms) e a matriz e a escada foram
**refeitas**. Os resultados do HDD ficam só como registro de causa e não entram na comparação:
`matriz-naive-disco-lento.csv` e `disco-lento/degraus-620992.csv` (a escada do HDD, descartada; versionada só como registro).

## Blocos

| Bloco | Teste | Host | Banco | Resultado |
|---|---|---|---|---|
| 1 | matriz naive (N 100/200 × 5) | `naive`, consumer ligado | novo | oversell 80 / 180 (teto) em todas as repetições |
| 2 | escada grossa 40k–120k (passo 10k) | `cas`, consumer ligado | novo | 60k limpo (p95 de janela 489 ms); satura em 70k |
| 3 | refino 60k–70k (passo 1k) | `cas`, consumer ligado | sujo (após a grossa) | nenhum degrau abaixo de 1 s; ver leitura |

## Arquivos

- `matriz-naive.csv`: 10 linhas (N ∈ \{100, 200\} × 5 rep, capacity 20, `PCT_CONFIRMA=100`). Oversell 80 em N=100 e 180 em
  N=200 em todas as repetições, 0 erros 5xx. p95 87,5–186,7 ms (N=100) e 127,2–185,7 ms (N=200); vazão 485–943 req/s
  e 913–1227 req/s. `lag_obs_max` = -1 (sem amostra) em 9 de 10 linhas: a projeção ficou mais rápida que o polling de
  250 ms. No Wi-Fi (etapa 04) o oversell também foi 80 / 180.
- `degraus-626086.csv`: escada grossa. Efetivo = alvo até 60k; 70k já com p95 de janela 2.292 ms e 8.093 descartes; de
  70k a 120k o efetivo trava em ~60–62k RPM (~1000–1032 req/s) com p95 de janela 2,3–2,4 s. 0 erros 5xx, 0 outros. O k6
  chegou ao teto de 3000 VUs em 6 degraus (MAX_VUS também limita e pode mascarar parte da saturação).
- `degraus-627312.csv`: refino 60k–70k, passo 1k, sobre o banco que a grossa deixou. O 1º degrau (60k) é aquecimento.
- `baseline-20261024-092806.txt`: latência base de rede do gerador.
- `matriz-naive-disco-lento.csv`: matriz da 1ª tentativa (HDD), só registro.
- `summary-degraus-626086.json`, `summary-degraus-627312.json`: resumos do k6 da grossa e do refino (entraram em 2026-10-28).
- `disco-lento/degraus-620992.csv` e `summary-degraus-620992.json`: a escada da 1ª tentativa, com o Docker em HDD. Entrou em
  2026-10-28 só como registro de causa; descartada, não entra na comparação.

## Leitura

- **Teto de vazão no cabo ≈ 61k reservas/min** (~1000–1030 req/s), contra X ≈ 56k no Wi-Fi (etapa 04). Overselling do
  braço `cas`: não medido aqui (escada, sem verificação); da matriz CAS, ver etapa 04.
- **X não fecha pelo critério do refino.** No refino, nenhum degrau ficou abaixo de 1 s de p95 de janela, nem o de
  aquecimento (60k, que na grossa deu 489 ms). O menor foi 62k (1.261 ms, 0 descartes); de 63k em diante há descartes
  (1.187–7.835) e o colapso vem em 70k (efetivo 42k). O refino rodou sobre o mesmo volume da grossa (como no ponto 2),
  então o **banco sujo** é a hipótese para o refino pior que a grossa; não foi isolada. Pela grossa (banco novo),
  **X ≥ 60k** (último degrau limpo), e o joelho está entre 60k e 70k.
- Comparação com o ponto 2 (etapa 04, X ≈ 56k): o cabo + SSD dão um teto ~9% maior, **não separado** entre rede, disco e
  estado do banco (o ponto 2 também refinou sobre banco acumulado).

## Pendente

- Refino sobre banco limpo (separa o estado do banco do joelho).
- Matriz CAS no cabo (o overselling 0 do braço `cas`).
