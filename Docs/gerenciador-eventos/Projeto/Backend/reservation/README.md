# reservation

Serviço de reservas do Gerenciador de Eventos: o **lado wallet** da reserva e o **orquestrador da saga** stock + wallet (desde a #47). É dono de
`walletevent` (inscrição, **event sourcing**, stream `reservation.wallet`), de `idempotency_key` (também o log da saga) e da projeção assíncrona
`event_availability`, no schema `reservation`, com event store e relay próprios. Expõe uma **API interna HTTP** (`/internal/**`, porta **8082**, só
na rede `gerenciador-net`) chamada pelo gateway e pelo `admission`. Imagem `reservation/Dockerfile`, container `gerenciador-reservation`. A capacidade
(`eventcap`, CAS) e o ledger de holds são do serviço [`stock`](../stock/README.md). Spec da saga:
[`docs/superpowers/specs/2026-10-29-saga-stock-wallet-design.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/docs/superpowers/specs/2026-10-29-saga-stock-wallet-design.md).

- **Autenticação:** todo `/internal/**` exige `X-Internal-Token` = `INTERNAL_API_TOKEN` (401 sem/errado); sem a variável o serviço não sobe.
- **API interna:** `POST /internal/reservations?path=cas|naive` (com `Idempotency-Key`), `GET /internal/reservations/replay`, `POST /internal/reservations/confirm`,
  `DELETE /internal/reservations`, `GET /internal/reservations/user/{userId}`, `GET /internal/reservations/active` e
  `GET /internal/events/{eventId}/availability` (disponibilidade defasada, só do braço `naive`). Códigos de erro e detalhes em
  [`../CLAUDE.md`](../CLAUDE.md), seção "Serviço reservation". DTOs e cliente na lib [`reservation-client`](../reservation-client/README.md).
- **Saga da reserva:** (1) grava a chave de idempotência como `reserving`, (2) chama `POST /internal/holds` no `stock` **sem conexão aberta**,
  (3) grava `reserved`, o `walletevent` e o evento `SlotReserved` com o `holdId`. Falha do `stock` compensa (`release`); um *reaper* resolve as sagas
  órfãs. Cancelar e expirar só appendam o evento: o `stock` devolve a vaga ao consumir `reservation.wallet`.
- **Braços do experimento:** quem escolhe é o gateway (`RESERVATION_READPATH`): `cas` = uma chamada, `naive` = duas (disponibilidade e depois a
  reserva, sem CAS). Este serviço não tem a flag; recebe o modo no pedido.
- **Event sourcing:** o relay publica no tópico `reservation.wallet` e o consumer do group `reservation` mantém a projeção `event_availability`
  (o lag é medido, não configurado).
- **Jobs:** expiração das reservas `pending` vencidas, retenção das chaves de idempotência (24 h) e o reaper da saga.
- **Rodar:** `docker compose -f Projeto/docker-compose.yml up -d --build reservation` (depende do `stock`, que espera o one-shot `stock-seek`).
  Variáveis (só nomes): `INTERNAL_API_TOKEN`, `SPRING_DATASOURCE_*`, `SPRING_KAFKA_BOOTSTRAP_SERVERS`, `EVENTS_*`, `STOCK_SERVICE_URL`, `STOCK_CLIENT_*`,
  `RESERVATION_SAGA_*`. Sem o `stock` não há reserva (500 genérico no `/bff`; a saga se recompõe quando ele volta).
- **Banco:** `Projeto/Backend/db/init-scripts/13-reservation.sql` (banco novo) ou as migrações `20261025`, `20261027` e `20261029` (ver [`../db/README.md`](../db/README.md)).
- **Testar:** `Projeto/Backend/run-tests.sh` (reactor inteiro; pré-requisitos e `docker stop` dos serviços em [`../README.md`](../README.md)). Os testes
  de integração usam o `ReservationClient` real contra o serviço real (`ReservationApiE2ETest`) e, nos da saga (`ReservationSagaTest`, `SagaReaperTest`), o
  `stock` real atrás de um proxy que simula falhas.

Detalhes (pool, saga, janelas de falha, N réplicas): [`../CLAUDE.md`](../CLAUDE.md), seções "Serviço reservation" e "Serviço stock e saga stock + wallet".
