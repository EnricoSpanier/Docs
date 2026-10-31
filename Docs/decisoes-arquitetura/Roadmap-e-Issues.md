---
sidebar_position: 9
sidebar_label: "Roadmap e Issues"
tags: [roadmap, backlog, issues, planejamento]
---

# Roadmap e Issues — decomposição em 46 tarefas iterativas

Decomposição da documentação de arquitetura em issues **iterativas e progressivas**:
cada uma é uma fronteira onde, após o merge, `docker compose up` + a suíte de testes
continuam verdes e o contrato servido ao Flutter não muda.

## Onde vive

- **Repo:** `E:\TCC\GerenciadorEventos\BACKLOG.md` (commit `674d305`) — texto completo com
  critérios de aceite e espinha de dependências.
- **GitHub:** `endydragonn/GerenciadorEventos` **issues #2–#47**. Mapa: item N do backlog =
  issue **#(N+1)**. Labels `fase/0`…`fase/11`, `area/{backend,banco,infra,frontend,eventos,carga}`,
  `artigo`, `seguranca`, `bloqueado/docker`.

## Decisões de arquitetura que o backlog materializa

- Back-end decomposto em microsserviços, **Opção B** — `gateway`, `identity`, `catalog`,
  `reservation`, `notification`, `admission`. Ver [Architecture-Decision-Microservices-Split](./Architecture-Decision-Microservices-Split.md).
