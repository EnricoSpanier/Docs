---
sidebar_position: 999
tags: [validacao, testes, pendencias, roadmap, estado]
---

# Validação do estado e pendências (2026-10-26)

Conferência do que está **feito** e do que está **testado** contra o repositório (`E:\TCC\GerenciadorEventos`,
`main` em `3905161`), o GitHub (`gh`) e os relatórios do Surefire. Substitui, para fins de estado atual, o
snapshot de 2026-10-02 de [Roadmap-e-Issues](./Roadmap-e-Issues.md). Numeração: **item N do backlog = issue #(N+1)**; as tabelas abaixo usam o número da issue.

## 1. O que está feito

| Fase | Issues | Situação | Evidência |
|---|---|---|---|
| 0 — ambiente | #2, #3, #4 | Fechadas | Docker, ADRs em `docs/adr/`, gerador provisionado e latência base medida (HTTP; ICMP bloqueado) |
| 1 — EventCap/CAS | #5–#9 | Fechadas | PRs #55, #65, #66/#68, #70, #73; migration idempotente, constraints, job de expiração, roteiro manual |
| 2 — experimento vs. monólito | #10–#14 | Fechadas | Runner `Projeto/carga`, matriz CAS × ingênuo e escada X em `results/02-hikari` (PRs #82, #104, #114, #115) |
| 3 — segredos | #16 | **Pulada pelo usuário** (2026-10-16) | `.env` fica como está até o fim do TCC |
| 4 — Supabase enxuto | #17–#22 | Fechadas | `supabase-db`, Supavisor, Studio, schema-per-service; ponto 1 da série (`results/03-supabase-pooler`) |
| 5 — decomposição interna | #23–#25 | Fechadas | Módulos + ArchUnit, `Idempotency-Key`, módulo `gateway` (PRs #127, #128, #132, #134) |
| 6 — CQRS + ES | #26–#31 | Fechadas | ADR Redpanda, event store + outbox, `catalog` e wallet em ES; ponto 2 da série (`results/04-fase6-es`, `04b-fase6-es-cabo`) |
| 7 — extração de serviços | #32 `notification`, #33 `reservation`, #35 `catalog` | Fechadas | PRs #152, #153, #157 (`Fase_7` → `main` pelo #156, 2026-10-25) |
| 7 — Rodada 3 | #34 | **Fechada em 2026-10-26** | `results/05-distribuido` (X ≈ 58k, CAS com overselling 0) e `docs/artigo/experimento-monolito.md` |

Compose atual: `db` (supabase), `redpanda`, `backend` (monólito/gateway), `catalog`, `reservation`, `notification`, `frontend`.
Não existem `identity` como serviço, `admission`, Redis nem RabbitMQ.

## 2. O que está testado

**Suíte Maven: 325 testes, 0 falhas, 0 erros, 0 ignorados** (relatórios Surefire de 2026-10-24 21:11, reator completo).

| Módulo | Testes | Cobre |
|---|---|---|
| `catalog` | 57 | E2E da API (14), event sourcing, constraints, busca, schema, indisponibilidade do cliente |
| `reservation` | 96 | CAS, caminho naive, projeção de disponibilidade, idempotência (+retenção), expiração, replay, máquina de estados, E2E da API (21) |
| `notification` | 16 | consumer idempotente, rejeição permanente |
| `monolito` + `shared` | 156 | contrato HTTP (37), `UserTest` (15), fronteiras ArchUnit (13), event store/outbox/replay/consumer idempotente, pool Hikari, Tomcat, seed desligado |

Também validado fora do Maven: baterias de carga (disputa, RPM, aleatório) com overselling 0 no CAS e > 0 no braço naive nas disputas ([Resultados-Testes-de-Carga](../testes/pre-serie/resultados-de-carga.md)), e os três pontos da série em `Projeto/carga/results/`.

**Ressalvas da validação**

