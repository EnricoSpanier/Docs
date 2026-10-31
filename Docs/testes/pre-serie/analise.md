---
sidebar_label: "Análise dos Resultados"
sidebar_position: 11
---

# Análise dos resultados de carga (2026-10-04)

Consolida os dados desta pasta e de `../01-sem-pool/` (rodadas sem pool): `resultados*.csv`, `summary-*.json`, `perfil-ale-*.json`,
`verificacoes.log`, `sockstat.log` e `baseline-*.txt`. O registro cronológico e o passo a passo ficam em
`docs/carga/setup.md`; aqui está a leitura dos números e o que eles provam.

> **Ressalva (issue #14).** Os números pós-pool são de **monólito + HikariCP (pool e `max_connections` registrados)**: pool
> de 1000 conexões (padrão do backend) e `max_connections` na coluna de mesmo nome de `resultados-rpm.csv`. Os números
> **pré-pool** (rodadas com uma conexão TCP por operação, antes da #96: 5xx de ~31% a 10k RPM, 112.878 no aleatório, etc.)
> estão **invalidados**: ficam abaixo só como histórico do que mudou e não servem de base de comparação.

## 1. Setup

- 2 máquinas: **host** (stack Docker, alvo `:8081`) e **gerador** (k6 v2.2.0, Ryzen 5 7600, 1 Gbps).
- Latência base de rede (HTTP, n=30): p50 14,9 / p95 19,0 / máx 21,1 ms (a descontar das medições).
- Três testes: **Disputa** (N clientes × 1 evento, capacidade 20), **RPM** (10k reservas/min por 90 s,
  79 eventos × 100 vagas, 200 usuários) e **Aleatório** (45 min, 1k–12k RPM, 1464 eventos × 100 vagas,
  semente `617706`, 30% de leituras).
- Duas variantes de confirmação: 100% das aceitas confirmam (`PCT_CONFIRMA=100`) e **realista** (60%; as demais
  expiram em ~120 s e devolvem a vaga).
- Dois caminhos de reserva (flag `reservation.readpath`): **`cas`** (`UPDATE` condicional atômico em `eventcap`)
  e **`naive`** (lê o read model `event_availability`, defasado até 5 s, e grava sem CAS: braço de controle).

## 2. Conclusões

1. **O `cas` nunca oversella.** `eventos_com_overselling = 0` em todas as rodadas `cas`, antes e depois do pool,
   com e sem confirmação.
2. **O `naive` oversella quando há concentração de tentativas por evento dentro da janela de refresh**:
   disputa (30 / 80 / 180 além da capacidade) e RPM (6.985–7.347 reservas a mais, 75 de 79 eventos).
3. **Taxa total alta não basta para expor o `naive`**: no aleatório (tentativas espalhadas entre 1464 eventos)
   o overselling foi 0, mesmo a até 12k RPM.
4. **O gargalo de disponibilidade da manhã era a falta de pool de conexões**, não o CAS nem o `max_connections`.
   Com HikariCP: 5xx 112.878 → 0, reserva p95 153 → 4,4 ms (aleatório). Os números pré-pool (112.878, 153 ms) estão
   invalidados (#96).
5. **Confirmar vendas custa pouco**: 60% de confirmação não mudou latência nem vazão.

## 3. `cas`: pool de conexões (o que mudou entre manhã e tarde)

Antes do pool, `DriverManager` abria uma conexão TCP por operação. A série de `sockstat` medida na hora mostrou o efeito
(ela não foi versionada; o `sockstat.log` desta pasta só tem 5 amostras pós-pool, em repouso):
repouso ≈ 14 sockets em `TIME_WAIT`, **pico de 34.199** na carga, contra **28.232** portas efêmeras
(`32768–60999`, destino fixo `db:5432`) → `BindException: Cannot assign requested address`. Subir
`max_connections` de 300 para 1000 não alterou o 5xx (o Postgres tinha ~16 conexões ativas).

| Teste | Antes (sem pool; **invalidado**, #96) | Depois (HikariCP, pool 1000) |
|---|---|---|
| Disputa, p95 (50 / 100 / 200 clientes) | 284 / 419 / 670 ms (1ª bateria) | 103 / 64 / 90 ms |
| Disputa, respostas "outros" | 0 / 13 / 105 | 0 / 0 / 0 |
| RPM 10k, 5xx | 4.718 (~31%) | 0 |
| RPM 10k, p95 | 45 ms | 4,2 ms |
| Aleatório, 5xx | 112.878 | 0 |
| Aleatório, descartadas / VUs máx. | 1.735 / 500 | 0 / 100 |
| Aleatório, reserva p95 / p99 | 153 / 880 ms | 4,4 / 8,9 ms |
| Aleatório, latência máxima | 23,2 s | 563 ms |

Ressalva: manhã e tarde não são perfeitamente comparáveis (o banco foi recriado entre as baterias), mas a
diferença é grande demais para ser explicada por isso.

## 4. `cas` com vendas finalizadas

| Rodada | Aceitas | Confirmadas | 5xx | Reserva p95 | Confirma p95 |
|---|---|---|---|---|---|
| Disputa 100% (eventos 1626–1628) | 20 em cada | 20 em cada | 0 | 45 / 53 / 63 ms | 26 / 34 / 50 ms |
| `Rpm-917602` (100%) | 7.501 | 7.501 | 0 | 4,1 ms | 3,9 ms |
| `Rpm-918245` (60%) | 7.500 | 4.450 (59,3%) | 0 | 4,1 ms | 4,2 ms |
| `Ale-919068` (60%) | 194.989 | 116.744 (59,9%) | 0 | 4,6 ms | 3,7 ms |

- Aceitas acima da capacidade no aleatório (194.989 > 146.400) **não é overselling**: `expired` devolve a vaga e
  ela é revendida. A invariante é `pending + confirmed ≤ capacidade`, e as `confirmed` (116.744) ficam abaixo.
- A aceita nº 7.501 no RPM é a iteração extra do k6 (15.001), que cai no 76º evento ainda com vagas.
- Comparação com a `Ale-913561` (mesma semente, antes da etapa de confirmação): reserva p95 4,4 → 4,6 ms; leitura
  p95 456 → 464 ms.

## 5. Braço `naive` vs `cas`

### 5.1 Overselling no banco

| Teste | `cas` | `naive` (100% confirma) | `naive` (60% confirma) |
|---|---|---|---|
| Disputa 50 clientes | 0 | **30** | **30** |
| Disputa 100 clientes | 0 | **80** | **80** |
| Disputa 200 clientes | 0 | **180** | **180** |
| RPM 10k (79 eventos) | 0 | **7.347** (75 eventos) | **6.985** (75 eventos) |
| Aleatório (1464 eventos) | 0 | 0 | 0 |

Eventos da disputa `naive`: 4718–4720 (100%) e 4721–4723 (60%). Rodadas: `Rpm-924492`, `Rpm-924628`,
`Ale-924767`, `Ale-927639`.

### 5.2 O que o k6 respondeu (`naive`)

| Rodada | Aceitas | `lotado` | Reserva p95 | Confirma p95 |
|---|---|---|---|---|
| Disputa 50 / 100 / 200 (100%) | 50 / 100 / 200 | 0 / 0 / 0 | 80 / 85 / 175 ms | 29 / 51 / 129 ms |
| Disputa 50 / 100 / 200 (60%) | 50 / 100 / 200 | 0 / 0 / 0 | 25 / 44 / 68 ms | 17 / 22 / 48 ms |
| `Rpm-924492` | 14.847 | 153 | 4,2 ms | 3,5 ms |
| `Rpm-924628` | 14.812 | 188 | 3,6 ms | 3,1 ms |
| `Ale-924767` | 146.400 | 48.610 | 4,8 ms | 4,6 ms |
| `Ale-927639` | 194.996 | 11 | 4,5 ms | 4,6 ms |

Todas com 0 5xx e 0 iterações descartadas.

### 5.3 Por que cada resultado saiu assim

Interpretações pela leitura do código (`EventWalletService.addLink`, `ReadModelRefreshService`) e do padrão de
carga; **não foram medidas diretamente**.

- **Mecanismo:** o `naive` lê `event_availability` (recalculada a cada 5 s) e insere em `walletevent` sem tocar
  `eventcap`. A checagem "tem vaga?" enxerga um número velho. Por isso `eventcap.quant` fica em 20 mesmo com
  50–200 reservas ativas na disputa.
- **Disputa:** a rajada dura menos de ~3 s, menos que um refresh. O read model mostra 20 vagas durante toda a rajada,
  então todos são aceitos: overselling = clientes − 20, com 0 "lotado".
- **RPM:** os pares são gerados em sequência (usuário `i % 200`, evento `i / 200`), então cada evento recebe suas
  ~200 tentativas em ~1,2 s. Os 75 eventos atingidos por completo aceitam ~200 para 100 vagas (≈ +100 cada); os
  4 restantes só receberam o fim da rodada e ficaram dentro da capacidade. As 153 e 188 recusas "lotado" são
  tentativas que chegaram depois de um refresh ter visto o evento cheio.
- **Aleatório:** uma permutação dos pares espalha as tentativas entre os eventos (cada um recebe uma a cada
  ~10–20 s no pico, mais espaçado nas fases lentas), mais que o refresh de 5 s. Antes da próxima tentativa o read
  model já mostra o evento cheio. Na `Ale-924767` os 1464 eventos lotaram exatamente (146.400 aceitas, 48.610
  "lotado"). Na `Ale-927639`, só ~60% das aceitas confirmam e as demais expiram, devolvendo a vaga: a ocupação
  fica abaixo da capacidade (ativas 118.018 &lt; 146.400) e só 11 respostas "lotado".
- **Confirmar não protege:** `confirm` só faz `pending → confirmed`, sem checar capacidade. No evento 4720 houve 200
  `confirmed` para 20 vagas, ou seja, ingressos efetivamente vendidos a mais.
- **60% vs 100%:** o overselling é praticamente o mesmo (6.985 vs 7.347); a causa (checagem sem CAS) não muda com
  a confirmação.

## 6. Achados em aberto e limites

1. **O overselling do `naive` depende da concentração por evento, não da taxa total.** O aleatório espalhado não
   discrimina `cas` de `naive`. Para forçar isso, seria preciso concentrar tentativas (ex.: "evento quente"); o
   script atual não faz.
2. **Uma rodada por configuração.** O README pede repetir e reportar média e dispersão (o `naive` depende do ponto
   do ciclo de refresh em que a rajada cai). A disputa foi determinística (todas aceitas), mas isso não está
   demonstrado para outros intervalos de refresh.
3. **Leitura bimodal** (p50 ~2 ms, p95 ~460–475 ms) em todas as rodadas pós-pool, `cas` e `naive`: não vem do pool nem
   da confirmação. Suspeita (não medida por endpoint): `GET /bff/events/search` varre eventos em memória.
4. **Latência da disputa `naive` maior que a `cas`** (p95 80/85/175 ms contra 45/53/63 ms): rodada única; o `naive`
   aceita e confirma todos, então não tratar como diferença estrutural sem repetir.
5. **`sockstat` pós-pool não cobre a carga**: o `sockstat.log` da tarde tem poucas linhas, em repouso. O proxy do
   "sem esgotamento de portas" é 0 `BindException` e 0 5xx.
6. **Disputa realista confirma abaixo de 60%** (40–45%): o sorteio usa semente fixa sobre os primeiros
   50/100/200 índices. Não afeta a corretude; melhoria pendente: semente por rodada.
7. **Tamanho do pool não explorado**: com 100 VUs e latências de poucos ms o pool nunca chegou perto de 1000. O
   padrão 1000 só é seguro com `max_connections` alto (o compose padrão usa 100).
8. **Série de 3 pontos do experimento:** estes números são "monólito + HikariCP", **não** o ponto 1 definitivo
   (refeito após o Supavisor, Fase 4; ver "Ponto da série" no `CONTEXT.md`). Repetir nos marcos de microsserviços e
   CQRS+ES.
