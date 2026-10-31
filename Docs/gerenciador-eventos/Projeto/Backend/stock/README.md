# stock

Serviço de estoque do Gerenciador de Eventos (issue #47: o `reservation` se divide em **stock + wallet**, coordenados por uma saga). É dono de
`eventcap` (capacidade, **CAS**: `UPDATE` condicional atômico) e de `hold` (o **ledger das reservas de vaga**, uma linha por tentativa), no
schema `stock`. Expõe uma **API interna HTTP** (`/internal/**`, porta **8086**, só na rede `gerenciador-net`) chamada pelo
[`reservation`](../reservation/README.md) (orquestrador da saga) e pelo [`catalog`](../catalog/README.md) (capacidade). Imagem `stock/Dockerfile`,
container `gerenciador-stock`, **uma réplica fixa** (fora do scaler de autoescala). Desenho completo:
[`docs/superpowers/specs/2026-10-29-saga-stock-wallet-design.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/docs/superpowers/specs/2026-10-29-saga-stock-wallet-design.md).

- **Autenticação:** toda requisição exige `X-Internal-Token` = `INTERNAL_API_TOKEN` (401 sem/errado, sem filtro por caminho); sem a variável o serviço não sobe.
- **Holds** (`HoldController`): `POST /internal/holds` com `{holdId, userId, eventId, mode: cas|naive}` reserva a vaga numa transação curta (lê o
  `eventcap`, insere o hold, confere a janela de compra e, em `cas` de evento limitado, faz o CAS como último comando; "Evento lotado" desfaz tudo)
  e responde 201, 200 se repetido ou 409 se o hold já foi liberado (lápide). `POST /internal/holds/{holdId}/release` libera num statement só,
  devolve a vaga se havia débito e responde sempre 200, idempotente por `holdId` (um release que chega antes do "reservar" grava a lápide).
- **Capacidade** (`EventCapController`): `PUT/GET /internal/eventcaps/{id}`, `POST .../batch`, `PATCH .../policy` e `DELETE` (409 se há hold de qualquer status).
- **Devolução ao cancelar/expirar** (`StockReleaseConsumer`): consome `ReservationCancelled`/`ReservationExpired` (com `holdId`) de `reservation.wallet`,
  group `stock`, em lote e numa transação. **Reconciliação** (`CatalogReconciliationConsumer`): o `EventCreated` de `catalog.event` cria o `eventcap`
  que a chamada síncrona do catalog não criou (group `stock-catalog`).
- **Sem event store nem relay:** o stock só consome; não publica eventos.
- **Rodar:** `docker compose -f Projeto/docker-compose.yml up -d --build stock` (depende do one-shot `stock-seek`, que posiciona o group `stock` no
  Redpanda no 1º `up`). Variáveis (só nomes): `INTERNAL_API_TOKEN`, `SPRING_DATASOURCE_*`, `SPRING_KAFKA_BOOTSTRAP_SERVERS`, `EVENTS_CONSUMER_ENABLED`,
  `STOCK_RELEASE_CONSUMER_*`, `STOCK_CATALOG_RECONCILIATION_*`. Com ele parado, cancelar e expirar seguem respondendo e a vaga volta quando ele volta.
- **Banco:** `Projeto/Backend/db/init-scripts/16-stock.sql` (banco novo) ou a migração `20261029-stock-schema.sql` (ver [`../db/README.md`](../db/README.md)).
- **Testar:** `Projeto/Backend/run-tests.sh` (reactor inteiro; pré-requisitos e `docker stop` dos serviços em [`../README.md`](../README.md)).
  `StockHoldTest` usa o `StockClient` real contra o serviço real (idempotência, lápide, overselling 0, corrida release x reservar em voo), `StockApiE2ETest` o
  contrato HTTP e `StockReleaseConsumerTest` a devolução (lote, `earliest` do group novo, rebalance).

Detalhes (pool, saga, janelas de falha, conta do Supavisor): [`../CLAUDE.md`](../CLAUDE.md), seção "Serviço stock e saga stock + wallet". Contrato do cliente: [`../stock-client/README.md`](../stock-client/README.md).