- Não consegui reexecutar a suíte agora: o Docker Desktop está parado no PC. O relatório de 10-24 é da branch `Issue-35` e **antecede** os merges #156/#157 no `main`.
- Os `smoke-*-servico-separado.sh` (#33, #35) existem e estão documentados, mas não achei registro de execução.

## 3. O que falta implementar e testar

### 3.1 Backlog principal

| Issue | Tema | Falta implementar | Falta testar | Depende de |
|---|---|---|---|---|
| #36 | `identity` como serviço | Módulo próprio com schema, emissão de JWT, validação stateless nos demais | Login, cadastro, MFA e troca de senha ponta a ponta; JWT validado por cada serviço | #35 ✔ |
| #37 | Compose completo | `identity` e `gateway` separados, healthchecks e `depends_on` | Suíte de integração: cadastro → criar evento → reservar → confirmar → e-mail, com replay; automatizar os 2 smokes | #36 |
| #38 | Harness definitivo | Cenários de leitura via projeção, coleta de `pg_stat_statements`, lag e métricas do pooler | Rodada completa a partir do gerador | #37, #34 |
| #39 | Comparativo das 3 configurações | Consolidar tabelas e gráficos (dados já existem em `results/03`, `04`, `05`) | — | #38 |
| #40 | Limiar X definitivo | Registrar na ADR da fila (X preliminar ≈ 78k pelo pooler, ≈ 58k distribuído) | Escada final no sistema completo | #38 |
| #41 | `admission`: contador RPM | Serviço + Redis (janela deslizante) | Contagem sob concorrência | #37, #40 |
| #42 | `admission`: fila + workers | Fila (RabbitMQ ou Kafka) e pool de workers | Concorrência controlada, TTL e dead-letter | #41 |
| #43 | Modo de alta carga | Regra 80% / 70% com histerese, `pending` + `expires_at` | Os dois regimes e a transição | #42 |
| #44 | UI `pending` (Flutter) | Contagem regressiva e botão Confirmar | Testes de widget (o front não tem pasta `test`) | #43 (baixa prioridade) |
| #111 | Autoescala `gateway` + `reservation` | ADR do mecanismo, réplicas sem estado | Escada com autoescala mantendo overselling 0 | #43, #40 |
| #112 | Autoescala dos demais serviços | Mesmo mecanismo | Sem e-mail duplicado, overselling 0 | #111 |
| #45 | Material do artigo | `References.md`, prints do Studio, diagramas finais | — | #39, #34 |
| #15 | Seção da Fase 2 | Revisão com o orientador (rascunho pronto) | — | — |
| #46 | READMEs | Raiz, `Backend/`, `db/` e um por serviço | — | #37 |
| #47 | `stock` + `wallet` com saga | Rodada futura, fora do escopo imediato | — | #33 ✔ |

### 3.2 Follow-ups abertos fora do backlog

| Issue | Assunto | Tipo |
|---|---|---|
| #56 | `updatePolicy`: ilimitado → limitado zera inscrições (overselling) | Bug + teste |
| #57 | `/bff/event-wallets*` tira `userId` do corpo, não do JWT (IDOR) | Segurança + teste |
| #58 | Endurecer schema `eventcap`/`walletevent` (timestamptz, índices de FK, CHECK) | Banco |
| #59 | `SchemaValidationTest` é subconjunto; migração `20260901` sem teste | Teste |
| #60 | `updateEvent` em 3 transações independentes | Bug + teste |
| #61 | N+1 no `hydrate`; `findExpiredPending` sem LIMIT | Performance |
| #81 | `BffUserController` vaza mensagem de `SQLException` | Segurança |
| #84 | `analysis_options.yaml` do frontend (flutter_lints) | Qualidade |
| #89 | Restringir `/bff/seed` a dev/test (parcial: `SEED_ENABLED` + `SeedDesligadoTest`) | Segurança |
| #113 | Escada de degraus com `MAPEAMENTO=intercalado` | Carga |
| #133 | CORS aceita qualquer origem com credenciais | Segurança |

### 3.3 Lacunas transversais de teste

| Lacuna | Ação |
|---|---|
| Suíte não reexecutada no `main` atual | Subir o Docker Desktop e rodar `Projeto/Backend/run-tests.sh` |
| Nenhum workflow roda `mvn test` (só Gemini reviewer, Telegram, `implementado`, `resumo`) | Criar workflow de CI com a suíte |
| Frontend Flutter sem nenhum teste | Criar `test/` junto com #84 |
| `docs/testes-manuais/overselling-sob-concorrencia.sh` não envia JWT (pós-#79) | Adaptar o roteiro |
| Smokes #33 e #35 sem registro de execução | Rodar com a stack inteira e `SEED_ENABLED=true`, registrar o resultado |
| Sem teste de integração entre os serviços (só E2E por serviço) | Coberto por #37 |

## 4. Plano até 03–04/11

Cronograma, escopo e regras de corte em 2 batches: [Plano-2-Batches-ate-04-11](./Plano-2-Batches-ate-04-11.md).

## Relacionado

- [Roadmap-e-Issues](./Roadmap-e-Issues.md)
- [Resultados-Testes-de-Carga](../testes/pre-serie/resultados-de-carga.md)
- [_Event-Management-System](./visao-geral.md)
- [Implementacao-EventCap-e-Reserva-CAS](./Implementacao-EventCap-e-Reserva-CAS.md)
- [Architecture-Decision-Async-Checkout-Queue](./Architecture-Decision-Async-Checkout-Queue.md)


---

*Sincronizado automaticamente de `Validacao-e-Pendencias-2026-10-26.md` em 2026-10-30T19:11:52.869Z.*