- `reservation` = Capacity + Wallet no mesmo serviço (híbrido CAS + ES); split com saga é
  rodada futura (issue #47). Ver [Backend-Architecture](./Backend-Architecture.md) §3.
- **CQRS + Event Sourcing no escopo** (não é mais "outra rodada"): ES em `catalog` e no lado
  wallet de `reservation`; `eventcap`/CAS relacional; `identity` CRUD; `notification`
  consumidor. Backbone **Kafka-compatível**; RabbitMQ para admissão
  ([Architecture-Decision-Async-Checkout-Queue](./Architecture-Decision-Async-Checkout-Queue.md)); Redis para sinal de carga.
- Camada de banco: **Supabase self-hosted enxuto** ([Architecture-Decision-Supabase-Self-Host](./Architecture-Decision-Supabase-Self-Host.md)).

## De-risking do experimento (feedback do orientador, 2026-09-02)

O braço de controle — "checar disponibilidade via read model defasado ⇒ oversella" — é o
diferencial do TCC. Foi antecipado para a **Fase 2**, contra o monólito atual, com um read
model defasado sintético (issue #10 → braço de controle na **issue #13**). Depois re-roda a
cada marco de arquitetura, virando uma série de 3 pontos:

| Rodada | Contra | Issue |
|---|---|---|
| 1 | monólito CRUD (read model sintético) | #12/#13, refeita em #22 |
| 2 | monólito com CQRS+ES (projeção real) | #31 |
| 3 | distribuído (`reservation` e `notification` como serviços; o `catalog` virou serviço depois, #35, só com A/B local sem rodada de carga) | #34 |

Comparação consolidada das 3 configurações: issue #39. Geração de carga roda de
**máquina/VM separada** (issue #4).

**Caminho crítico até um resultado defensável na banca:** issues #2 → #5 → #7 → #10 → #11 →
#12 → #13 (7 issues). Tudo de Supabase/ES/microsserviços vem depois.

## Fases (0–11)

| Fase | Tema | Issues (GitHub) |
|---|---|---|
| 0 | Desbloqueio de ambiente (Docker, vendorizar ADRs, máquina de carga) | #2–#4 |
| 1 | Verificar a implementação EventCap/CAS de 2026-09-01 | #5–#9 |
| 2 | **Experimento vs. monólito — entrega principal** | #10–#15 |
| 3 | Higiene de segredos (`.env` fora do git) | #16 |
| 4 | Camada de banco: Supabase enxuto + re-rodar experimento pós-pooler | #17–#22 |
| 5 | Preparar a decomposição (pacotes-por-serviço, idempotency, `gateway`) | #23–#25 |
| 6 | CQRS + Event Sourcing nos módulos do monólito + 2ª rodada | #26–#31 |
| 7 | Extração incremental dos serviços (strangler) + 3ª rodada | #32–#37 |
| 8 | Teste de carga completo + comparação das 3 configs + limiar X | #38–#40 |
| 9 | Serviço de admissão / alta carga + UI `pending` (front, baixa prio) | #41–#44 |
| 10 | Entregáveis do artigo / fechamento | #45–#46 |
| 11 | Rodada futura: split `stock` + `wallet` com saga | #47 |

## Estado (2026-10-26)

Detalhe completo (feito, testado, pendências em tabela) em [Validacao-e-Pendencias-2026-10-26](./Validacao-e-Pendencias-2026-10-26.md).

| Fase | Situação |
|---|---|
| 0–2 | **Fechadas** (#2–#14). #15 (seção do artigo) aberta: rascunho pronto, revisão com o orientador pendente. |
| 3 | #16 aberta, **pulada pelo usuário** (2026-10-16). |
| 4 | #17–#22 **fechadas** (Supabase enxuto + pooler; ponto 1 da série). |
| 5 | #23–#25 **fechadas** (módulos + ArchUnit, idempotência, `gateway`). |
| 6 | #26–#31 **fechadas** (CQRS + ES; ponto 2 da série). |
| 7 | #32 (`notification`), #33 (`reservation`), #35 (`catalog`) **fechadas** (PRs #152, #153, #157; `Fase_7` no `main` pelo #156). #34 (Rodada 3, ponto 3) **fechada em 2026-10-26**, resultado em `results/05-distribuido`. |
| 8–11 | abertas: #36 (`identity`), #37–#40, #41–#44, #45–#47, #111, #112. |

**Caminho crítico:** próximo é #36 (`identity`) → #37 (compose + integração) → #38 (harness definitivo).

**Testes:** 325 testes Maven, 0 falhas (Surefire de 2026-10-24); não reexecutados no `main` atual (Docker parado).

## Histórico — estado em 2026-10-02

Snapshot do GitHub (`endydragonn/GerenciadorEventos`). `BACKLOG.md` ganhou a mesma tabela
(seção "Estado (2026-10-02)"); o texto de cada item não mudou.

| Fase | Situação |
|---|---|
| 0 | #2 (Docker) e #3 (ADRs em `docs/adr/`) **fechadas**. **#4 (máquina de carga) aberta**: kit de scripts já está no `main` (PR #90, `Projeto/carga/`: disputa de vagas + taxa fixa/RPM, host e gerador); falta provisionar a 2ª máquina, medir a latência base de rede e registrar (PR #76 em draft). |
| 1 | #5, #6, #7, #8, #9 **fechadas** (PRs #55, #65, #66/#68, #70, #73): EventCap/CAS compilado e testado, migration idempotente, constraints, job de expiração e roteiro manual de overselling. |
| 2 | #10 (read model defasado sintético) **fechada** (PR #75). **#11 (harness) aberta**: harness mergeado (PR #82, `docs/carga/harness/`), mas ainda não rodou de outra máquina (depende da #4). #12–#15 abertas. |
| 3–11 | abertas (#16–#47). |

**Caminho crítico:** #2 → #5 → #7 → #10 feitas; próximo #11 → #12 → #13.

**Follow-ups fora do backlog:** #56–#61 (`updatePolicy`, IDOR em
`/bff/event-wallets`, endurecer schema, cobertura, transações do `updateEvent`, N+1 sem pool),
#81, #84, #89 abertas; #67, #78 (BFF única + JWT deny-by-default, PR #79), #83 (quality gates
Checkstyle/ArchUnit, PR #85), #86 (PR #88), #92 (`/actuator/health`, PR #93) fechadas.

**Atenção:** o roteiro manual `docs/testes-manuais/overselling-sob-concorrencia.sh` foi escrito
antes da PR #79 e ainda não envia JWT — adaptação pendente (ver o aviso no `.md`).

## Histórico — estado em 2026-09-02

- Issues #2–#47 criadas.
- `BACKLOG.md` commitado e pushado para `origin/main` (`674d305`).
- Implementação EventCap/CAS de 2026-09-01 **deixada sem commit de propósito** no working
  tree — ver [Implementacao-EventCap-e-Reserva-CAS](./Implementacao-EventCap-e-Reserva-CAS.md). Decisão do autor: o commit acontece no
  fluxo da issue #5 (verificar: compilar + testar), idealmente via branch/PR.

## Relacionado

- [_Event-Management-System](./visao-geral.md)
- [Architecture-Decision-Microservices-Split](./Architecture-Decision-Microservices-Split.md)
- [Implementacao-EventCap-e-Reserva-CAS](./Implementacao-EventCap-e-Reserva-CAS.md)
- [Backend-Architecture](./Backend-Architecture.md)
- [Database-Schema](./Database-Schema.md)
- [Architecture-Decision-Stock-Isolation](./Architecture-Decision-Stock-Isolation.md)
- [Architecture-Decision-Async-Checkout-Queue](./Architecture-Decision-Async-Checkout-Queue.md)
- [Architecture-Decision-Supabase-Self-Host](./Architecture-Decision-Supabase-Self-Host.md)
- [References](./References.md)


---

*Sincronizado automaticamente de `Roadmap-e-Issues.md` em 2026-10-30T19:11:52.869Z.*
