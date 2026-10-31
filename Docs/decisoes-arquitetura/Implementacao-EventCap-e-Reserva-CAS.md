---
sidebar_position: 8
sidebar_label: "Implementação: EventCap + CAS"
tags: [implementation, changelog, eventcap, cas, database, backend, frontend]
---

# Implementação — EventCap isolado + reserva com CAS

Registro da sessão de implementação que tirou do papel as decisões de
[Backend-Architecture](./Backend-Architecture.md), [Database-Schema](./Database-Schema.md) e [Architecture-Decision-Async-Checkout-Queue](./Architecture-Decision-Async-Checkout-Queue.md)
(a parte de baixa/média carga). Código em `E:\TCC\GerenciadorEventos\Projeto\`.

> **Nota (2026-09-02):** este é um changelog histórico — descreve o que foi feito em
> 2026-09-01, não o estado alvo. As decisões evoluíram: microsserviços + CQRS/ES entraram no
> escopo ([Architecture-Decision-Microservices-Split](./Architecture-Decision-Microservices-Split.md)), o roadmap virou 46 issues
> ([Roadmap-e-Issues](./Roadmap-e-Issues.md), GitHub #2–#47). **[Atualização 2026-10-02: este código já foi verificado e mergeado — issue #5/PR #55 (compilar + testar), #6 migration, #7 constraints, #8 job de expiração, #9 teste manual de overselling.]** Na época, continuava sem commit no working tree;
> a **issue #5** era verificá-lo (compilar + testar) — concluída.

## Escopo definido com o autor

- **Schema novo + reserva com CAS + job `@Scheduled`.** Sem RabbitMQ/Redis.
- Migração: **reescrever os `init-scripts`** + **script de migração idempotente** para banco
  já existente. **Sem `docker compose down -v` obrigatório**, sem Flyway.
- **Sem** CQRS+ES *nesta sessão de implementação* — mantém o CRUD JDBC atual. (Revisado em 2026-09-02: CQRS+ES entrou no escopo do TCC e deve preceder o teste de carga — ver [Architecture-Decision-Microservices-Split](./Architecture-Decision-Microservices-Split.md) e o `BACKLOG.md` do repo.)
- Inscrição em **dois passos**: reservar (`pending` + `expires_at`) → confirmar.

## Modelo de dados

### `event` (enxugada)
Perdeu `capacity`, `quant`, `buy_time_limit`. Só metadados: `event_id`, `creator_id`,
`event_name`, `ead`, `address`, `event_date`, `description`, `image_data`, timestamps.

### `eventcap` (nova) — agregado isolado
`event_id` (PK, FK→event `ON DELETE CASCADE`), `capacity`, `quant` (vagas disponíveis),
`buy_time_limit`, `max_time_in_line` (segundos, default 120), timestamps.
- CHECK `eventcap_quant_bounds`: `capacity = -1 OR (0 <= quant <= capacity)`.
- **Regra de ilimitado:** `capacity = -1` ⇒ sem limite de vendas; `quant = -1` também.
  Nesse caso o CAS não se aplica (a query traz `AND capacity <> -1`) e o serviço libera
  a reserva direto.
- Reserva (evento limitado): `UPDATE eventcap SET quant = quant - 1 WHERE event_id = ?
  AND capacity <> -1 AND quant >= 1` — `rowcount = 0` ⇒ lotado.
- Liberação: `... SET quant = quant + 1 WHERE event_id = ? AND capacity <> -1 AND quant < capacity`.

### `eventpresenter` (nova)
`(event_id, presenter_name)` PK composta, FK→event `ON DELETE CASCADE`. Substitui o antigo
campo único `presenters` (que nem era persistido).

### `walletevent` (máquina de estados)
Ganhou `status` (`confirmed` | `pending` | `expired` | `cancelled`, default `confirmed`,
CHECK) e `expires_at` (só quando `pending`). Índice parcial `idx_walletevent_pending_expires`.
PK segue `(user_id, event_id)`; o insert virou UPSERT que revive linhas `expired`/`cancelled`.

### Regras de negócio novas
- **Capacidade obrigatória na criação:** `>= 1` (fixa) ou `-1` (ilimitado).
- **`buy_time_limit` não informado ⇒ data do evento** — aplicado no `createEvent` **e** no
  `updateEvent` (`EventService.applyDefaults`).
- Reduzir a capacidade abaixo do já vendido é rejeitado (bate no CHECK → HTTP 400).

## Fluxo de reserva (2 passos)

1. `POST .../event-wallets` → valida janela de compra + duplicidade, então numa **transação**:
   `tryReserve` (CAS) → se falhar, rollback + "Evento lotado"; se ok, grava `walletevent`
   `pending` com `expires_at = now + max_time_in_line`.
2. `POST .../event-wallets/confirm` → `pending → confirmed`.
3. `DELETE .../event-wallets` (cancelar) → `cancelled` + devolve a vaga, numa transação.
4. `ReservationExpiryService` — `@Scheduled` (default 30s, `@EnableScheduling` em
   `config/SchedulingConfig`): varre `pending` vencidas e, por transação, `expireIfStale`
   (condicional, não pisa em confirmação concorrente) + `release`.

Compensação em caso de falha = `rollback` da transação (o decremento é desfeito
automaticamente; não há compensação manual).

## Arquivos

### Banco — `Projeto/Backend/db/`
- `init-scripts/` reescritos e renumerados: `03-event` · **`04-eventcap`** ·
  **`05-eventpresenter`** · `06-mywallet` · `07-walletevent` · `08-pending-verifications` · `99-tests`.
- **`migrations/20260901-eventcap-isolation.sql`** (novo) — idempotente, via `psql`.
- `seed-data.sql` e `99-tests.sql` atualizados (CAS, CHECK, cascata, evento ilimitado).

### Backend — `Projeto/Backend/src/main/java/com/gerenciador/eventos/`
| Novo | Alterado |
|---|---|
| `POJO/EventCap.java` (const `UNLIMITED = -1`, `isUnlimited()`) | `POJO/EventWallet.java` (+`status`, +`expiresAt`) |
| `Repository/EventCapRepository.java` | `Repository/EventRepository.java` (save transacional; sem `capacity`/`quant` em `event`) |
| `Repository/EventPresenterRepository.java` | `Repository/EventWalletRepository.java` (`reservePending` UPSERT, `confirm`, `expireIfStale`, `findExpiredPending`) |
| `Service/ReservationExpiryService.java` | `Service/EventService.java` (`hydrate`, `applyDefaults` no update, capacidade `-1`) |
| `config/SchedulingConfig.java` (`@EnableScheduling`) | `Service/EventWalletService.java` (reserva transacional, `confirm`, cancelamento devolve vaga) |
| | `Controller/EventWalletController.java` + BFF (`/confirm`), `Controller/EventController.java`, `Controller/SeedController.java`, `bff/BffApplication.java` |

### Testes — `Projeto/Backend/src/test/`
`SchemaValidationTest`, `GlobalDbTruncator`, `EventTest`, `EventWalletTest` atualizados;
**`ReservationExpiryTest`** novo. Cobrem: CAS decrementa, "lotado", confirm, cancelamento
devolve vaga, evento ilimitado não debita, job expira e devolve vaga, `buy_time_limit`
default no update.

### Frontend — `Projeto/frontend/lib/telas/`
- `telaCriacaoEvento` / `telaEdicaoEvento`: capacidade sempre enviada (vazio ⇒ `-1`);
  `buy_time_limit` vazio ⇒ `null` (backend iguala à data do evento).
- `telaInscricaoEvento`: chama `/event-wallets` e depois `/event-wallets/confirm` no mesmo
  clique; trata "Evento lotado"; `quantity == -1` ⇒ "Vagas ilimitadas".
- `telaGerenciarEventos`: mostra o status da reserva na aba "Inscritos".

### Docs
`CLAUDE.md` da raiz, de `Backend/` e de `Backend/db/` atualizados.

## O que NÃO foi feito

- **Camada de alta carga**: contador RPM em Redis, fila RabbitMQ, worker pool — continua
  só proposta em [Architecture-Decision-Async-Checkout-Queue](./Architecture-Decision-Async-Checkout-Queue.md).
- **CQRS + Event Sourcing** completo — não feito nesta sessão. (Não é mais "outra rodada": virou pré-requisito do teste de carga no TCC — ver [Architecture-Decision-Microservices-Split](./Architecture-Decision-Microservices-Split.md).)
- **UI de contagem regressiva** com botão "Confirmar" separado: o front faz reserva +
  confirmação em sequência no mesmo clique (o padrão CAS é exercitado, mas não fica reserva
  `pending` viva na tela). O job de expiração é demonstrável via teste manual (curl reserva
  sem confirmar → job devolve a vaga).
- Atualização dos `README.md` do projeto.

## Estado de verificação

**(Histórico de 2026-09-02 — hoje já verificado, ver a nota no topo.)** Na época, **nada foi compilado nem testado.** A máquina de desenvolvimento não tem Docker, Maven, JDK
nem Flutter (tudo roda em container) — `gh` foi instalado em 2026-09-02, o resto não.
A verificação é a **issue #5** ([Roadmap-e-Issues](./Roadmap-e-Issues.md)); o commit deste código acontece no
fluxo dela (idealmente branch/PR). Para validar:

```bash
docker compose -f Projeto/docker-compose.yml down -v   # ou aplicar a migration
docker compose -f Projeto/docker-compose.yml up -d --build
docker exec -i gerenciador-db psql -U admin -d meu_banco -f /docker-entrypoint-initdb.d/99-tests.sql
Projeto/Backend/run-tests.sh
```

Teste manual de overselling: evento `capacity = 1`, dois `POST /api/bff/event-wallets`
quase simultâneos → um `pending`, o outro "Evento lotado".

## Pendência de segurança (fora do escopo)

`Projeto/.env` está **commitado no git** com segredos reais (senha do Postgres, `JWT_SECRET`,
senha de app do Gmail, chaves reCAPTCHA). O `.gitignore` que o excluiria não está commitado.
Recomendado: `git rm --cached Projeto/.env`, commitar o `.gitignore` e **rotacionar** esses
segredos (estão no histórico). É a **issue #16** ([Roadmap-e-Issues](./Roadmap-e-Issues.md)), pré-requisito do
Supabase.

## Relacionado

- [_Event-Management-System](./visao-geral.md)
- [Decisões que evoluíram desta sessão](./Architecture-Decision-Microservices-Split.md)
- [Issue #5 verifica este código](./Roadmap-e-Issues.md)
- [Backend-Architecture](./Backend-Architecture.md)
- [Database-Schema](./Database-Schema.md)
- [Architecture-Decision-Stock-Isolation](./Architecture-Decision-Stock-Isolation.md)
- [Architecture-Decision-Async-Checkout-Queue](./Architecture-Decision-Async-Checkout-Queue.md)


---

*Sincronizado automaticamente de `Implementacao-EventCap-e-Reserva-CAS.md` em 2026-10-30T19:11:52.867Z.*
