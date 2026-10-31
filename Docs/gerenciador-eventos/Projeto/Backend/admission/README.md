# admission

Serviço de admissão do Gerenciador de Eventos (camada de alta carga, issues #41 a #43). Conta cada tentativa de reserva por evento num **contador
de janela deslizante em Redis**, decide por evento entre o modo `sync` (a reserva segue direto ao `reservation`) e o modo **fila** (RabbitMQ + worker
pool), e guarda o resultado de cada mensagem enfileirada. **API interna HTTP** (`/internal/**`, porta **8085**, só na rede `gerenciador-net`)
chamada pelo gateway pela lib [`admission-client`](../admission-client/README.md). Imagem `admission/Dockerfile`, container `gerenciador-admission`.
**Sem datasource**: não toca no Postgres e não depende da lib `shared`. Spec:
[`docs/superpowers/specs/2026-10-28-admission-servico-design.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/docs/superpowers/specs/2026-10-28-admission-servico-design.md); decisão:
[`docs/adr/Architecture-Decision-Async-Checkout-Queue.md`](/decisoes-arquitetura/Architecture-Decision-Async-Checkout-Queue).

- **Autenticação:** todo `/internal/**` exige `X-Internal-Token` = `INTERNAL_API_TOKEN` (401 sem/errado, sem rota pública); sem a variável o serviço não sobe.
- **API interna:**
  - `POST /internal/admissions` com `{eventId, userId, idempotencyKey, path}` (`path` = `cas` ou `naive`): conta a tentativa e responde o modo. Em `sync`,
    `200 {"mode":"sync","rpm":n}`; em modo fila, `200` com `mode: queued` e o estado. Respostas de negócio: `422` (chave de outro evento) e `429` (limite
    por usuário ou fila cheia); `400` para pedido malformado. Redis fora ou lento (timeout de 200 ms) dá **503**: o fail-open é do cliente (gateway).
  - `GET /internal/admissions/events/{eventId}/rpm`: RPM atual do evento (só leitura).
  - `GET /internal/admissions/result?userId=&idempotencyKey=`: estado da mensagem (`queued`, `pending`, `rejected` ou `timed_out`) ou `404`.
- **Contador:** buckets de `ADMISSION_BUCKET_MS` (50 ms) somados numa janela de `ADMISSION_WINDOW_MS` (200 ms), num script Lua (uma ida ao Redis,
  atômica). O RPM é só sinal de carga: nada de capacidade é decidido por ele.
- **Gatilho (por evento, no mesmo script):** `uso = RPM do evento / (X x réplicas do reservation)`, com `ADMISSION_X_RPM` e `ADMISSION_RESERVATION_REPLICAS`.
  Uso a partir de `ADMISSION_QUEUE_ON` (0,80) liga o modo fila; volta ao `sync` só com uso abaixo de `ADMISSION_SYNC_BELOW` (0,70) **e** a espera do evento
  vazia (histerese). Com a autoescala, as réplicas vêm da chave `adm:replicas` do Redis, escrita pelo scaler. Só o braço `cas` enfileira; o `naive` só conta.
  O gateway responde `202 Accepted` quando o modo é fila.
- **Fila e worker pool:** exchange `admission`, fila `admission.requests` (TTL e tamanho máximo configuráveis, dead-letter `admission.dlx` ->
  `admission.timed_out`). Os workers (`@RabbitListener`, ack manual, concorrência fixa `ADMISSION_WORKER_CONCURRENCY`) chamam
  `POST /internal/reservations?path=cas` no `reservation` com a `Idempotency-Key` da mensagem: 201 vira `pending`, 4xx de negócio vira `rejected`, falha
  transitória faz backoff e a mensagem volta. A dead-letter é reconciliada pelo `replay` do reservation.
- **Redis e RabbitMQ:** containers `gerenciador-redis` (com senha, sem persistência, `maxmemory` com `volatile-ttl`) e `gerenciador-rabbitmq` (sem management e sem
  volume: reiniciar perde as mensagens em fila), ambos sem porta no host.
- **Rodar:** `docker compose -f Projeto/docker-compose.yml up -d --build admission` (sobe junto `redis`, `rabbitmq` e `reservation`). O `backend` **não** depende
  dele: com ele ou o Redis fora, o gateway faz fail-open e a reserva segue síncrona, só sem a contagem. **Obrigatórias no `Projeto/.env`, sem default:**
  `REDIS_PASSWORD`, `RABBITMQ_USER` e `RABBITMQ_PASSWORD`. Outras variáveis (só nomes): `INTERNAL_API_TOKEN`, `REDIS_HOST`, `RABBITMQ_HOST`, `RESERVATION_SERVICE_URL`
  e as `ADMISSION_*` (fila, worker, resultado e gatilho; defaults no compose).
- **Testar:** `Projeto/Backend/run-tests.sh` (reactor inteiro). Exige `db`, `redpanda`, `redis` e `rabbitmq` no ar e os serviços parados, inclusive o
  `gerenciador-admission` (ele contaria tentativas de teste no mesmo Redis); ver [`../README.md`](../README.md). Os testes usam Redis e RabbitMQ **reais**
  (as filas de teste têm prefixo próprio) e um `reservation` falso: `RpmCounterTest`, `AdmissionApiTest`, `FilaDeAdmissaoTest`, `AdmissionWorkerTest`,
  `AdmissionDeadLetterTest`, `AdmissionGatilhoTest`, entre outros. O e2e (`Projeto/e2e/run-e2e.sh`, passo 4b) faz uma rajada concorrente contra o `reservation` real.

Detalhes (script Lua, histerese, decisões e janelas): [`../CLAUDE.md`](../CLAUDE.md), seção "Serviço admission" e suas subseções.
