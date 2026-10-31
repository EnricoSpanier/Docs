---
sidebar_position: 1
sidebar_label: "Visão Geral"
tags: [project]
---

# Event Management System

## Objetivo
Sistema de gerenciamento de eventos (palestras, shows, workshops) com back-end em Java/Spring Boot + PostgreSQL e front-end em Flutter, usado como caso de teste real de uma estrutura de banco mais genérica: **marketplace com estoque/capacidade isolado** (qualquer item vendável com quantidade limitada — produto, vaga, assento, cota). A estrutura de dados não deve ficar presa ao domínio de eventos.

## Estado atual
- Documentação original do sistema (back-end + front-end) mapeada a partir do README do projeto.
- Padrão de arquitetura "estoque isolado" (CQRS+ES híbrido) definido em [Backend-Architecture](./Backend-Architecture.md) e aplicado ao caso real de capacidade de ingressos do evento.
- Schema de banco (DBML) refinado em [Database-Schema](./Database-Schema.md): `EventCap` isolado como agregado próprio, com `UPDATE` condicional atômico protegendo a invariante `0 <= quant <= capacity`.
- Decisão tomada: `buy_time_limit` fica em `EventCap` (junto de `capacity`/`quant`), não em `Event` — mantém toda a regra "posso vender?" coesa num único agregado, mesmo divergindo do README original.
- [Decisão de arquitetura](./Architecture-Decision-Stock-Isolation.md) documentada em termos genéricos de marketplace (não presa a eventos), com estrutura, vantagens, desvantagens e referências externas que ancoram a escolha.
- Modo de alta carga definido em [Architecture-Decision-Async-Checkout-Queue](./Architecture-Decision-Async-Checkout-Queue.md): RPM por evento (Redis) acima de um limiar X ativa (1) fila de admissão + worker pool e (2) reserva com expiração (`WalletEvent.pending` + `expires_at`). Virou o serviço `admission`.
- **Implementado no código (2026-09-01):** `eventcap` e `eventpresenter` como tabelas isoladas, reserva por `UPDATE` condicional atômico, máquina de estados `walletevent` (`pending → confirmed / expired / cancelled`) com job `@Scheduled` de expiração, `capacity = -1` = ilimitado, `buy_time_limit` default = data do evento. Detalhes em [Implementacao-EventCap-e-Reserva-CAS](./Implementacao-EventCap-e-Reserva-CAS.md). **Verificado e mergeado em 2026-09** (issues #5–#9; PRs #55, #65, #66/#68, #70, #73) — estado atual em [Roadmap-e-Issues](./Roadmap-e-Issues.md).
- **Arquitetura definida em 2026-09-02:**
  - Back-end decomposto em **microsserviços, Opção B** — `gateway`, `identity`, `catalog`, `reservation` (híbrido CAS+ES), `notification`, `admission`. Ver [Architecture-Decision-Microservices-Split](./Architecture-Decision-Microservices-Split.md).
  - **CQRS + Event Sourcing entrou no escopo** (não é mais "outra rodada"): ES em `catalog` e no lado wallet de `reservation`; `eventcap`/CAS relacional; `identity` CRUD. Backbone **Kafka-compatível** (Kafka/Redpanda); RabbitMQ para admissão; Redis para sinal de carga.
  - **Roadmap:** [Roadmap-e-Issues](./Roadmap-e-Issues.md) — 46 tarefas em 12 fases, criadas como issues **#2–#47** em `endydragonn/GerenciadorEventos` (item N do backlog = issue #N+1). `BACKLOG.md` commitado no `main`.
  - **De-risking do orientador:** o experimento diferencial (braço de controle "checar via read model defasado ⇒ oversella") roda cedo, contra o monólito (Fase 2), e re-roda a cada marco — série de 3 pontos. Geração de carga em máquina/VM separada.
  - `gh` CLI autenticado como EnricoSpanier. Docker Desktop instalado (issue #2 fechada); Maven/JDK rodam em container (`run-tests.sh`).
- **Estado em 2026-10-02:** Fases 0–1 e a #10 da Fase 2 fechadas, exceto a **#4 (máquina de carga)**, cujo kit de scripts (`Projeto/carga/`, PR #90) já está no `main` mas ainda não foi usado numa 2ª máquina. **#11 (harness)** mergeado (PR #82), aberta até rodar de outra máquina. Desde a PR #79 todo `/bff/**` exige JWT (exceto login/cadastro/`GET /bff/events/**`/`POST /bff/seed`/`/actuator/health`). Quadro completo em [Roadmap-e-Issues](./Roadmap-e-Issues.md).

- **Estado em 2026-10-26:** Fases 0–2, 4, 5, 6 e 7 (`notification`, `reservation`, `catalog` como serviços) fechadas; a Rodada 3 (#34, ponto 3 da série) foi fechada em 2026-10-26, com resultado em `Projeto/carga/results/05-distribuido`. Fase 3 (#16, segredos) pulada pelo usuário. **325 testes Maven, 0 falhas** (Surefire de 2026-10-24; não reexecutados no `main` atual). Falta `identity` como serviço (#36), compose + integração (#37), harness/relatório/limiar X definitivos (#38–#40), `admission` (#41–#43), autoescala (#111, #112) e fechamento do artigo. Tabela em [Validacao-e-Pendencias-2026-10-26](./Validacao-e-Pendencias-2026-10-26.md).

## Próximos passos

**A lista de tarefas agora vive em [Roadmap-e-Issues](./Roadmap-e-Issues.md) / `BACKLOG.md` (issues #2–#47).**
Caminho crítico até um resultado de banca: issues #2 → #5 → #7 → #10 → #11 → #12 → #13.

Histórico do que já estava decidido/feito antes do roadmap:
- [x] Decidir CQRS+ES completo vs. só CAS — **decisão de 2026-08 (só CAS) REVISTA em 2026-09-02**: CQRS+ES está no escopo (issues #26–#31).
- [x] `EventPresenter` como tabela filha — feito em [Implementacao-EventCap-e-Reserva-CAS](./Implementacao-EventCap-e-Reserva-CAS.md).
- [x] Job de expiração `pending` (`ReservationExpiryService`, `@Scheduled`) — feito e verificado (issue #8, PR #70).
- [x] Decompor a documentação em issues iterativas — feito 2026-09-02 (issues #2–#47).

## Notas
- [Plano de 2 batches até 03–04/11 (escopo, ordem, cortes)](./Plano-2-Batches-ate-04-11.md)
- [Validação do estado (feito/testado) e tabela de pendências (2026-10-26)](./Validacao-e-Pendencias-2026-10-26.md)
- [Resultados dos testes de carga (2026-10-04) — disputa, RPM, aleatório, pool Hikari](../testes/pre-serie/resultados-de-carga.md)
- [Roadmap e Issues — 46 tarefas iterativas (GitHub #2–#47)](./Roadmap-e-Issues.md)
- [Implementação (sessão 2026-09-01) — o que mudou no código](./Implementacao-EventCap-e-Reserva-CAS.md)
- [Decisão: back-end decomposto em microsserviços (Opção B, não implementado)](./Architecture-Decision-Microservices-Split.md)
- [Decisão: Supabase self-hosted enxuto (não implementado)](./Architecture-Decision-Supabase-Self-Host.md)
- [Referências (tema + onde é usada cada uma)](./References.md)
- [Decisão de arquitetura (genérico, marketplace)](./Architecture-Decision-Stock-Isolation.md)
- [Fila assíncrona + reserva com expiração](./Architecture-Decision-Async-Checkout-Queue.md)
- [Backend-Architecture](./Backend-Architecture.md)
- [Database-Schema](./Database-Schema.md)

## Relacionado


---

*Sincronizado automaticamente de `_Event-Management-System.md` em 2026-10-30T19:11:52.870Z.*
