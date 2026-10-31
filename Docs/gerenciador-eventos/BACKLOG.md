# Backlog — Decomposição do Sistema em Issues Iterativas

Gerado a partir da documentação de arquitetura do projeto (cópia versionada em `docs/adr/`).
Cada issue é uma fronteira de iteração: **após o merge, `docker compose up` + a suíte de
testes continuam verdes e o contrato servido ao Flutter não muda.** Numa extração de serviço,
"verde" = o `gateway` ainda serve o mesmo contrato externo, não só que a suíte compila.

ADRs de referência (a vendorizar em `docs/adr/` — issue #2):
`Backend-Architecture`, `Architecture-Decision-Stock-Isolation`,
`Architecture-Decision-Async-Checkout-Queue`, `Architecture-Decision-Supabase-Self-Host`,
`Architecture-Decision-Microservices-Split`, `Implementacao-EventCap-e-Reserva-CAS`,
`Database-Schema`, `References`.

## Decisões de arquitetura em vigor

- Back-end decomposto em microsserviços, Opção B (`gateway`, `identity`, `catalog`,
  `reservation`, `notification`, `admission`).
- `reservation` = Capacity + Wallet no mesmo serviço (híbrido CAS + ES) até a #47, que o
  dividiu em `stock` (capacidade, CAS) + `reservation` (wallet, ES) com saga orquestrada.
- **CQRS + Event Sourcing no escopo.** ES em `catalog` e no lado wallet de `reservation`;
  `eventcap`/CAS fica relacional; `identity` CRUD; `notification` consumidor. Backbone
  **Kafka-compatível** (Kafka ou Redpanda); RabbitMQ para admissão; Redis para sinal de carga.
- **O experimento diferencial roda cedo e várias vezes** (de-risking — feedback do
  orientador). Braço de controle "checar disponibilidade via read model defasado → oversella"
  roda 1º contra o monólito (Fase 2, read model sintético), depois re-roda a cada marco:
  monólito+ES (Fase 6) e distribuído (Fase 7). A série de 3 pontos é a contribuição rica.
- **Geração de carga em máquina/VM separada** — números absolutos de latência/throughput são
  válidos, não só a contagem de corretude.

Prioridade: **back-end e banco primeiro; front-end é prioridade baixa** (só a issue #43).

Labels sugeridas: `fase/0`…`fase/11`, `area/backend`, `area/banco`, `area/infra`,
`area/frontend`, `area/eventos`, `area/carga`, `artigo`, `seguranca`, `bloqueado/docker`.

---

## Estado (2026-10-29)

Snapshot do GitHub (`gh issue list` / `gh pr list`). A definição de cada item continua sendo o
texto abaixo; esta seção só diz onde ele está. Item N = issue #(N+1).

| Item | Issue | Estado | PR |
|---|---|---|---|
| 1 | #2 | fechada | #52 |
| 2 | #3 | fechada | #53 |
| 3 | #4 | fechada — gerador provisionado e latência base HTTP medida (`Projeto/carga/results/01-sem-pool/baseline-20261004-122632.txt`; ICMP não respondeu) | #76, kit em #90 |
| 4 | #5 | fechada | #55 |
| 5 | #6 | fechada | #65 |
| 6 | #7 | fechada | #66, #68 (fone obrigatório, #67) |
| 7 | #8 | fechada | #70 |
| 8 | #9 | fechada (roteiro em `docs/testes-manuais/`; `.sh` precisa de JWT pós-#79) | #73 |
| 9 | #10 | fechada | #75 |
| 10 | #11 | fechada — o kit `Projeto/carga` virou o runner oficial (matriz, lag coletado do gerador, CSV + gráfico), na `Fase_2` | #82, #104 |
| 11–13 | #12–#14 | fechadas — rodadas oficiais na `Fase_2`: matriz CAS × ingênuo (#12, #13) e escada de carga/limiar X (#14); resultados pré-pooler em `Projeto/carga/results/02-hikari/` | #114, #115 |
| 14 | #15 | fechada no Batch 2 — seção da Fase 2 no artigo com as 5 figuras em `docs/artigo/graficos/` | #186 |
| 15 | #16 | aberta, **pulada pelo usuário** (2026-10-16): os segredos ficam como estão até o fim do TCC | — |
| 16 | #17 | fechada | #116 |
| 17 | #18 | fechada | #118 |
| 18 | #19 | fechada | #119 |
| 19 | #20 | fechada | #120 |
| 20 | #21 | fechada | #117 |
| 21 | #22 | fechada — matriz refeita pelo pooler, o ponto 1 da série (`docs/carga/resultados-matriz-pospooler-2026-10-16.md`); a escada X e o isolamento do pooler foram refeitos em 2026-10-17 (X ≈ 78k RPM pelo pooler; `docs/carga/resultados-isolamento-escada-pospooler-2026-10-17.md`) | #121 |
| 22 | #23 | fechada — módulos `identity`/`catalog`/`reservation`/`notification`/`shared` com pacote `api`; ArchUnit `ModuleBoundaryArchTest` | #127 |
| 23 | #24 | fechada — `Idempotency-Key` no `POST /bff/event-wallets` (tabela `idempotency_key`, claim na transação do CAS, 422 em payload divergente) | #132 |
| 24 | #25 | fechada — controllers `bff/*` no módulo `gateway`; ArchUnit trava `@RestController` fora dele | #128 |
| 25 | #26 | fechada — ADR `docs/adr/Architecture-Decision-Event-Backbone-Event-Store.md`: Redpanda; event store em tabela Postgres + outbox → Redpanda; envelope JSON | #138 |
| 26 | #27 | fechada — Redpanda no compose + `shared/events` (append com concorrência otimista, relay, consumer idempotente, replay em sombra, snapshots) | #141 |
| 27 | #28 | fechada — `catalog` em CQRS + ES (5 eventos, projeção inline `event`/`eventpresenter`, replay) | #142 |
| 28 | #29 | fechada — lado wallet de `reservation` em ES (híbrido com o CAS); disponibilidade do braço naive como projeção assíncrona com lag real | #143 |
| 29 | #30 | fechada — checkpoint ES-native ponta a ponta; diagrama `docs/arquitetura/fase6-cqrs-es.md` | #144 |
| 30 | #31 | fechada — Rodada 2 em `Projeto/carga/results/04-fase6-es`, ponto 2 em `docs/artigo/experimento-monolito.md` | #148 |
| 31 | #32 | fechada — `notification` como serviço (Maven multi-módulo, Dockerfile por serviço); e-mail por evento `identity.notification`, dado pessoal com retenção = validade do código + 30 s | #152 |
| 32 | #33 | fechada — `reservation` como serviço atrás do `gateway` (schema e event store próprios, API `/internal/**` com token de serviço); naive em 2 chamadas HTTP, CAS em 1; `eventcap` por chamada síncrona | #153 |
| 33 | #34 | fechada (2026-10-26) — Rodada 3 (ponto 3) em `Projeto/carga/results/05-distribuido`, X ≈ 58k, CAS com overselling 0; controle do ponto 2 no cabo em `04b-fase6-es-cabo`; ponto 3 em `docs/artigo/experimento-monolito.md` | #155, #156 |
| 34 | #35 | fechada — `catalog` como serviço (schema, event store e relay próprios; API `/internal/events/**` com token de serviço); `creator_id` integer amarrado ao token, `creator_name` composto no `gateway`; seed desligado por padrão | #157 |
| 35 | #36 | fechada na `Batch_1` — `identity` como serviço (schema `identity`, event store e relay próprios); JWT RS256 emitido pelo serviço e validado sem estado no `gateway` pelo JWKS (claim `uid`); migração `20261028` | #169 |
| 36 | #37 | fechada na `Batch_1` — compose final (healthchecks, `notification-seek` no 1º `up`, SMTP parametrizável) + suíte e2e `Projeto/e2e/run-e2e.sh` (project isolado, Mailpit) | #172 |
| 37 | #38 | fechada na `Batch_1` — harness definitivo: cenário de leitura no `test-rpm`, `coleta-host.sh` (lags, outbox, conexões, `pg_stat_statements`) | #168 |
| 38 | #39 | fechada na `Batch_1` — comparação das 3 configurações (tabela + gráficos em `docs/artigo/graficos/`) em `docs/artigo/experimento-monolito.md` | #174 |
| 39 | #40 | fechada na `Batch_1` — X definitivo = 56k RPM por evento (Rodada R, `Projeto/carga/results/06-batch1-final`; intercalado ≈ 86k = teto do host) | #173 |
| 40 | #41 | fechada no Batch 2 — serviço `admission` com o contador de RPM por evento no Redis | #190 |
| 41 | #42 | fechada no Batch 2 — fila de admissão no RabbitMQ + worker pool | #193 |
| 42 | #43 | fechada no Batch 2 — gatilho 80/70 com histerese, `202` e consulta de estado (`GET /bff/event-wallets/admission`) | #194 |
| 43 | #44 | fechada no Batch 2 — UI de reserva `pending` no Flutter | #196 |
| 44 | #45 | aberta, fora do Batch 2 por decisão do usuário (material do artigo) | — |
| 45 | #46 | fechada no Batch 2 — READMEs | #211 |
| 46 | #47 | fechada no Batch 2 — `reservation` dividido em `stock` + wallet com saga (migração `20261029`) | #202 |
| 47 | #111 | fechada no Batch 2 — autoescala de `gateway` e `reservation`, opção A (override + HAProxy `lb` + scaler no host) | #199 |
| 48 | #112 | fechada no Batch 2 — autoescala de `identity`, `catalog`, `admission` e `notification` | #200 |

Branch de integração da Fase 2: `Fase_2` (a #11 entrou pelo PR #104; as #12–#15 foram
desenvolvidas direto nela; entrou em `main` pelos PRs #114 e #115). Branch de integração da Fase 4: `Fase_4`
(cada `Issue-N` abre PR com base nela; entrou em `main` pelo PR #122). Branch de integração da Fase 5: `Fase_5`
(PRs #127, #128 e #132 com base nela; PR final #134 `Fase_5` → `main`, merge do usuário). Branch de integração da Fase 6:
`Fase_6`, criada a partir da `Fase_5` (PRs #135, #137–#144 com base nela; PR final `Fase_6` → `main`, merge do usuário). Vocabulário do
experimento em `CONTEXT.md`.

Fora do backlog (follow-ups): #56–#61 fechadas no Batch 1 (`updatePolicy` PR #163, IDOR em `/bff/event-wallets` PR #167,
endurecer schema PR #159, cobertura PR #162, transações do `updateEvent` PR #160, N+1/expiração em lote PR #161), junto com
#89 (PR #164), #133 (PR #165), #113 (PR #158) e #81 (fechada sem PR: o `SEED_ENABLED` da #35 já cobria o aceite); os abertos do
Batch 1 fecharam no Batch 2: #166 (IDOR pré-existente, PR #184), #170 (PR #185) e #171 (PR #192), junto com a #84 (`flutter_lints`, PR #187); #78 (BFF única + JWT
deny-by-default, PR #79), #83 (quality gates, PR #85), #86 (PR #88), #92 (`/actuator/health`,
PR #93) e #67 fechadas. Da Fase 5: #129 (PK da idempotência por usuário, PR #137), #130 (retenção
da `idempotency_key`, PR #139), #131 (`run-tests.sh` limpa `surefire-reports`, PR #135) e #136 (`verify-20260901` com o init-script 10, PR #140)
fechadas na `Fase_6`; #133 (CORS `*` com credenciais) fechada no Batch 1. #146 (consumer da projeção de disponibilidade aplica em lote, PR #147) e #149 (GUID do plano Alto desempenho nos scripts de setup, PR #150) fechadas, follow-ups da Rodada 2 (#31). PR #90 adicionou os scripts de teste de carga
(disputa de vagas e taxa fixa/RPM) em `Projeto/carga/`.

Caminho crítico (issues): #2 → #5 → #7 → #10 → #11 → #12 → #13 feitas (marco de banca atingido); Fase 4: #17 → #18
→ #19/#20/#21 → #22 feitas (ponto 1 da série; PR #122); Fase 5: #23 → #24/#25 feitas (PR #134); Fase 6: #26 → #27 → #28/#29 → #30 feitas (na `Fase_6`);
Rodada 2 (#31, ponto 2 da série) feita em 2026-10-19 (PR #148). Fase 7: #32 → #33 feitas em 2026-10-21 na branch de integração
`Fase_7` (PRs #152 e #153; PR final #156 `Fase_7` → `main`, mergeado em 2026-10-25); a #34 (Rodada 3) foi feita em 2026-10-24 com o gerador (resultados em `Projeto/carga/results/05-distribuido`) e fechada em 2026-10-26; a #35 (`catalog`) fechou em 2026-10-25 (PR #157). Batch 1 (2026-10-26 a 2026-10-28, branch de integração `Batch_1`): #36 →
#37 → #38 → Rodada R (`Projeto/carga/results/06-batch1-final`) → #40 → #39, mais os follow-ups acima; PR final #175 `Batch_1` → `main`
mergeado. Batch 2 (2026-10-28 a 2026-10-29, branch de integração `Batch_2`): #166 ‖ (#170 → #171), #84 ‖ #15, #41 → #42 → #43 → #44, #177,
#111 → #112, #178 → Rodada 4 (#179) → #47 → #204 → Rodada 5 (#180) e #46, todas feitas; PR final `Batch_2` → `main` aguardando o merge.

Issues do Batch 2 fora do import 1–46: #177 (imagens slim, PR #189), #178 (harness da Rodada 4, PR #201), #179 (Rodada 4,
`Projeto/carga/results/07-rodada4-admission`, PR #208) #204 (harness da Rodada 5, PR #209) e #180 (Rodada 5, `Projeto/carga/results/08-rodada5-saga`, PR #218), fechadas.

Follow-ups abertos (2026-10-30):

| Issue | Assunto |
|---|---|
| #181 | `GET /bff/users/email/{email}` expõe qualquer conta e as respostas de usuário trazem o hash da senha |
| #182 | e-mail único sem diferenciar maiúsculas por índice em `lower(email)` (corrida do check da #166) |
| #183 | PUT de usuário grava `admin` a partir do corpo |
| #188 | frontend: não exibir o corpo cru da resposta de erro nos SnackBars |
| #195 | reserva `pending` vencida ainda bloqueia nova reserva até a varredura do job |
| #197 | autoescala em Kubernetes com HPA/KEDA (opção D da ADR de autoescala) |
| #198 | Flutter: gerar a `Idempotency-Key` no cliente para retomar resposta perdida |
| #203 | `notification-seek` falha se `identity.notification` ainda não existe |
| #205 | `stock` escalável (até 3 réplicas) junto com a #197 |
| #206 | scaler: suavizar o sinal `adm:hot` antes de decidir subir ou descer réplica |
| #207 | `lb`: o health check do gateway não pode tirar do ar réplica saturada (5xx do braço C na R4) |
| #210 | `gerar-imagens-slim.sh`: a sonda do `admission` cria o `eventcap` no `reservation` (404 desde a #47) |
| #212 | `seed-data.sql` e a migração `20261022` ainda procuram o `eventcap` em `reservation`/`public` |

Também abertas, fora do Batch 2 por decisão do usuário: #16 (`.env`, até o fim do TCC) e #45 (material do artigo).

## Fase 0 — Desbloqueio de ambiente

### 1. Instalar Docker Desktop e validar baseline verde do `main`
`fase/0` `area/infra` `bloqueado/docker`
- **Aceite:** `docker compose -f Projeto/docker-compose.yml up -d --build` sobe; `Projeto/Backend/run-tests.sh` roda e o resultado fica registrado. Sem mudança de código.
- **Depende de:** —

### 2. Vendorizar as ADRs em `docs/adr/`
`fase/0` `area/infra`
- **Aceite:** os 8 `.md` em `docs/adr/`, links como caminhos relativos, índice em `docs/adr/README.md`.
- **Depende de:** —

### 3. Preparar a máquina/VM separada para geração de carga
`fase/0` `area/carga` `area/infra`
- **Aceite:** máquina ou VM com acesso de rede ao host do sistema; ferramenta de carga instalada (k6/Gatling/JMeter); latência de rede base entre gerador e alvo medida e registrada (pra descontar depois); documentado em `docs/carga/setup.md`.
- **Depende de:** —

---

## Fase 1 — Verificar a implementação EventCap/CAS de 2026-09-01

> Código escrito e nunca compilado. Base verde aqui é pré-requisito de tudo.

### 4. Compilar o backend e passar na suíte EventCap/CAS
`fase/1` `area/backend`
- **Aceite:** `mvn compile` limpo; `EventTest`, `EventWalletTest`, `ReservationExpiryTest`, `SchemaValidationTest` verdes.
- **Depende de:** #1

### 5. Aplicar a migration idempotente em banco populado + `99-tests.sql`
`fase/1` `area/banco`
- **Aceite:** `migrations/20260901-eventcap-isolation.sql` roda via `psql` em banco com dados pré-existentes **sem** `down -v`, idempotente (2× sem erro); `99-tests.sql` passa.
- **Depende de:** #4

### 6. Revisar constraints do Postgres + validar `walletevent.status`
`fase/1` `area/banco` `area/backend`
- **Aceite:** `email` unique, `fone` obrigatório + unique, `event_name` unique confirmados. Fluxo `walletevent.status` validado — UPSERT que revive `expired`/`cancelled`, índice parcial `idx_walletevent_pending_expires`.
- **Depende de:** #5

### 7. Validar o job `ReservationExpiryService`
`fase/1` `area/backend`
- **Aceite:** reserva `pending` não confirmada → após `expires_at`, `@Scheduled` marca `expired` e devolve a vaga numa transação, sem pisar em confirmação concorrente. Teste manual + `ReservationExpiryTest` verde.
- **Depende de:** #4

### 8. Teste manual de overselling sob concorrência (sanity)
`fase/1` `area/backend`
- **Aceite:** `capacity = 1`, dois `POST /api/bff/event-wallets` quase simultâneos → um `pending`, o outro "Evento lotado". Roteiro em `docs/`.
- **Depende de:** #4, #5

---

## Fase 2 — Experimento vs. monólito  ·  ENTREGA PRINCIPAL

> Trava um resultado defensável para a banca antes de qualquer buildout de ES/microsserviços.

### 9. Read model defasado sintético
`fase/2` `area/backend` `area/carga`
- **Aceite:** tabela desnormalizada `event_availability` (event_id, available); refresh por job em timer com **lag configurável**; caminho de leitura "ingênuo" (checa `event_availability` e depois insere, sem CAS) atrás de **feature flag**. Caminho CAS atual permanece o default.
- **Depende de:** #4, #6

### 10. Harness de carga rodando da máquina/VM separada
`fase/2` `area/carga` `artigo`
- **Aceite:** o kit `Projeto/carga` é o runner oficial (o harness de `docs/carga/harness/` fica como sanity local). Alvo de matriz: para um lag fixo, N × repetições, evento novo por repetição, `PCT_CONFIRMA=100`, rajada em instante pseudo-aleatório. O gerador coleta `confirmed`/`pending` e o lag observado via `psql` remoto (`:5433`). CSV com uma linha por execução (`braco, lag_ms, N, capacity, rep, confirmed, pending, oversell, p50, p95, p99, throughput, lag_obs_disparo, lag_obs_max, commit`) + gráfico SVG (overselling × lag, uma curva por braço, e painel de p95). Spec completa na issue #11.
- **Depende de:** #3, #9

### 11. Rodada 1a — no-overselling pelo caminho CAS
`fase/2` `area/carga` `artigo`
- **Aceite:** preset do runner: `readpath=cas`, N ∈ \{100, 200\}, `capacity` 20, 5 repetições. Overselling = `confirmed > capacity` (primária) e `pending + confirmed > capacity` (secundária), tolerância 0. Execução no gerador pelo usuário; CSV versionado vira a curva "design proposto".
- **Depende de:** #10

### 12. Rodada 1b — braço de controle: caminho ingênuo oversella
`fase/2` `area/carga` `artigo`
- **O diferencial do trabalho.** "O design ingênuo oversella, o nosso não — eis os números."
- **Aceite:** preset do runner: `readpath=naive`, lags ∈ \{500, 2000, 5000, 10000\} ms × N ∈ \{100, 200\} × 5 repetições (40 execuções). Gráfico de duas curvas (CAS e ingênuo, overselling × lag, média ± desvio). Execução no gerador pelo usuário; o resultado é reportado como medido.
- **Depende de:** #11

### 13. Throughput/latência preliminares do monólito + limiar X preliminar
`fase/2` `area/carga` `artigo`
- **Aceite:** carga em degraus a partir de 12k RPM até degradar ou até o limite do gerador; X = primeiro degrau com 5xx > 1% das reservas ou p95 > 1 s por 30 s (se o gerador saturar antes, X é limite inferior). Curva latência/throughput × carga. Ressalva: números de "monólito + HikariCP" — os números pré-pool (#96) estão invalidados.
- **Depende de:** #11

### 14. Consolidar o resultado da Fase 2 em rascunho de seção do artigo
`fase/2` `artigo`
- **Aceite:** `docs/artigo/experimento-monolito.md` com hipótese, setup (2 PCs, 1 Gbps), workload, métricas (`CONTEXT.md`), resultados (duas curvas + X), ameaças à validade e limitações. Números "monólito + HikariCP", não o ponto 1 definitivo da série. Revisado com o orientador.
- **Depende de:** #12, #13

---

## Fase 3 — Higiene de segredos

### 15. Tirar `Projeto/.env` do git, rotacionar segredos, padronizar `.env` por serviço
`fase/3` `seguranca`
- **Aceite:** `git rm --cached Projeto/.env`; `.gitignore` commitado; segredos rotacionados (senha Postgres, `JWT_SECRET`, senha de app do Gmail, chaves reCAPTCHA); `.env.example` versionado. Reescrita de histórico opcional; **rotacionar é obrigatório**.
- **Depende de:** —

---

## Fase 4 — Camada de banco: Supabase self-hosted enxuto

> Não bloqueia o experimento — destrava os números absolutos comparáveis.
> Ver `Architecture-Decision-Supabase-Self-Host`.
>
> **Implementado na `Fase_4` (2026-10-16):** `supabase/docker` vendorizado e gerador de segredos (item 16);
> `supabase-db` (`supabase/postgres:17.6.1.136`) no lugar do `db` (17); `supabase-pooler` (Supavisor 2.9.13, transaction
> mode, backend em `:6543` com `prepareThreshold=0`) (18); Studio + cadeia mínima (19); harness schema-per-service
> (20). O item 15 (segredos) foi pulado. O item 21 refez a matriz pelo pooler (ponto 1 da série): CAS com
> overselling 0 e cerca de 2× mais lento que no pré-pooler, mas o efeito mistura três mudanças e o estado do banco
> (artigo, ameaças 14 e 15).

### 16. Vendorizar `supabase/docker/` e gerar segredos
`fase/4` `area/infra` `bloqueado/docker`
- **Aceite:** `supabase/docker/` vendorizada ou via script de setup; segredos com `generate-keys.sh` no `.env` (não commitado).
- **Depende de:** #15

### 17. Substituir o serviço `db` por `supabase-db`
`fase/4` `area/infra` `area/banco`
- **Aceite:** compose usa `supabase/postgres` (Dockerfile atual como fallback no histórico); init-scripts em `/docker-entrypoint-initdb.d/migrations/` com prefixo alto; decisão `meu_banco` vs `postgres` registrada. Testes da Fase 1 verdes.
- **Depende de:** #16

### 18. Adicionar `supabase-pooler` (Supavisor) e apontar o backend
`fase/4` `area/infra` `area/backend`
- **Aceite:** Supavisor no compose; `SPRING_DATASOURCE_URL` → pooler (`:6543` + `?prepareThreshold=0`, ou `:5432`); auditado que não há estado de sessão (`SET`/advisory lock); fluxo de reserva funciona pelo pooler.
- **Depende de:** #17

### 19. Adicionar `supabase-studio` + cadeia mínima
`fase/4` `area/infra` `artigo`
- **Aceite:** Studio sobe (com `kong`, `meta` e o mínimo); inspeção visual de `eventcap`/`walletevent`. GoTrue/PostgREST/Realtime/Storage/imgproxy/edge functions **não** sobem.
- **Depende de:** #17

### 20. Migrar o harness de teste para schema-per-service
`fase/4` `area/backend` `area/banco`
- **Aceite:** `GlobalDbTruncator` e `SchemaValidationTest` recebem a lista de schemas alvo por config; suíte verde com um schema, preparada para vários.
- **Depende de:** #17

### 21. Re-rodar o experimento pós-pooler — baseline oficial "monólito CRUD"
`fase/4` `area/carga` `artigo`
- **Aceite:** rodadas 1a/1b re-executadas com o pooler; latência/throughput agora comparáveis; resultado vira o ponto 1 da série de 3. `docs/artigo/experimento-monolito.md` atualizado.
- **Depende de:** #18, #12

---

## Fase 5 — Preparar a decomposição (dentro do monólito)

> **Implementado na `Fase_5` (2026-10-18):** backend em módulos `identity`, `catalog`, `reservation`, `notification` e
> `shared` mínimo, cada um com pacote `api` e fronteira travada por ArchUnit (item 22); `Idempotency-Key` no
> `POST /bff/event-wallets`, com claim na mesma transação JDBC do CAS e a fronteira capacidade/reserva atrás de
> interface (23); controllers `bff/*` no módulo `gateway` (24). Tudo no mesmo processo e deploy, schema `public`;
> o `HttpContractTest` não mudou de expectativa. Sem rodada de carga: o custo da chave no caminho quente fica para
> o ponto 2 da série.

### 22. Refatorar o backend em pacotes-por-serviço
`fase/5` `area/backend`
- **Aceite:** `identity/`, `catalog/`, `reservation/`, `notification/` (+ `shared/`); nenhuma chamada cruzada fora de interface; teste de arquitetura (ArchUnit); suíte verde; contrato externo inalterado.
- **Depende de:** #4

### 23. Introduzir idempotency key no fluxo de reserva
`fase/5` `area/backend`
- **Aceite:** `POST /event-wallets` aceita/gera `Idempotency-Key`; repetição não decrementa `eventcap` duas vezes; fronteira interna "decrementar capacidade" vs "gravar reserva" atrás de interface. Invariante e ponto de compensação documentados.
- **Depende de:** #6, #22

### 24. Formalizar o BFF atual como `gateway`
`fase/5` `area/backend` `area/infra`
- **Aceite:** BFF vira serviço `gateway`; contrato consumido pelo Flutter idêntico (teste de contrato); demais módulos não expostos direto.
- **Depende de:** #22

---

## Fase 6 — CQRS + Event Sourcing (nos módulos do monólito)

> **Implementado na `Fase_6` (2026-10-18):** ADR do backbone (item 25). Redpanda e infra de event store em `shared/events`
> (26): append com concorrência otimista + outbox na mesma transação, relay com `pg_try_advisory_xact_lock`, consumer
> idempotente com checkpoint por CAS, replay em schema-sombra. `catalog` em CQRS + ES (27). Lado wallet de `reservation` em
> ES, híbrido com o CAS (28): a disponibilidade do braço `naive` virou projeção assíncrona alimentada pelo consumer, com lag
> real (`applied_at`/`last_occurred_at`, log `events.lag`, offset lag), e o refresh por timer da Fase 2 saiu. Checkpoint
> ponta a ponta e diagrama `docs/arquitetura/fase6-cqrs-es.md` (29). O contrato `/bff/**` não mudou. A Rodada 2 (item 30) foi
> feita em 2026-10-19 (`Projeto/carga/results/04-fase6-es`; ponto 2 em `docs/artigo/experimento-monolito.md`; PR #148).

### 25. ADR — backbone de eventos + event store + contrato do evento de domínio
`fase/6` `area/eventos` `area/backend`
- **Aceite:** ADR decidindo Kafka vs Redpanda; event store = Kafka como log de verdade + projeções em Postgres **vs** tabela de streams no Postgres + publish; formato do evento (JSON/Avro + schema registry?) e versionamento; papéis: Kafka = log/fanout, RabbitMQ = admissão, Redis = sinal de carga.
- **Depende de:** #22

### 26. Subir o backbone Kafka-compatível + infra de event store
`fase/6` `area/eventos` `area/infra` `area/banco`
- **Aceite:** broker no compose; módulo `shared` de append/read por stream com **concorrência otimista** (id do agregado + versão); publish após append; catch-up de projeção (poller ou `pg_cron`); projeções **idempotentes**; tabela de snapshot + política. Teste de replay: append N eventos, reconstruir projeção do zero → idêntico.
- **Depende de:** #25

### 27. Converter o módulo `catalog` para CQRS + ES
`fase/6` `area/backend` `area/eventos` `area/banco`
- **Aceite:** eventos `EventCreated`/`EventUpdated`/`PresenterAdded`/`PresenterRemoved`/`EventCancelled`; command side appenda; read model em tabelas de query; contrato do `gateway` inalterado; suíte verde; teste de replay do agregado `Event`.
- **Depende de:** #26, #20

### 28. Converter o lado wallet/order do módulo `reservation` para ES (híbrido)
`fase/6` `area/backend` `area/eventos` `area/banco`
- **Aceite:** stream `SlotReserved`/`ReservationConfirmed`/`ReservationExpired`/`ReservationCancelled`; `eventcap` + CAS permanecem relacionais; ponte checkout → CAS síncrono → append `SlotReserved`; job de expiração emite `ReservationExpired`; read model "minhas reservas" projetado; suíte + overselling (#8) verdes; teste de replay.
- **Depende de:** #26, #20, #23

### 29. Checkpoint — monólito ES-native verde ponta-a-ponta
`fase/6` `area/backend`
- **Aceite:** `catalog` e `reservation` event-sourced; contrato externo inalterado; replay de ambos funcionando; suíte completa verde; diagrama command/evento/projeção em `docs/`.
- **Depende de:** #27, #28

### 30. Rodada 2 do experimento — contra a projeção ES real
`fase/6` `area/carga` `artigo`
- **Aceite:** braço de controle re-executado, agora lendo a **projeção ES real** (lag de consumer de verdade, não timer sintético); mesmo N concorrentes; comparado com a rodada 1 (Fase 4). Ponto 2 da série. `docs/artigo/` atualizado.
- **Depende de:** #29, #21

---

## Fase 7 — Extração incremental dos serviços (strangler, um por vez)

### 31. Extrair `notification` como serviço
`fase/7` `area/backend` `area/infra`
- **Aceite:** consumidor do backbone, envia e-mail; monólito para de enviar direto; queda do `notification` não afeta cadastro/login.
- **Depende de:** #24, #26, #29

### 32. Extrair `reservation` (híbrido CAS + ES) atrás do `gateway`
`fase/7` `area/backend` `area/banco` `area/eventos`
- **Aceite:** `reservation` com schema + streams próprios; API interna síncrona chamada pelo `gateway`; job de expiração dentro dele; `eventcap`/`walletevent`/streams saem do monólito; suíte + overselling + replay verdes.
- **Depende de:** #31

### 33. Rodada 3 do experimento — sistema distribuído
`fase/7` `area/carga` `artigo`
- **Aceite:** braço de controle com `reservation` como serviço (a checagem de disponibilidade cruza a rede); mesmo N concorrentes; **comparação monólito ES vs distribuído**. Ponto 3 da série — completa o gráfico de 3 pontos. `docs/artigo/` atualizado.
- **Depende de:** #32
- **Nota:** a partir daqui os itens 34–36 podem rodar em paralelo com a Fase 8 se houver tempo.

### 34. Extrair `catalog` (ES) como serviço
`fase/7` `area/backend` `area/banco` `area/eventos`
- **Aceite:** schema + streams próprios; `event.creator_id` vira UUID sem FK cross-service; `creator_name` por projeção consumindo eventos do `identity` (ou composição no `gateway` — decisão da ADR); host auth valida JWT localmente.
- **Depende de:** #32

> **Implementado na branch `Issue-35` (2026-10-24), com o aceite reescrito** (spec `docs/superpowers/specs/2026-10-24-catalog-servico-design.md`):
> serviço `catalog` com schema, event store, outbox, snapshot e checkpoint próprios, sem FK cross-schema; `creator_id` **segue integer**
> (referência solta; UUID fica como evolução); `creator_name` **por composição no `gateway`** (lote ao `identity` + cache); o `gateway`
> segue validando JWT e host e o `catalog` autentica só por `X-Internal-Token` (JWT assimétrico + JWKS é a #36); `POST /bff/seed`
> desligado por padrão (`SEED_ENABLED`).

### 35. Extrair `identity` (Auth, MFA, reCAPTCHA, verificação de e-mail)
`fase/7` `area/backend` `area/banco` `seguranca`
- **Aceite:** schema próprio (CRUD, não ES); emite eventos de ciclo de vida; emite JWT; demais serviços validam JWT stateless (segredo compartilhado ou JWKS — decisão registrada); login/cadastro/MFA/troca de senha verdes ponta-a-ponta.
- **Depende de:** #34

### 36. `docker-compose.yml` (sem `admission`) + suíte de integração ponta-a-ponta
`fase/7` `area/infra` `area/backend`
- **Aceite:** compose com `gateway`, `identity`, `catalog`, `reservation`, `notification`, `supabase-*`, `kafka`/`redpanda`; `depends_on` + healthchecks; suíte de integração: cadastro → criar evento → reservar → confirmar → e-mail, com replay verificado.
- **Depende de:** #35

---

## Fase 8 — Teste de carga completo e limiar

### 37. Harness definitivo contra o sistema distribuído
`fase/8` `area/carga` `artigo`
- **Aceite:** cenários de escrita (reserva) e leitura (catálogo via projeção); coleta throughput sustentado, `pg_stat_statements`, lag write→projeção, lag de consumer, métricas do pooler; disparado da máquina/VM separada.
- **Depende de:** #36, #33

### 38. Relatório comparativo das 3 configurações
`fase/8` `area/carga` `artigo`
- **Aceite:** tabela + gráficos comparando monólito CRUD / monólito ES / distribuído ES em: no-overselling (corretude), throughput, latência p50/p95/p99, lag. É o resultado consolidado do TCC.
- **Depende de:** #37

### 39. Definir o limiar X definitivo (RPM por evento)
`fase/8` `area/carga` `artigo`
- **Aceite:** valor de X onde o fluxo síncrono degrada, com a justificativa dos números, documentado em `Architecture-Decision-Async-Checkout-Queue`.
- **Depende de:** #37

---

## Fase 9 — Serviço de admissão / alta carga

### 40. `admission`: contador RPM por evento em Redis
`fase/9` `area/backend` `area/infra`
- **Aceite:** `admission` no compose; janela deslizante por bucket (`INCR` + `EXPIRE`); expõe "RPM atual do evento X"; só sinal de carga.
- **Depende de:** #36, #39

### 41. `admission`: fila de admissão + worker pool
`fase/9` `area/backend` `area/infra`
- **Aceite:** fila por evento — RabbitMQ (`x-message-ttl` + dead-letter) ou tópico Kafka particionado, conforme ADR #25; worker pool com concorrência controlada.
- **Depende de:** #40

### 42. Integração do modo de alta carga
`fase/9` `area/backend`
- **Aceite:** uso ≥ 80% (uso = `RPM ÷ (X × réplicas ativas do reservation)`; com 1 réplica, `RPM ≥ 0,8·X`) → `admission` enfileira → worker chama a API interna de `reservation` (CAS) → `walletevent` `pending` + `expires_at = now + max_time_in_line` (snapshot); uso &lt; 80% → síncrono direto, voltando só com uso &lt; 70% e fila vazia. Testes dos dois regimes.
- **Depende de:** #41

### 43. UI de reserva `pending` no Flutter
`fase/9` `area/frontend`
- **Prioridade baixa.** Só depois de #42.
- **Aceite:** contagem regressiva até `expires_at` + botão "Confirmar" separado; tela "aguardando confirmação" quando passa pela fila; trata "Evento lotado" e `quantity == -1`.
- **Depende de:** #42

### 47. Autoescala de réplicas de `gateway` e `reservation` sob alta demanda
`fase/9` `area/infra` `area/backend` `area/carga` — issue #111
- **Aceite:** ADR curta escolhe o mecanismo (`docker compose --scale` + scaler lendo o RPM do `admission` vs. orquestrador com autoscaler); `gateway` e `reservation` sobem com N réplicas sem `container_name`/porta fixa, com balanceamento e contrato externo inalterado; réplicas sem estado em memória; job de expiração correto com 2+ réplicas; regra com uso = RPM ÷ (X × réplicas): > 50% sobe réplica em stand-by sem tráfego, > 80% redireciona (no `reservation`, para a fila, que entrega ao serviço já com a réplica nova; no `gateway`, direto à réplica), volta ao síncrono com &lt; 70% e fila vazia, scale-down com histerese, mín./máx. por env; mede se X cresce com réplicas ou se o gargalo é a linha do `eventcap`; conexões das réplicas cabem no Supavisor; escada de carga com autoescala ligada mantém overselling = 0 e registra réplicas × tempo.
- **Depende de:** #42, #39

### 48. Autoescala de `admission`, `identity`, `catalog` e `notification`
`fase/9` `area/infra` `area/backend` `area/eventos` `area/carga` — issue #112
- **Aceite:** mesmo mecanismo e regra do item 47; `admission` sem estado em memória e RPM correto com N réplicas; `identity` emite/valida JWT igual em todas as réplicas; `catalog` com leitura escalada e comando sob concorrência otimista sem evento duplicado; projetor do `catalog` e `notification` como consumer group escalado por lag, no máximo uma réplica por partição, idempotentes pelo id do evento; carga com todos escalando mantém overselling = 0, sem e-mail duplicado, e registra réplicas × tempo por serviço. Fora: Postgres, Redis, backbone.
- **Depende de:** #47

---

## Fase 10 — Entregáveis do artigo / fechamento

### 44. Fechar o material do artigo
`fase/10` `artigo`
- **Aceite:** coluna "Utilizada no Artigo" de `References.md` preenchida; prints do Studio; diagramas finais (monólito → microsserviços; síncrono vs fila; CQRS/ES command/evento/projeção; backbone Kafka); a série de 3 rodadas do experimento consolidada.
- **Depende de:** #38, #33

### 45. Atualizar os `README.md`
`fase/10` `area/infra`
- **Aceite:** README da raiz, de `Backend/`, `Backend/db/` e um por serviço, com a arquitetura final e comandos.
- **Depende de:** #36

---

## Fase 11 — Rodada futura (fora do escopo imediato)

### 46. Separar `reservation` em `stock` + `wallet` com saga
`fase/11` `area/backend`
- Condicionado a análise de trade-off (`Architecture-Decision-Microservices-Split`). Segue `Backend-Architecture` §3: checkout → `stock` (síncrono) → grava `wallet` depois; compensação idempotente + reaper de decrementos órfãos.
- **Depende de:** #32

---

## Espinha de dependências (resumo)

```
F0:  1 → 4 …          2 (solto)          3 → 10
F1:  4 → 5 → 6        4 → 7              4 + 5 → 8
F2:  4 + 6 → 9        3 + 9 → 10 → 11 → 12       11 → 13       12 + 13 → 14   ◄ ENTREGA PRINCIPAL
F3:  15 (solto)
F4:  15 → 16 → 17 → 18            17 → 19, 20        18 + 12 → 21
F5:  4 → 22 → 24                  6 + 22 → 23
F6:  22 → 25 → 26 → 27, 28 → 29   (20 trava 27/28; 23 trava 28)     29 + 21 → 30
F7:  24 + 26 + 29 → 31 → 32 → 33          32 → 34 → 35 → 36
F8:  36 + 33 → 37 → 38            37 → 39
F9:  36 + 39 → 40 → 41 → 42 → 43       42 + 39 → 47 → 48
F10: 38 + 33 → 44                 36 → 45
F11: 32 → 46
```

## Caminho crítico até o resultado de banca

`1 → 4 → 6 → 9 → 10 → 11 → 12` (7 issues). O resto da Fase 2 (13, 14) consolida.
Esse marco foi atingido em 2026-10-16. A Fase 4 (Supabase, itens 16–20) entrou em seguida e o item 21 refaz o
experimento como ponto 1 da série; ES/microsserviços vêm **depois**.
