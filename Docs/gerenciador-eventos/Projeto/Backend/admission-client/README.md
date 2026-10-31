# admission-client

Lib (jar simples, sem repackage) com o **contrato HTTP** do serviço `admission` (issue #41): os DTOs `AdmissionRequest`/`AdmissionResult`, a
interface `AdmissionApi` e o `AdmissionClient`. Desde a #42 também o DTO `AdmissionStatus` (corpo de `GET /internal/admissions/result`: `queued`, `pending`, `rejected` ou `timed_out`),
que o `AdmissionClient` consulta desde a #43 (`result(userId, idempotencyKey)`, fora do disjuntor; 404 = vazio; falha = `AdmissionUnavailableException`). Na #43 o `AdmissionResult` ganhou o modo `queued` com os campos de estado e o cliente devolve 422/429 como `AdmissionRecusadaException` (serviço vivo: sem fail-open e sem contar para o disjuntor).

- **Quem usa:** o `monolito` (o gateway conta cada `POST /bff/event-wallets` por aqui; o bean sai de `AdmissionClientConfig`) e o
  `admission` (os mesmos DTOs são o corpo da API interna; o `AdmissionApiTest` usa o cliente real contra o serviço real). O `admission`
  NÃO escaneia o pacote `admissionclient` (senão haveria um cliente de si mesmo).
- **`AdmissionClient`:** Apache HttpClient 5 com pool (`ADMISSION_CLIENT_MAX_CONNECTIONS`, default 400, no total e por rota; >= threads do
  Tomcat do gateway), keep-alive, **conectar 200 ms, esperar conexão do pool 200 ms, resposta 500 ms**, `evict-idle` 20 s e **sem retry**.
  URLs: `ADMISSION_SERVICE_URL` (default `http://localhost:8085`; `http://admission:8085` no compose). `X-Internal-Token` em toda chamada.
- **Fail-open:** qualquer falha do serviço (rede, timeout, 5xx, 401) devolve `{"mode":"sync","rpm":-1}` e a reserva segue síncrona. O **400**
  (ex.: chave com mais de 255 caracteres) também NÃO falha a reserva na #41: vira `sync` sem contar, só com log; o `reservation` dá o 400 de sempre à chave longa do cliente.
- **Disjuntor:** 5 falhas seguidas abrem o circuito por `ADMISSION_CLIENT_OPEN_MS` (default 5000); nesse tempo nenhuma chamada sai (tudo
  `sync`). Passado o tempo, UMA chamada testa o serviço: sucesso fecha, falha reabre pelo tempo todo. 400 não conta como falha.
- **Log:** `LogComLimite` — no máximo 1 linha a cada 10 s, com a contagem acumulada; 401 (token diferente nos dois lados) é ERROR.
- Não depende de nenhum módulo do monólito (ArchUnit: `admissionclient_nao_depende_de_modulo_do_monolito`).
