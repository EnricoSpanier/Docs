---
sidebar_label: "Resultados de Carga"
sidebar_position: 10
---


# Resultados dos testes de carga (2026-10-04)

> **Atualização (2026-10-26):** esta nota cobre só as baterias de 2026-10-04 (monólito, antes do pooler). As rodadas posteriores — matriz e escada X pós-pooler, ponto 2 (CQRS + ES) e ponto 3 (distribuído, X ≈ 58k) — estão em `Projeto/carga/results/03-supabase-pooler`, `04-fase6-es`, `04b-fase6-es-cabo` e `05-distribuido` e em `docs/artigo/experimento-monolito.md`. Estado geral em [Validacao-e-Pendencias-2026-10-26](../../decisoes-arquitetura/Validacao-e-Pendencias-2026-10-26.md).

Dados de `Projeto/carga/results/` (resumos k6 `summary-*.json`, CSVs `resultados*.csv`,
`verificacoes.log`, `sockstat.log`, `baseline-*.txt`) consolidados. Baterias rodadas no **monólito
atual** (caminho `cas`, refresh 5000 ms) — são o ponto de partida da série de 3 pontos do
experimento ([Roadmap-e-Issues](../../decisoes-arquitetura/Roadmap-e-Issues.md), issues #4, #11, #96). Corretude do CAS: [Implementacao-EventCap-e-Reserva-CAS](../../decisoes-arquitetura/Implementacao-EventCap-e-Reserva-CAS.md).

:::info cas × naive
Os dois são **caminhos de reserva** (`RESERVATION_READPATH`) comparados no experimento do TCC, com a mesma carga, o mesmo host e o mesmo pool de conexões:

- **`cas`** (compare-and-set): a vaga é reservada por um `UPDATE` condicional atômico em `eventcap` (só decrementa se ainda houver vaga). É a implementação correta: **nunca vende além da capacidade** (overselling = 0).
- **`naive`**: braço de controle, de propósito ingênuo. Checa "tem vaga?" em `event_availability` (read model recalculado a cada 5 s, logo um número velho) e insere em `walletevent` **sem tocar `eventcap`**. Quando muitas tentativas chegam ao mesmo evento dentro da janela de 5 s (Disputa e RPM), todas passam na checagem e **vende além da capacidade** (overselling > 0). No Aleatório, onde as tentativas se espalham entre 1464 eventos, o overselling foi 0.

Cada seção abaixo se chama `Tipo de teste - braço`: **Disputa** (N clientes × 1 evento), **RPM** (taxa fixa de reservas/min) ou **Aleatório** (45 min de carga variável).
:::

## Fase 1

### Setup

- 2 máquinas: **host** (stack Docker, alvo `:8081`) e **gerador** (k6 v2.2.0, Ryzen 5 7600, 1 Gbps). O k6 nunca roda no host.
- Latência base de rede (gerador → host, HTTP, n=30): **p50 14,9 ms / p95 19,0 ms / máx 21,1 ms** (ICMP bloqueado; descontar das medições).
- 3 testes: **Disputa** (N clientes × 1 evento, capacidade 20), **RPM** (taxa fixa, 10k reservas/min, 90 s, 79 eventos × 100 vagas, 200 usuários), **Aleatório** (45 min, 1k–12k RPM, 1464 eventos × 100 vagas, semente `617706`, 30% leitura).

### Linha do tempo (4 baterias)

| Bateria | Backend | Observação |
|---|---|---|
| Manhã (12h–14h) | sem pool (`DriverManager`, 1 conexão TCP por operação) | saturação de portas efêmeras; `max_connections` 300→1000 não ajudou |
| Tarde (15h–16h) | HikariCP, pool 1000 (`275d587`, issue #96) | 0 5xx, 0 `BindException` |
| Noite 1 (16h40–17h) | pool + `confirm` em 100% das aceitas (PR #99/#100) | vendas finalizadas |
| Noite 2 (17h–18h) | pool + `confirm` em 60% (realista) | confirmadas ≠ expiradas |

### Disputa - cas

*capacidade 20*

| Bateria | Clientes | Aceitas | Lotado | Outros | p50 / p95 | Vazão |
|---|---|---|---|---|---|---|
| Manhã (sem pool) | 50 | 20 | 30 | 0 | 271 / 284 ms | 58/s |
| | 100 | 20 | 67 | 13 | 389 / 419 ms | 65/s |
| | 200 | 20 | 75 | 105 | 530 / 670 ms | 69/s |
| Tarde (pool) | 50 | 20 | 30 | 0 | 96 / 103 ms | 80/s |
| | 100 | 20 | 80 | 0 | 41 / 64 ms | 90/s |
| | 200 | 20 | 180 | 0 | 74 / 90 ms | 95/s |
| Noite, 100% confirma | 50 / 100 / 200 | 20 | 30 / 80 / 180 | 0 | p95 45 / 53 / 63 ms | 94 / 99 / 101/s |
| Noite, 60% confirma | 50 / 100 / 200 | 20 | 30 / 80 / 180 | 0 | p95 42 / 44 / 48 ms | 94 / 99 / 101/s |

Confirmação (100%): p95 26 / 34 / 50 ms. Realista: confirmaram 9 / 9 / 8 (45 / 45 / 40%, abaixo dos
60% por amostra pequena + semente fixa — melhoria pendente: semente por rodada). **Overselling 0 em todas.**

### RPM - cas

*10k/min, 90 s*

| Rodada | Config | RPM real | Aceitas | Lotado | 5xx | p50 / p95 / p99 | Overselling |
|---|---|---|---|---|---|---|---|
| `Rpm-903185` (2k RPM, 60 s) | sem pool, mc 300 | 1930 | 1000 | 1000 | 0 | 27 / 32 / 40 ms | 0 |
| `Rpm-903506` | sem pool, mc 300 | 9761 | 5379 | 4903 | **4718** | 28,5 / 45,6 / 52 ms | 0 |
| `Rpm-904217` | sem pool, mc 300 | 9764 | 5375 | 4907 | **4718** | 29 / 44,5 / 52 ms | 0 |
| `Rpm-909189` | sem pool, mc 1000 | 9644 | 2917 | 2697 | **4387** | 27,5 / 65 / 157 ms | 0 |
| `Rpm-909317` | sem pool, mc 1000 | 9643 | 2850 | 2587 | **4563** | 26,6 / 50 / 74 ms | 0 |
| `Rpm-913181` | **pool** | 9786 | 7501 | 7500 | **0** | 2,7 / 4,7 / 13,2 ms | 0 |
| `Rpm-913395` | pool | 9792 | 7500 | 7500 | **0** | 2,5 / 4,2 / 11,9 ms | 0 |
| `Rpm-917602` | pool, 100% confirma | 9792 | 7501 | 7500 | 0 | 2,6 / 4,1 / 13,2 ms | 0 |
| `Rpm-918245` | pool, 60% confirma | 9792 | 7500 | 7500 | 0 | 2,4 / 4,1 / 12,9 ms | 0 |

Confirmação: p95 3,9 ms (100%) e 4,2 ms (60%); 7501 e 4450 (59,3%) confirmadas. A aceita nº 7501 não
é overselling: o k6 faz 15.001 iterações (1 a mais que o planejado) e a extra cai no 76º evento, ainda com vagas.

### Aleatório - cas

*45 min, semente 617706*

| Métrica | `Ale-904991` (sem pool) | `Ale-913561` (pool) | `Ale-919068` (pool + 60% confirma) |
|---|---|---|---|
| RPM médio / pico alvo | 6150 / 11.926 | 6189 / 11.926 | 6189 / 11.926 |
| Reservas aceitas | 81.109 | 195.005 | 194.989 |
| Reservas 5xx | **112.878** | 0 | 0 |
| Leituras ok / 5xx / outras | 28.693 / 0 / 54.306 | 83.716 / 0 / 0 | 83.718 / 0 / 0 |
| Iterações descartadas / VUs máx. | 1735 / 500 | 0 / 100 | 0 / 100 |
| Reserva p50 / p95 / p99 | 6,2 / 153 / 880 ms | 3,1 / 4,4 / 8,9 ms | 3,1 / 4,6 / 10,3 ms |
| Leitura p50 / p95 / p99 | 6,4 / 770 / 4393 ms | 1,9 / 456 / 492 ms | 1,9 / 464 / 501 ms |
| Latência máxima | 23,2 s | 563 ms | 604 ms |
| `lotado` | 0 | 0 | 14 |
| Confirmadas | n/a | n/a | 116.744 (59,9%); p95 confirma 3,7 ms |
| `BindException` no log | 110.407 | 0 | 0 |

Aceitas > 146.400 vagas (1464 × 100) não é overselling: `pending` expira (~120 s) e a vaga é
revendida. Na `Ale-919068`: 116.744 `confirmed` (definitivas, &lt; 146.400) + 78.245 `expired`, 0 `pending`.

### Disputa - naive

| Teste | Rodada | Variante | Ativas | Capacidade | Overselling | Status no banco |
|---|---|---|---|---|---|---|
| Disputa 50 | evento 4718 | 100% confirma | 50 | 20 | **30** | 50 `confirmed` |
| Disputa 100 | evento 4719 | 100% confirma | 100 | 20 | **80** | 100 `confirmed` |
| Disputa 200 | evento 4720 | 100% confirma | 200 | 20 | **180** | 200 `confirmed` |
| Disputa 50 | evento 4721 | 60% confirma | 50 | 20 | **30** | 19 `confirmed` + 31 `pending` |
| Disputa 100 | evento 4722 | 60% confirma | 100 | 20 | **80** | 52 `confirmed` + 48 `pending` |
| Disputa 200 | evento 4723 | 60% confirma | 200 | 20 | **180** | 106 `confirmed` + 94 `pending` |

### RPM - naive

| Teste | Rodada | Variante | Ativas | Capacidade | Overselling | Status no banco |
|---|---|---|---|---|---|---|
| RPM 10k, 90 s | `Rpm-924492` | 100% confirma | 14.847 | 7.900 | **7.347** (75 de 79 eventos) | 14.847 `confirmed` |
| RPM 10k, 90 s | `Rpm-924628` | 60% confirma | 14.485 | 7.900 | **6.985** (75 de 79 eventos) | 8.851 `confirmed` + 5.634 `pending` + 327 `expired` |

### Análise do braço `naive`

Mesmo host, mesmo pool Hikari (1000), `max_connections=1000`, refresh do read model 5000 ms; só
`RESERVATION_READPATH=naive`. Overselling conferido no banco (`verificacoes.log`) e resumos do k6
(latência, RPM real, 5xx) vindos do PR #102.

#### Resultado: era o esperado? **Disputa e RPM: sim (overselling > 0, `cas` = 0 com a mesma carga). Aleatório: não (0), ver abaixo**

Capacidade 20 por evento na disputa, 100 por evento no RPM.


Contraste com o `cas` (mesma carga): disputa aceitou 20 de N com 0 overselling; RPM aceitou ~7.500 de
15.001 (`Rpm-918245`/`917602`) com 0 eventos em overselling.

**Por que era esperado.** O `naive` é o braço de controle da hipótese do TCC, não um bug
(`EventWalletService.addLink`): lê `event_availability`, que só é recalculada pelo job
`ReadModelRefreshService` a cada 5 s, e insere em `walletevent` **sem tocar `eventcap`**, ou seja, sem o
`UPDATE` condicional atômico. A checagem "tem vaga?" vê um número velho.

**Por que o overselling saiu tão grande (explicação por leitura do código e do padrão de carga — não
medida diretamente):**

1. **Disputa:** a rajada inteira dura menos de ~3 s (0,5–2 s nas rodadas `cas`), menos que o refresh de 5 s.
   Durante toda a rajada o read model continua mostrando 20 vagas, então **todos** os N clientes passam
   no `disp > 0` e são aceitos: overselling = N − 20 exatamente (30 / 80 / 180). Ninguém recebe "lotado".
2. **`eventcap` fica intacto:** `vagas_restantes = 20` com 50–200 reservas ativas, porque o `naive` nunca
   decrementa. O contador "oficial" de estoque deixa de refletir a realidade.
3. **RPM:** o k6 gera pares em sequência (usuário `i % 200`, evento `i / 200`), então cada evento recebe
   suas ~200 tentativas em ~1,2 s seguidas (≈160 reservas/s), de novo dentro de um refresh. Cada um dos
   75 eventos completamente atingidos aceita ~200 para 100 vagas (≈ +100 cada, 75 × 100 ≈ 7.500, observado
   7.347/6.985). Os 4 eventos restantes (79 − 75) só receberam as últimas tentativas do fim da rodada e
   ficaram dentro da capacidade. Por isso 75 e não 79 eventos.
4. **Confirmação não protege:** `confirm` só faz `pending → confirmed`, sem checar capacidade. No 4720
   foram 200 `confirmed` para 20 vagas — ingressos efetivamente vendidos a mais.
5. **60% vs 100% confirma:** o overselling é praticamente o mesmo (7.347 vs 6.985); a diferença vem de
   reservas `pending` que ainda não tinham expirado e de ~330 `expired` quando a verificação rodou. A
   confirmação não altera a causa (checagem sem CAS).

**Ressalvas.** Uma rodada por configuração (o resultado da disputa é determinístico: todas aceitas, mas o
README manda repetir e reportar média/dispersão porque depende do ponto do ciclo do refresh em que a rajada
cai); banco não foi zerado entre as baterias.

#### Lado do cliente (k6, PR #102)

O k6 confirma o banco e acrescenta o que o `naive` respondeu. Em todas: 0 5xx, 0 descartadas, 0 "outros".

| Rodada | Aceitas | `lotado` | Reserva p95 | Confirma p95 |
|---|---|---|---|---|
| Disputa 50 / 100 / 200 (100% confirma) | 50 / 100 / 200 | **0 / 0 / 0** | 80 / 85 / 175 ms | 29 / 51 / 129 ms |
| Disputa 50 / 100 / 200 (60% confirma) | 50 / 100 / 200 | **0 / 0 / 0** | 25 / 44 / 68 ms | 17 / 22 / 48 ms |
| `Rpm-924492` (100%, RPM real 9780) | 14.847 | 153 | 4,2 ms | 3,5 ms |
| `Rpm-924628` (60%, RPM real 9787) | 14.812 | 188 | 3,6 ms | 3,1 ms |

- **Disputa:** zero "lotado" confirma a explicação: ninguém foi barrado, aceitas = clientes.
- **RPM:** o `naive` ainda recusou 153 e 188 reservas (de 15.000). Foram as tentativas que chegaram depois de um
  refresh ter visto o evento cheio (o "lotado" tardio); antes disso o evento já estava estourado.
- **Latência da disputa maior que no `cas`** (p95 100%: 80 / 85 / 175 ms contra 45 / 53 / 63 ms): é uma rodada
  só e o `naive` aceita todos, então grava e confirma todos; não tratar como diferença estrutural sem repetir.

### Aleatório - naive

`Ale-924767` (45 min, 1k–12k RPM, 100% confirma; confirmado pelo banco: todas as reservas `confirmed`).

| Prefixo | Eventos | Ativas | Capacidade | Eventos com overselling | Overselling | Status |
|---|---|---|---|---|---|---|
| `Ale-924767` | 1464 | 146.400 | 146.400 | **0** | **0** | 146.400 `confirmed`, 0 `pending`, 0 `expired` |

**Era o esperado? Não — fugiu da previsão.** Eu esperava overselling > 0 também aqui (o `naive` não tem CAS),
mas o resultado foi 0, com os 1464 eventos lotados exatamente na capacidade. O `naive` continua incorreto
em princípio; o que mudou foi a janela de exposição:

- **Explicação provável (pela leitura do script, não medida):** a carga aleatória usa uma permutação dos
  pares (`i * PASSO % MAX_PARES`, `carga-aleatoria.js`) que **espalha as tentativas entre os 1464 eventos**
  "em vez de lotar um por um". Cada evento recebe uma tentativa a cada ~10–20 s no pico (~140 reservas/s ÷
  1464 eventos) e a cada ~2 min nas fases lentas. Isso é **maior que o refresh de 5 s**: antes da próxima
  tentativa naquele evento, o read model já foi recalculado e já mostra `disp = 0` ("Evento lotado"). O lag
  existe, mas ninguém chega durante ele.
- **Contraste com disputa e RPM:** lá cada evento levava 200 tentativas em 1–3 s (dentro de um refresh);
  aqui a carga por evento é rala no tempo. **O overselling do `naive` depende da concentração de
  tentativas por evento dentro da janela de refresh, não só da taxa total.** Taxa total alta (até 12k RPM) sem
  concentração por evento não oversella.
- **Sem expiração:** com 100% de confirmação nada expira nem devolve vaga, então não há revenda que
  reabra janela (diferente do `cas`, que passava de 146.400 aceitas só quando havia `expired`).
- **Implicação para o TCC:** o cenário aleatório espalhado **não** discrimina `cas` × `naive`; o contraste
  vem dos cenários de contenção por evento (disputa, RPM sequencial). Para forçar o `naive` a oversellar no
  aleatório seria preciso concentrar tentativas (ex.: popularidade enviesada, "evento quente") — não feito.
- **Confirmado pelo k6 (`summary-ale-924767.json`, PR #102):** 146.400 aceitas (= capacidade) e **48.610
  `lotado`**, 0 5xx, 0 descartadas. Ou seja, o read model alcançou a lotação em todos os eventos e passou a
  recusar: a explicação do refresh mais rápido que a chegada se sustenta. Reserva p50/p95/p99 3,0 / 4,8 /
  10,4 ms; leitura p95 474 ms (bimodal, igual ao `cas`); confirma p95 4,6 ms; máx 960 ms.

#### `Ale-927639` — `naive`, realista (60% confirma)

| Prefixo | Eventos | Ativas (`pending` + `confirmed`) | Capacidade | Eventos com overselling | Overselling | Status |
|---|---|---|---|---|---|---|
| `Ale-927639` | 1464 | 118.018 | 146.400 | **0** | **0** | 117.006 `confirmed` + 1.012 `pending` + 76.978 `expired` |

**Era o esperado? Não (mesmo desvio do `Ale-924767`).** Overselling 0 de novo, e aqui nem os eventos chegaram a
lotar (ativas 118.018 &lt; 146.400). Explicação provável, pelo mesmo motivo da rodada anterior (tentativas
espalhadas, ~10–20 s entre duas no mesmo evento, mais que o refresh de 5 s) somado ao fato de só ~60% das
aceitas virarem `confirmed`: as demais expiram em ~120 s e devolvem a vaga, então a ocupação fica abaixo da
capacidade e o `naive` quase nunca precisa dizer "lotado" nem chega a estourar. k6 (`summary-ale-927639.json`):
**194.996 aceitas, só 11 `lotado`** (contra 48.610 na rodada 100%), 0 5xx, 0 descartadas, 117.006 confirmadas
(60,0%) — praticamente igual ao `cas` realista (`Ale-919068`: 194.989 aceitas, 14 `lotado`, 116.744
confirmadas). Reserva p50/p95/p99 3,1 / 4,5 / 9,8 ms; leitura p95 468 ms. O motivo (expiração devolvendo vaga)
é hipótese, não medida diretamente. Os 1.012 `pending` são reservas ainda dentro do TTL na verificação.
Os 1.012 `pending` são reservas ainda dentro do TTL no momento da verificação.

### Achados

1. **Causa raiz do 5xx: falta de pool de conexões, não o CAS nem `max_connections`.** `DriverManager`
   abria 1 conexão TCP por operação → pico de **34.199 sockets em `TIME_WAIT`** (repouso ≈ 14) contra
   **28.232 portas efêmeras** (`32768–60999`, destino fixo `db:5432`) → `BindException: Cannot assign requested address`.
   Subir `max_connections` 300→1000 não mudou o 5xx (Postgres tinha ~16 conexões ativas). Os jobs
   `@Scheduled` (expiração, `event_availability`) também falharam, deixando `pending` vivos além do TTL.
2. **HikariCP resolveu**: 5xx 112.878 → 0, `BindException` → 0, latência de reserva p95 153 → 4,4 ms,
   descartadas 1735 → 0 (issue #96, critério atendido).
3. **Overselling 0 em todas as rodadas** (`eventos_com_overselling = 0` nos 1464 eventos do aleatório,
   nos 79 do RPM e nas disputas), antes e depois do pool, com e sem confirmação: o CAS é correto; o
   problema era de disponibilidade.
4. **Confirmar vendas é barato**: 60% de confirmação não mudou latência nem vazão (reserva p95 4,4 → 4,6 ms).
   Hipótese não medida: `UPDATE` por chave sobre linha já reservada, sem disputa.
5. **Leitura bimodal em aberto**: p50 1,9 ms mas p95 ≈ 460 ms. Suspeita (não medida por endpoint):
   `GET /bff/events/search` varre eventos em memória; independe do pool e da confirmação (N+1 do `hydrate` → issue #61).
6. **Lacunas**: `sockstat` pós-pool sem série durante a carga (proxy: 0 `BindException` + 0 5xx); tamanho
   ideal do pool inexplorado (100 VUs nunca chegaram perto de 1000; pool 1000 só é seguro com `max_connections` alto — o compose padrão usa 100);
   manhã × tarde não são perfeitamente comparáveis (banco zerado entre baterias, mas a diferença é grande demais para ser isso).

### Pendências

- Braço `naive`: disputa e RPM **rodados** (overselling > 0), aleatório `Ale-924767` (100% confirma) e `Ale-927639` (60%) rodados (overselling 0 nos dois, carga espalhada demais para expor o lag); faltam uma variante do aleatório com "evento quente" e repetir as rodadas para média/dispersão (issues #10 → #13).
- Série de 3 pontos: estes números são o **ponto 1 (monólito + pool)**; repetir nos marcos de microsserviços e CQRS+ES.
- Semente do sorteio de confirmação por rodada; mensagem do `rodar-teste.ps1` sobre `-Verificar` desatualizada.

### Dados completos por rodada

Fonte: `Projeto/carga/results/<etapa>/` (`resultados*.csv`, `verificacoes.log`, `baseline-*.txt`). Datas em dia/mês hora, 04/10/2026.

#### Ambiente (baseline de rede)

- data: 2026-10-04T12:26:32
- alvo: http://host:8081
- gerador: `gerador`  (AMD Ryzen 5 7600 6-Core Processor              )
- rede: 1 Gbps
- k6: k6.exe v2.2.0 (commit/00a9a1b7f5, go1.26.5, windows/amd64)
- ping: sem resposta (ICMP pode estar bloqueado no host; use so a medicao HTTP)
- http: p50=14.9ms p95=19.0ms max=21.1ms (n=30)

#### Disputa - cas (todas as rodadas)

| Data | Evento | Clientes | Vagas | Aceitas | Lotado | Outros | Overselling | p50 ms | p95 ms | p99 ms | Máx ms | Duração s | Vazão/s | Confirma | Confirma p95 ms |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 04/10 12:34 | 1 | 50 | 20 | 20 | 30 | 0 | 0 | 271,5 | 283,9 | 284,8 | 284,8 | 0,9 | 58 | — | — |
| 04/10 12:35 | 2 | 100 | 20 | 20 | 67 | 13 | 0 | 389,3 | 419,4 | 422,5 | 424,5 | 1,5 | 65,1 | — | — |
| 04/10 12:35 | 3 | 200 | 20 | 20 | 75 | 105 | 0 | 530,2 | 669,9 | 676,3 | 677,9 | 2,9 | 69,2 | — | — |
| 04/10 12:40 | 4 | 50 | 20 | 20 | 30 | 0 | 0 | 248,3 | 260,3 | 260,3 | 260,3 | 0,8 | 61,2 | — | — |
| 04/10 12:41 | 5 | 100 | 20 | 20 | 80 | 0 | 0 | 393 | 414 | 418,4 | 420,1 | 1,5 | 66,4 | — | — |
| 04/10 12:41 | 6 | 200 | 20 | 20 | 180 | 0 | 0 | 616,8 | 695,4 | 703,3 | 712,9 | 2,9 | 69,2 | — | — |
| 04/10 15:30 | 1 | 50 | 20 | 20 | 30 | 0 | 0 | 95,8 | 103 | 103,3 | 103,6 | 0,6 | 79,9 | — | — |
| 04/10 15:30 | 2 | 100 | 20 | 20 | 80 | 0 | 0 | 41,4 | 63,5 | 66,3 | 66,8 | 1,1 | 89,6 | — | — |
| 04/10 15:31 | 3 | 200 | 20 | 20 | 180 | 0 | 0 | 74,4 | 89,8 | 95,7 | 98,9 | 2,1 | 95,4 | — | — |
| 04/10 16:43 | 1626 | 50 | 20 | 20 | 30 | 0 | 0 | 36 | 45,3 | 45,9 | 46,3 | 0,5 | 94,3 | 100% (20) | 26,1 |
| 04/10 16:44 | 1627 | 100 | 20 | 20 | 80 | 0 | 0 | 42 | 53,4 | 54,2 | 54,6 | 1 | 98,6 | 100% (20) | 34,4 |
| 04/10 16:44 | 1628 | 200 | 20 | 20 | 180 | 0 | 0 | 48 | 63,2 | 65,1 | 65,9 | 2 | 101,3 | 100% (20) | 50,1 |
| 04/10 16:56 | 1708 | 50 | 20 | 20 | 30 | 0 | 0 | 37,2 | 41,8 | 42,6 | 42,6 | 0,5 | 93,9 | 60% (9) | 28,3 |
| 04/10 16:56 | 1709 | 100 | 20 | 20 | 80 | 0 | 0 | 33,3 | 43,5 | 44,9 | 44,9 | 1 | 98,5 | 60% (9) | 19 |
| 04/10 16:57 | 1710 | 200 | 20 | 20 | 180 | 0 | 0 | 34,5 | 47,6 | 50,6 | 60,2 | 2 | 101,1 | 60% (8) | 34 |

#### Disputa - naive (todas as rodadas)

| Data | Evento | Clientes | Vagas | Aceitas | Lotado | Outros | Overselling | p50 ms | p95 ms | p99 ms | Máx ms | Duração s | Vazão/s | Confirma | Confirma p95 ms |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 04/10 18:38 | 4718 | 50 | 20 | 50 | 0 | 0 | 30 | 65,6 | 80,3 | 90,7 | 92,6 | 0,7 | 74,1 | 100% (50) | 29 |
| 04/10 18:39 | 4719 | 100 | 20 | 100 | 0 | 0 | 80 | 44,4 | 84,9 | 89 | 89,9 | 1,2 | 85,1 | 100% (100) | 50,6 |
| 04/10 18:39 | 4720 | 200 | 20 | 200 | 0 | 0 | 180 | 76,3 | 175,4 | 192,4 | 202 | 2,3 | 88,7 | 100% (200) | 128,8 |
| 04/10 18:40 | 4721 | 50 | 20 | 50 | 0 | 0 | 30 | 16,2 | 25,2 | 25,5 | 25,7 | 0,5 | 94,2 | 60% (19) | 17,5 |
| 04/10 18:40 | 4722 | 100 | 20 | 100 | 0 | 0 | 80 | 27,3 | 43,8 | 44,3 | 45,6 | 1,1 | 95,1 | 60% (52) | 21,8 |
| 04/10 18:41 | 4723 | 200 | 20 | 200 | 0 | 0 | 180 | 37,6 | 67,6 | 74,8 | 75,3 | 2,1 | 94,4 | 60% (106) | 48,1 |

#### RPM - cas (todas as rodadas)

| Rodada | Data | max_conn | RPM alvo | RPM real | Duração s | Eventos | Aceitas | Lotado | 5xx | Descartadas | p50 ms | p95 ms | p99 ms | Máx ms | Confirma | Confirma p95 ms |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `Rpm-903185` | 04/10 12:48 | 300 | 2.000 | 1.930 | 62,2 | 11 | 1.000 | 1.000 | 0 | 0 | 27,1 | 31,7 | 40,4 | 51,4 | — | — |
| `Rpm-903506` | 04/10 12:54 | 300 | 10.000 | 9.761 | 92,2 | 79 | 5.379 | 4.903 | 4.718 | 0 | 28,5 | 45,6 | 52,3 | 74,2 | — | — |
| `Rpm-904217` | 04/10 13:05 | 300 | 10.000 | 9.764 | 92,2 | 79 | 5.375 | 4.907 | 4.718 | 0 | 29,3 | 44,5 | 52,1 | 68,9 | — | — |
| `Rpm-909189` | 04/10 14:28 | 1000 | 10.000 | 9.644 | 62,2 | 53 | 2.917 | 2.697 | 4.387 | 0 | 27,5 | 65,1 | 156,5 | 431,1 | — | — |
| `Rpm-909317` | 04/10 14:30 | 1000 | 10.000 | 9.643 | 62,2 | 53 | 2.850 | 2.587 | 4.563 | 0 | 26,6 | 50,1 | 74,2 | 177,2 | — | — |
| `Rpm-913181` | 04/10 15:35 | 1000 | 10.000 | 9.786 | 92 | 79 | 7.501 | 7.500 | 0 | 0 | 2,7 | 4,7 | 13,2 | 35,8 | — | — |
| `Rpm-913395` | 04/10 15:38 | 1000 | 10.000 | 9.792 | 91,9 | 79 | 7.500 | 7.500 | 0 | 0 | 2,5 | 4,2 | 11,9 | 41,7 | — | — |
| `Rpm-917602` | 04/10 16:48 | 1000 | 10.000 | 9.792 | 91,9 | 79 | 7.501 | 7.500 | 0 | 0 | 2,6 | 4,1 | 13,2 | 43 | 100% (7.501) | 3,9 |
| `Rpm-918245` | 04/10 16:59 | 1000 | 10.000 | 9.792 | 91,9 | 79 | 7.500 | 7.500 | 0 | 0 | 2,4 | 4,1 | 12,9 | 49,6 | 60% (4.450) | 4,2 |

#### RPM - naive (todas as rodadas)

| Rodada | Data | max_conn | RPM alvo | RPM real | Duração s | Eventos | Aceitas | Lotado | 5xx | Descartadas | p50 ms | p95 ms | p99 ms | Máx ms | Confirma | Confirma p95 ms |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `Rpm-924492` | 04/10 18:43 | 1000 | 10.000 | 9.780 | 92 | 79 | 14.847 | 153 | 0 | 0 | 2,7 | 4,2 | 10,8 | 24,2 | 100% (14.847) | 3,5 |
| `Rpm-924628` | 04/10 18:45 | 1000 | 10.000 | 9.787 | 92 | 79 | 14.812 | 188 | 0 | 0 | 2,8 | 3,6 | 8,1 | 23,8 | 60% (8.851) | 3,1 |

#### Aleatório - cas (todas as rodadas)

| Rodada | Data | Semente | RPM mín–máx | RPM médio | Duração s | Eventos | Aceitas | Lotado | 5xx | Leituras ok | Leituras outras | Descartadas | VUs máx | Reserva p50/p95/p99 ms | Leitura p50/p95/p99 ms | Máx ms | Confirma |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `Ale-904483` | 04/10 13:09 | 42 | 500–2.000 | 906 | 62,1 | 5 | 500 | 151 | 0 | 287 | 0 | 0 | 100 | 27,3 / 29,8 / 32,1 | 16 / 55,5 / 57,5 | 71 | — |
| `Ale-904991` | 04/10 14:05 | 617706 | 1.000–12.000 | 6.150 | 2.702,3 | 1.464 | 81.109 | 0 | 112.878 | 28.693 | 54.306 | 1.735 | 500 | 6,2 / 153,2 / 879,5 | 6,4 / 770,3 / 4.392,5 | 23.227,9 | — |
| `Ale-913561` | 04/10 16:26 | 617706 | 1.000–12.000 | 6.189 | 2.701,9 | 1.464 | 195.005 | 0 | 0 | 83.716 | 0 | 0 | 100 | 3,1 / 4,4 / 8,9 | 1,9 / 455,9 / 492,4 | 562,6 | — |
| `Ale-919068` | 04/10 17:58 | 617706 | 1.000–12.000 | 6.189 | 2.701,9 | 1.464 | 194.989 | 14 | 0 | 83.718 | 0 | 0 | 100 | 3,1 / 4,6 / 10,3 | 1,9 / 464,3 / 500,5 | 604,2 | 60% (116.744) |
| `Ale-266475` | 08/10 17:43 | 127266 | 1.000–12.000 | 4.872 | 122,2 | 53 | 5.501 | 1.429 | 0 | 2.993 | 0 | 0 | 100 | 3,6 / 7 / 12 | 2,3 / 29,6 / 36,9 | 55,5 | 100% (5.501) |

#### Aleatório - naive (todas as rodadas)

| Rodada | Data | Semente | RPM mín–máx | RPM médio | Duração s | Eventos | Aceitas | Lotado | 5xx | Leituras ok | Leituras outras | Descartadas | VUs máx | Reserva p50/p95/p99 ms | Leitura p50/p95/p99 ms | Máx ms | Confirma |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `Ale-924767` | 04/10 19:33 | 617706 | 1.000–12.000 | 6.189 | 2.702,3 | 1.464 | 146.400 | 48.610 | 0 | 83.711 | 0 | 0 | 100 | 3 / 4,8 / 10,4 | 2,2 / 474 / 517,7 | 960,2 | 100% (146.400) |
| `Ale-927639` | 04/10 20:21 | 617706 | 1.000–12.000 | 6.189 | 2.702 | 1.464 | 194.996 | 11 | 0 | 83.714 | 0 | 0 | 100 | 3,1 / 4,5 / 9,8 | 1,9 / 468 / 504,3 | 789,2 | 60% (117.006) |

#### Verificação do banco - Disputa (cas e naive)

Overselling = reservas ativas acima da capacidade, medido direto no Postgres após cada rodada. `eventcap` é o contador oficial de vagas (o `naive` nunca o decrementa).

| Data | Evento | Braço | Capacidade | Vagas restantes (eventcap) | Reservas ativas | Overselling | Status no banco |
|---|---|--:|--:|--:|--:|--:|--:|
| 04/10 15:33 | `evento 1` | cas | 20 | 20 | — | — | 20 expired |
| 04/10 15:33 | `evento 2` | cas | 20 | 20 | — | — | 20 expired |
| 04/10 15:33 | `evento 3` | cas | 20 | 20 | — | — | 20 expired |
| 04/10 16:46 | `evento 1626` | cas | 20 | 0 | 20 | 0 | 20 confirmed |
| 04/10 16:46 | `evento 1627` | cas | 20 | 0 | 20 | 0 | 20 confirmed |
| 04/10 16:46 | `evento 1628` | cas | 20 | 0 | 20 | 0 | 20 confirmed |
| 04/10 17:00 | `evento 1710` | cas | 20 | 12 | — | — | 8 confirmed, 12 expired |
| 04/10 18:42 | `evento 4718` | naive | 20 | 20 | 50 | 30 | 50 confirmed |
| 04/10 18:42 | `evento 4719` | naive | 20 | 20 | 100 | 80 | 100 confirmed |
| 04/10 18:42 | `evento 4720` | naive | 20 | 20 | 200 | 180 | 200 confirmed |
| 04/10 18:42 | `evento 4721` | naive | 20 | 20 | 50 | 30 | 19 confirmed, 31 pending |
| 04/10 18:42 | `evento 4722` | naive | 20 | 20 | 100 | 80 | 52 confirmed, 48 pending |
| 04/10 18:42 | `evento 4723` | naive | 20 | 20 | 200 | 180 | 106 confirmed, 94 pending |

#### Verificação do banco - RPM e Aleatório (cas e naive)

| Data | Rodada | Braço | Eventos | Reservas ativas | Capacidade | Eventos c/ overselling | Overselling total | Status no banco |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| 04/10 14:18 | `Ale-904991` | cas | 1464 | 0 | 146.400 | 0 | 0 | 81.109 expired |
| 04/10 14:28 | `Rpm-909189` | cas | 53 | 2.917 | 5.300 | 0 | 0 | 2.917 pending |
| 04/10 14:31 | `Rpm-909317` | cas | 53 | 1.345 | 5.300 | 0 | 0 | 1.507 expired, 1.343 pending |
| 04/10 15:35 | `Rpm-913181` | cas | 79 | 7.501 | 7.900 | 0 | 0 | 7.501 pending |
| 04/10 15:38 | `Rpm-913395` | cas | 79 | 7.500 | 7.900 | 0 | 0 | 7.500 pending |
| 04/10 16:29 | `Ale-913561` | cas | 1464 | 0 | 146.400 | 0 | 0 | 195.005 expired |
| 04/10 16:49 | `Rpm-917602` | cas | 79 | 7.501 | 7.900 | 0 | 0 | 7.501 confirmed |
| 04/10 17:00 | `Rpm-918245` | cas | 79 | 6.248 | 7.900 | 0 | 0 | 4.450 confirmed, 1.252 expired, 1.798 pending |
| 04/10 18:07 | `Ale-919068` | cas | 1464 | 116.744 | 146.400 | 0 | 0 | 116.744 confirmed, 78.245 expired |
| 04/10 18:46 | `Rpm-924492` | naive | 79 | 14.847 | 7.900 | 75 | 7.347 | 14.847 confirmed |
| 04/10 18:46 | `Rpm-924628` | naive | 79 | 14.485 | 7.900 | 75 | 6.985 | 8.851 confirmed, 327 expired, 5.634 pending |
| 04/10 19:34 | `Ale-924767` | naive | 1464 | 146.400 | 146.400 | 0 | 0 | 146.400 confirmed |
| 04/10 20:22 | `Ale-927639` | naive | 1464 | 118.018 | 146.400 | 0 | 0 | 117.006 confirmed, 76.978 expired, 1.012 pending |


### Harness inicial (issue #11)

Disputa de N clientes (VUs) por poucas vagas, rodada em 04/09/2026 pelo harness (`docs/carga/harness/`). Lag = atraso do read model (`event_availability`).

#### Disputa - cas

| Data | VUs | Vagas | Confirmadas | Corretude | p50 (ms) | p95 (ms) | p99 (ms) | Vazão (res/s) | Lag médio (ms) | Lag máx (ms) |
|---|--:|--:|--:|:-:|--:|--:|--:|--:|--:|--:|
| 04/09/2026 20:50 | 12 | 5 | 5 | ✅ OK | 75,8 | 84,8 | 84,9 | 128,7 | 2.097,6 | 3.815,8 |
| 04/09/2026 21:00 | 6 | 3 | 3 | ✅ OK | 46,7 | 50,7 | 50,7 | 93 | 2.239,9 | 4.843,9 |
| 04/09/2026 23:31 | 6 | 3 | 3 | ✅ OK | 60,9 | 66,9 | 67,7 | 75,5 | 2.282 | 4.265,8 |
| 04/09/2026 23:39 | 6 | 3 | 3 | ✅ OK | 43 | 46,6 | 46,6 | 101 | 1.445,5 | 3.430,8 |
