# catalog-client

Lib (jar simples, sem repackage) com o **contrato HTTP** do serviço `catalog` (issue #35): o DTO `Event`, a interface `EventApi` (a
mesma que o módulo `catalog` do monólito expunha, mais `findCreatorId`), `EventoNaoEncontradoException`, `CatalogUnavailableException` e o
`CatalogClient`.

- **Quem usa:** o `catalog` (o `EventService` implementa `EventApi`; os testes ponta a ponta usam o cliente real contra o serviço real) e o `gateway` do monólito (bean de `CatalogClientConfig`; falha => 503 genérico no `/bff/**`).
- **`CatalogClient`:** uma chamada HTTP por método de `EventApi` em `/internal/events/**`, com o header `X-Internal-Token`. Apache HttpClient 5
  com pool (`CATALOG_CLIENT_MAX_CONNECTIONS`, default 400, no total e por rota), keep-alive, conectar 2 s, esperar conexão do pool 5 s,
  **resposta 15 s**, `evict-idle` 20 s e **sem retry automático**. URL: `CATALOG_SERVICE_URL` (default `http://localhost:8083`).
- **Erros:** 400 -> `IllegalArgumentException`, 404 com o cabeçalho `X-Catalog-Nao-Encontrado` -> `EventoNaoEncontradoException` (ou
  `null` em `findImage`/`findCreatorId`), 409 -> `EventoEmConflitoException`; rede, timeout, 5xx, 404 sem o cabeçalho e outro status ->
  `CatalogUnavailableException`. `exists` nunca devolve `false` por falha.
