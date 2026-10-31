# catalog

Serviço de eventos do Gerenciador de Eventos. Dono do agregado `Event` em **CQRS + event sourcing** (stream `catalog.event`; projeção inline
`event`/`eventpresenter` na mesma transação do append), no schema `catalog`, com event store, outbox, snapshot e checkpoint próprios. Expõe uma
**API interna HTTP** (`/internal/events/**`, porta **8083**, só na rede `gerenciador-net`) que espelha o `EventApi` da lib
[`catalog-client`](../catalog-client/README.md) e é chamada pelo gateway. Imagem `catalog/Dockerfile`, container `gerenciador-catalog`.
Spec: [`docs/superpowers/specs/2026-10-24-catalog-servico-design.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/docs/superpowers/specs/2026-10-24-catalog-servico-design.md).

- **Autenticação:** toda requisição exige `X-Internal-Token` = `INTERNAL_API_TOKEN` (401 sem/errado); sem a variável o serviço não sobe.
- **API interna:** `POST /internal/events`, `PUT|GET|DELETE /internal/events/{id}`, `POST /internal/events/validate`, `GET /internal/events/search`,
  `GET /internal/events?creatorId=`, `GET /internal/events/{id}/exists`, `GET /internal/events/{id}/creator` e `GET|POST /internal/events/{id}/image`.
  As listas não trazem `image_data` (blob fora do event sourcing). Erros em texto: 400 regra de negócio, 404 evento inexistente, 409 conflito
  (apagar evento com reserva, evento pré-ES, conflito de versão esgotado), 500 o resto. O `creator_id` do corpo é confiado: quem o amarra ao
  JWT e confere o dono é o gateway.
- **Capacidade:** o `eventcap` é do serviço [`stock`](../stock/README.md) (desde a #47), chamado por HTTP pela lib `stock-client`: criar depois do
  commit do evento, `PATCH .../policy` no update, busca em lote para hidratar listas e `DELETE` antes de cancelar (409 se há reserva). O catalog
  não depende do `stock` no boot: se a chamada de criação falhar, o `stock` cria o `eventcap` pelo `EventCreated` de `catalog.event`.
- **Event sourcing:** o relay publica no tópico `catalog.event` (ligado no compose por `EVENTS_RELAY_ENABLED`); sem consumer.
- **Rodar:** `docker compose -f Projeto/docker-compose.yml up -d --build catalog`. Variáveis (só nomes): `INTERNAL_API_TOKEN`, `SPRING_DATASOURCE_*`,
  `SPRING_KAFKA_BOOTSTRAP_SERVERS`, `EVENTS_RELAY_*`, `STOCK_SERVICE_URL`, `STOCK_CLIENT_*`. Com ele parado, `/bff/events/**` e a reserva respondem 503
  (na reserva, um `exists` positivo ainda no cache de 30 s do gateway deixa a reserva seguir).
- **Banco:** `Projeto/Backend/db/init-scripts/14-catalog.sql` (banco novo) ou a migração `20261026-catalog-schema.sql` (ver [`../db/README.md`](../db/README.md)).
- **Testar:** `Projeto/Backend/run-tests.sh` (reactor inteiro; pré-requisitos e `docker stop` dos serviços em [`../README.md`](../README.md)). Nos testes do
  serviço o `stock` é um servidor falso em memória; o contrato com o cliente real é o `CatalogApiE2ETest`, e o replay do agregado é o `CatalogEventSourcingTest`.

Detalhes (event sourcing, janelas de falha, pool): [`../CLAUDE.md`](../CLAUDE.md), seções "Catalog em CQRS + Event Sourcing" e "Serviço catalog".
