# monolito (gateway / BFF)

Módulo que sobrou do monólito original: **só o `gateway`**. É a única superfície HTTP pública do back-end (`/bff/**`, porta 8081,
container `gerenciador-backend`) e é o que o Flutter e o k6 chamam. Não tem tabela de domínio nem código dos serviços: roteia, valida o
JWT, confere dono e papel e **fala com os serviços por HTTP** (libs `*-client`, rede `gerenciador-net`). Entrypoint: `com.gerenciador.eventos.Main`.
Visão geral: [`../../../README.md`](../../../README.md); detalhes: [`../CLAUDE.md`](../CLAUDE.md), seções "Rotas e segurança", "Serviço identity",
"Serviço admission" e "Inscrição em evento".

## O que faz

- **Controllers `/bff/**`** (pacote `gateway`): `users` (CRUD, login, `/me`, cadastro em duas fases, MFA, reCAPTCHA), `events` (CRUD, busca,
  imagem), `event-wallets` (reservar, confirmar, validar, cancelar, listar, consultar a fila), `my-wallets` e `seed`. O contrato com o
  Flutter é travado por `HttpContractTest`; `GET /actuator/health` é público.
- **JWT sem estado** (`gateway/security`): o `identity` assina (RS256); o gateway só valida, com a chave pública lida de
  `GET /.well-known/jwks.json` e guardada em cache (24 h por `kid`, no máximo 1 busca a cada 30 s, tolerante a queda do `identity`).
  O usuário é a claim `uid` e o papel de host é a claim `isHost`, sem consulta ao banco. Rota protegida sem token válido devolve 401;
  rota pública ignora bearer inválido. Dono do recurso: `403` quando o id do path ou o `userId` não é o do token.
- **Chamadas internas** (`X-Internal-Token` = `INTERNAL_API_TOKEN` em toda chamada): `identity` (login, cadastro, nomes em lote),
  `catalog` (CRUD de eventos, `exists` com cache positivo de 30 s), `reservation` (reservas) e `admission` (contagem). Cada cliente tem
  pool e timeouts próprios, sem retry automático. Com o `identity` fora, login, cadastro, `/bff/users/**` e `/bff/my-wallets/**`
  respondem 503, mas quem já tem token válido segue reservando (o JWT é validado sem estado). Com o `catalog` fora, as rotas de eventos
  respondem 503 **e a reserva também** (`POST /bff/event-wallets` precisa confirmar o evento), salvo um `exists` positivo ainda no cache de 30 s.
- **Reserva** (`POST /bff/event-wallets`): o gateway confere o evento e chama o `admission` **uma vez** por tentativa, depois o
  `reservation`. `RESERVATION_READPATH` escolhe o braço, lido na subida: `cas` (padrão, uma chamada ao `reservation`, nunca oversella) ou
  `naive` (duas chamadas, braço de controle do experimento). Se o `admission` responder modo fila (evento acima de 80% de X), o gateway
  devolve **`202 Accepted`** com `Idempotency-Key`, `Retry-After: 1` e corpo `queued`, e o cliente consulta
  `GET /bff/event-wallets/admission?idempotencyKey=`. O `admission` é **fail-open**: se ele ou o Redis falharem (há disjuntor), a reserva
  segue síncrona só sem a contagem; o `backend` não depende dele no compose.
- **Seed**: `POST /bff/seed` só existe com `SEED_ENABLED=true` (override de carga); sem isso responde 404.

## Variáveis (só os nomes)

`INTERNAL_API_TOKEN` (obrigatória, sem default: o gateway não sobe sem ela), `RESERVATION_READPATH`, `SEED_ENABLED`, `CORS_ALLOWED_ORIGINS`,
`IDENTITY_SERVICE_URL`, `CATALOG_SERVICE_URL`, `RESERVATION_SERVICE_URL`, `ADMISSION_SERVICE_URL` e os `*_CLIENT_*` de cada cliente
(por exemplo `RESERVATION_CLIENT_MAX_CONNECTIONS`), `JWT_ISSUER` e `JWT_JWKS_*`, `SERVER_TOMCAT_THREADS_MAX` e
`SPRING_DATASOURCE_*`. Os defaults de dev estão no `application.properties`; no compose os valores vêm do `Projeto/.env`.

## Rodar

```bash
docker compose -f Projeto/docker-compose.yml up -d --build backend    # sobe junto o que ele exige (identity, catalog, reservation, stock...)
curl -i http://localhost:8081/actuator/health
```

Local, sem Docker, com Maven e JDK 21 (precisa dos serviços em `localhost`, nas portas padrão): a partir de `Projeto/Backend`,
`mvn install -DskipTests -pl monolito -am` (instala `shared` e as libs `*-client` no repositório local) e depois `mvn -pl monolito spring-boot:run`.

## Testar

`Projeto/Backend/run-tests.sh` (reactor inteiro; pré-requisitos, `docker stop` dos serviços e efeitos colaterais em [`../README.md`](../README.md)). O
`monolito` não sobe os serviços de verdade nos seus testes: usa servidores falsos em memória (`FakeReservationServer`, `FakeCatalogServer`,
`FakeIdentityServer`, `FakeAdmissionServer`, em `src/test`) e o contrato com cada serviço real é testado no módulo do serviço. Os testes
de `shared.events` (event store, relay, consumer, replay) também moram aqui, porque sobem o contexto Spring do gateway com Postgres e
Redpanda reais. `LayerBoundaryArchTest` e `ModuleBoundaryArchTest` (ArchUnit) travam as fronteiras entre módulos.
