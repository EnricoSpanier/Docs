# CLAUDE.md — Backend (API Spring Boot)

API REST do Gerenciador de Eventos. Spring Boot 3.5.7, Java 21, Maven (sem wrapper `mvnw`).
Leia também o CLAUDE.md da raiz (regras gerais) e o de `db/` (schema).

## Rodar

- Via Docker (recomendado): `docker compose -f Projeto/docker-compose.yml up -d --build backend`
  — porta `8081`, container `gerenciador-backend`. Sobe junto `db`, `supabase-pooler` e `redpanda` (o
  backend espera o broker ficar `healthy`); no Docker o backend fala **pelo pooler** (Supavisor), ver
  "Pooler" em Persistência, e com o broker em `redpanda:9092` (`SPRING_KAFKA_BOOTSTRAP_SERVERS`).
- Serviço `notification` (issue #32): `docker compose -f Projeto/docker-compose.yml up -d --build notification`
  — container `gerenciador-notification`, sem porta. Ver "Serviço notification". O `backend` NÃO depende dele.
- Serviço `reservation` (issue #33): `docker compose -f Projeto/docker-compose.yml up -d --build reservation` — container
  `gerenciador-reservation`, API interna na `:8082` **só na rede `gerenciador-net`** (sem porta no host). Ver "Serviço reservation".
  O `backend` **depende dele** (`depends_on: reservation: service_healthy`): sem ele não há reserva (o resto do monólito sobe).
- Serviço `stock` (issue #47): `docker compose -f Projeto/docker-compose.yml up -d --build stock` — container `gerenciador-stock`, API interna na `:8086` **só na rede**; entrypoint
  `com.gerenciador.eventos.stock.StockApplication`, `stock/Dockerfile`. Dono do `eventcap` (CAS) e do ledger de holds; o `reservation` **depende dele** (`service_healthy`, que por sua vez espera o
  one-shot `stock-seek`). Ver "Serviço stock e saga stock + wallet".
- Serviço `catalog` (issue #35): `docker compose -f Projeto/docker-compose.yml up -d --build catalog` — container `gerenciador-catalog`,
  API interna na `:8083` **só na rede**; entrypoint `com.gerenciador.eventos.catalog.CatalogApplication`, `catalog/Dockerfile`. O `backend`
  também depende dele (`service_healthy`); com ele parado `/bff/events/**` e a reserva respondem 503 (na reserva, um positivo de `exists`
  ainda no cache de 30 s do gateway deixa a reserva seguir). Ver "Serviço catalog".
- Serviço `identity` (issue #36): `docker compose -f Projeto/docker-compose.yml up -d --build identity` — container `gerenciador-identity`,
  API interna na `:8084` **só na rede**; entrypoint `com.gerenciador.eventos.identity.IdentityApplication`, `identity/Dockerfile`. Gera (1º boot) e
  guarda a chave de assinatura do JWT no volume `identity-keys`. O `backend` **depende dele** (`service_healthy`); com ele parado login, cadastro,
  `/bff/users/**` e `/bff/my-wallets/**` respondem 503, mas quem tem token válido segue reservando (JWKS em cache no gateway). **Não sobe** com a
  migração `20261028` pendente (`PublicSchemaGuard`). Ver "Serviço identity".
- Serviço `admission` (issue #41): `docker compose -f Projeto/docker-compose.yml up -d --build admission` — container `gerenciador-admission`, API interna
  na `:8085` **só na rede**; entrypoint `com.gerenciador.eventos.admission.AdmissionApplication`, `admission/Dockerfile`. Sobe junto o **Redis**
  (`gerenciador-redis`) e, desde a #42, o **RabbitMQ** (`gerenciador-rabbitmq`) e o `reservation` (depende dos três, `service_healthy`: o worker pool da fila de
  admissão chama o reservation). O `backend` **não** depende dele (o gateway faz fail-open): com ele parado a reserva segue
  síncrona, só sem a contagem. **`REDIS_PASSWORD`, `RABBITMQ_USER` e `RABBITMQ_PASSWORD` são obrigatórias** no `Projeto/.env` (ver "Serviço admission"). Sem datasource.
- Local: `cd Projeto/Backend && mvn -pl monolito -am spring-boot:run` (ou `mvn -pl notification -am spring-boot:run`, `mvn -pl identity -am spring-boot:run`,
  `mvn -pl reservation -am spring-boot:run`) — precisa de um Postgres em `localhost:5433` (e, para a reserva, do `reservation` em
  `localhost:8082`, o default de `RESERVATION_SERVICE_URL`; para login, do `identity` em `localhost:8084`, o de `IDENTITY_SERVICE_URL`). `application.properties` de cada módulo tem defaults de dev para as vars do `.env`,
  **exceto** `MAIL_USERNAME`/`MAIL_PASSWORD` do `notification` (sem default de propósito: não vai e-mail pessoal no código):
  para rodar o serviço local, exporte as duas.
- Entrypoint do jar do monólito: `com.gerenciador.eventos.Main` (fixado em `monolito/pom.xml` e `monolito/Dockerfile`); o do
  `notification`: `com.gerenciador.eventos.notification.NotificationApplication`; o do `reservation`:
  `com.gerenciador.eventos.reservation.ReservationApplication`; o do `identity`: `com.gerenciador.eventos.identity.IdentityApplication`; o do
  `admission`: `com.gerenciador.eventos.admission.AdmissionApplication`.
- Build da imagem: um Dockerfile por serviço (`monolito/Dockerfile`, `notification/Dockerfile`, `reservation/Dockerfile`, `catalog/Dockerfile`, `identity/Dockerfile`, `admission/Dockerfile`, `stock/Dockerfile`), contexto = `Projeto/Backend/`
  (a raiz do multi-módulo); multi-stage — compila com `maven:3.9.7-temurin-21` (`-pl <serviço> -am`), roda em `temurin:25-jre`.

## Layout multi-módulo Maven — issue #32 (Fase 7)

`Projeto/Backend/` deixou de ser um módulo só: o `pom.xml` da raiz é o **agregador** (`packaging=pom`, parent
`spring-boot-starter-parent` 3.5.7, `dependencyManagement` de `shared`, compiler e Checkstyle herdados por todos). Cada
serviço é um módulo com o próprio jar e Dockerfile; o que é comum é uma lib.

```
Backend/
  pom.xml                agregador (módulos: shared, reservation-client, stock-client, catalog-client, identity-client, admission-client, monolito, notification, reservation, stock, catalog, identity, admission)
  checkstyle*.xml        um só para todos os módulos (${maven.multiModuleProjectDirectory})
  run-tests.sh           roda o reactor inteiro
  shared/                LIB (jar simples, sem repackage): DatabaseConnection + shared.events (EventStore, relay, consumer,
                         replay...) + NotificationEvents (contrato do stream identity.notification)
  reservation-client/    LIB (#33): contrato HTTP do serviço reservation — DTOs (EventWallet, EventCap), IdempotencyConflictException,
                         as interfaces EventWalletApi/EventCapacityApi e o ReservationClient (pool de conexões). Usada pelo monólito
                         (inteira) e pelo reservation (DTOs + testes ponta a ponta)
  monolito/              o gateway: gateway/ (/bff/**) + gateway/security (JWT RS256 por JWKS), CorsConfig/SchedulingConfig; src/, Dockerfile, pom.xml (catalog saiu na #35, identity na #36)
  notification/          serviço extraído (README.md próprio); src/, Dockerfile, pom.xml
  reservation/           serviço extraído (README.md próprio): eventcap/CAS, walletevent/ES, API interna; src/, Dockerfile, pom.xml
  catalog-client/        LIB (#35): contrato HTTP do serviço catalog — Event, EventApi, EventoNaoEncontradoException,
                         EventoEmConflitoException, CatalogUnavailableException e o CatalogClient (pool). Usada pelo catalog (contrato +
                         testes ponta a ponta) e pelo gateway (desde o cutover, fatia 3 da #35)
  identity-client/       LIB (#36, fatia 1; README.md próprio com o contrato /internal/**): User, MyWallet, LoginResult, RecaptchaResponse,
                         UserApi/EmailVerificationApi/MyWalletApi/RecaptchaApi, IdentityUnavailableException, IdentityNaoEncontradoException e o
                         IdentityClient (pool). O gateway (monólito) usa o IdentityClient pelo IdentityClientConfig (desde o cutover, fatia 3)
  catalog/               serviço extraído (#35, README.md próprio): eventos em CQRS + ES no schema catalog, API interna
                         /internal/events/**; src/, Dockerfile, pom.xml. Chamado pelo gateway por HTTP (CatalogClient)
  identity/              serviço extraído (#36; README.md próprio): usuários, carteira, cadastro, MFA, reCAPTCHA e emissão do JWT RS256
                         (+ JWKS) no schema `identity`, API interna /internal/** na :8084; src/, Dockerfile, pom.xml. Chamado pelo gateway por HTTP (IdentityClient);
                         o monólito NÃO tem mais o pacote `identity`
  admission-client/      LIB (#41; README.md próprio): AdmissionRequest/AdmissionResult/AdmissionStatus (os DTOs; o status é da #42), AdmissionApi e o AdmissionClient (pool, timeouts curtos,
                         fail-open e disjuntor). O gateway (monólito) o usa pelo AdmissionClientConfig; o serviço admission, pelos DTOs e nos testes ponta a ponta
  admission/             serviço novo (#41; README.md próprio): contador de RPM por evento em Redis (janela deslizante por buckets), fila de admissão em
                         RabbitMQ com worker pool que chama o reservation (#42) e API interna /internal/admissions na :8085; src/, Dockerfile, pom.xml. SEM datasource e SEM dependência de `shared`. Chamado pelo gateway por HTTP
  stock-client/          LIB (#47; README.md próprio): HoldRequest/HoldResponse/ReleaseRequest, EventCap, EventCapacityApi, StockConflictException, HoldLiberadoException e o StockClient (pool).
                         Usada pelo reservation (orquestrador da saga) e pelo catalog (capacidade)
  stock/                 serviço novo (#47; README.md próprio): eventcap (CAS) + ledger de holds (stock.hold) + API interna /internal/holds e /internal/eventcaps na :8086,
                         StockReleaseConsumer (devolução da vaga por evento) e CatalogReconciliationConsumer; src/, Dockerfile, pom.xml. SEM event store
  db/                    schema (fora do Maven)
```

- **Fronteira física**: `notification` NÃO depende de `monolito` (só de `shared`) e não lê tabela do monólito; tem schema próprio
  (`notification`) e processo/imagem próprios. `shared` só leva o que mais de um serviço usa de verdade; o pacote Java continua
  `com.gerenciador.eventos.shared[.events]` (mesmos imports do monólito). **Módulo novo** (como a #33 `reservation`):
  novo diretório com `pom.xml` (parent `backend`, dep em `shared`), uma linha em `<modules>` do agregador, um
  `<serviço>/Dockerfile` copiado dos existentes (que passam a copiar também o `pom.xml` do módulo novo: o agregador exige o pom de
  todos) e um serviço no compose. `reservation` NÃO depende de `monolito` e o monólito não tem o código do `reservation` no
  classpath: a fronteira entre eles é o HTTP, e o que os dois compartilham é a lib `reservation-client` (contrato).
- **Testes** de cada módulo ficam no próprio módulo. Os de `shared.events` (e o `TestSupport`) continuam em `monolito/src/test`,
  porque sobem o contexto Spring do monólito (`Main`) para exercitar a lib com Postgres e Redpanda reais. O `reservation` tem uma
  cópia enxuta do `TestSupport` (`GlobalDbTruncator`, `TestSchemas` com default `reservation`, `EventsTestSupport`) em `reservation/src/test`
  e `ReservationTestSupport` (ids de usuário/evento sem tabela de outro serviço). Os testes do monólito que tocam a reserva falam
  HTTP com o **servidor falso** `TestSupport/FakeReservationServer` (JDK `HttpServer`, estado em memória, sobe uma vez por JVM pelo
  `LauncherSessionListener` `ReservationFakeSession`, URL na propriedade de sistema `reservation.service.url`); o contrato
  cliente-servidor com o serviço REAL é o `ReservationApiE2ETest` do módulo `reservation`.
- `Backend/.mvn/maven.config` existe para o Maven achar a raiz do multi-módulo (`${maven.multiModuleProjectDirectory}`, onde
  moram `checkstyle*.xml`) mesmo rodando de dentro de `monolito/` ou `notification/` (IDE); sem a pasta `.mvn` o Maven usa o cwd e o
  Checkstyle não acha a config.
- Comandos: tudo na raiz de `Backend/`. `mvn -pl monolito -am test` (monólito + libs), `mvn -pl notification -am test`, `mvn -pl reservation -am test`,
  `mvn -Dtest=ClasseTest -Dsurefire.failIfNoSpecifiedTests=false test` (uma classe, em qualquer módulo). `-pl X -am` compila
  `shared` junto; sem `-am` o Maven procura `shared` no repositório local e falha.

## Testes

`./run-tests.sh` — sobe um container Maven na rede `gerenciador-net`, com `--env-file ../.env`
(URL direta `db:5432`, **sem passar pelo pooler**),
e roda `mvn -fae clean test` na raiz: o **reactor inteiro** (`shared`, `reservation-client`, `stock-client`, `catalog-client`, `identity-client`, `admission-client`, `monolito`, `notification`,
`reservation`, `stock`, `catalog`, `identity`, `admission`; `-fae` = um módulo vermelho não esconde o resultado dos outros). **Pré-requisito do `stock` (#47):** o banco migrado (`db/migrations/20261029-stock-schema.sql`): o script ABORTA se `reservation.eventcap` ainda existe ou se faltam `stock.eventcap`/`stock.hold`, e se o
`gerenciador-stock` (ou réplica com o label do serviço) estiver rodando; ao fim move os groups `stock`/`stock-catalog` para o fim dos tópicos. `TEST_DB_NAME` (default `meu_banco`) e `ENV_FILE` (default
`../.env`) permitem rodar os testes num banco isolado (o `meu_banco` fica no schema da R4); o banco novo é criado com os init scripts da worktree. **Pré-requisito do `catalog` (#35):** o banco
migrado (`db/migrations/20261026-catalog-schema.sql`): o script ABORTA se `public.event` ainda existe ou `catalog.event` não existe (não
aplica o `14-catalog.sql`, que num banco não migrado criaria `catalog.event` vazia ao lado de `public.event`), e aborta se o
`gerenciador-catalog` estiver rodando (o relay dele drenaria o `catalog.event_outbox` dos testes). Antes disso apaga `target/surefire-reports` sozinho, então o total do
resumo reflete só os testes desta rodada — não precisa limpar na mão; os relatórios de todos os módulos são copiados para
`Backend/target/surefire-reports` (nomes de classe únicos). **Serviço `identity` (#36):** o script **aborta** se o `gerenciador-identity` estiver rodando (`docker stop gerenciador-identity`; o relay dele drenaria o
`identity.event_outbox` dos testes) e **aborta se o banco ainda tiver `public.users` ou não tiver `identity.users`** (migração `db/migrations/20261028-identity-schema.sql` pendente: backup `pg_dump -h localhost -U admin --clean --if-exists -n public meu_banco`, backend e identity parados; o script NÃO aplica o `15-identity.sql`, que num banco não migrado criaria tabelas vazias ao lado de `public.users`; bancos novos já nascem certos). Banco verificado por `db/migrations/verify-20261028-migration.sh` (bancos descartáveis: sem o 15, com o 15 vazio, guardas, rollback, init completo). O monólito não tem mais `public.users`/`mywallet`/`pending_verifications`; o `FakeIdentityServer` (`TestSupport`, servido pelo `LauncherSessionListener` `IdentityFakeSession`, URL em `identity.service.url`) faz o papel do serviço nos testes do gateway.
**Chave do JWT e `uid` reciclado:** os testes dão `TRUNCATE ... RESTART IDENTITY` em `identity.users` do `meu_banco` (o `user_id` volta a 1) e o JWT é validado sem estado pela claim `uid`; a chave de assinatura do identity de dev vive no volume `gerenciador-eventos_identity-keys` e sobreviveria à rodada, deixando um token antigo valer como o usuário novo com o mesmo uid. Por isso, **no INÍCIO e ao fim da rodada (verde ou vermelha) o script apaga `jwt-signing-key.json` desse volume** (identity e backend estão parados, pela guarda): o próximo boot do identity gera outra chave e todo token antigo vira 401 (relogar). O backend precisa ser (re)iniciado depois, porque o gateway guarda o JWKS em cache por até 24 h; parado durante os testes, ele sobe com o cache vazio. Se a remoção falhar, o script imprime o comando para rodar antes de subir identity e backend.
Os testes do módulo `identity` usam uma chave de assinatura temporária por JVM e um reCAPTCHA falso
(`TestSupport/IdentityTestSession`); a `RECAPTCHA_SECRET_KEY` real do `.env` nunca sai para o Google.
**Pré-requisito do `notification` (#32):** o schema `notification`
no banco (`db/migrations/20261024-notification-schema.sql`, num volume antigo; bancos novos já nascem com ele). **Pare também o
`gerenciador-notification`** (`docker stop gerenciador-notification`): o relay dos testes do monólito publica em
`identity.notification` e um notification vivo mandaria e-mail de verdade (SMTP real) para os endereços de teste; o script aborta
com mensagem clara se ele estiver rodando. **Ao fim da rodada (verde ou vermelha) o script move o consumer group `notification` para o
FIM do tópico** (`docker exec gerenciador-redpanda rpk group seek notification --to end --topics identity.notification
--allow-new-topics`): os testes publicam ali (direto e pelo relay), e sem isso o próximo `up` do serviço (offset atrasado, ou group
novo em `earliest`) mandaria e-mail REAL do Gmail para cada endereço de teste. **Trade-off:** um e-mail legítimo que estivesse
pendente antes da rodada é pulado (aceitável em dev: o backend, e portanto o cadastro real, precisa estar parado para testar). Se o
seek falhar, o script avisa e imprime o comando: rode-o ANTES de qualquer `up` do `notification`.
**Pré-requisito do `reservation` (#33):** o schema `reservation` no banco (`db/migrations/20261025-reservation-schema.sql`, num volume
antigo — move as tabelas de `public` e o stream `reservation.wallet` do event store; bancos novos já nascem com ele). **Pare também o
`gerenciador-reservation`** (`docker stop gerenciador-reservation`): o relay, o consumer e a reconciliação dele disputariam o
`reservation.event_outbox`, a projeção e o tópico `catalog.event` dos testes; o script aborta com mensagem clara se ele estiver rodando.
**Ao fim da rodada o script também move para o FIM dos tópicos os groups do serviço**: `reservation` (projeção de disponibilidade, tópico
`reservation.wallet`) e `reservation-catalog` (reconciliação do `eventcap`, tópico `catalog.event`) — a reconciliação, em particular,
CRIARIA `eventcap` para ids de evento de teste (que se repetem depois de `TRUNCATE ... RESTART IDENTITY`).
**Exige os containers `db` e `redpanda` no ar** (`docker compose -f Projeto/docker-compose.yml up -d db redpanda`;
o script aborta com mensagem clara se faltar um): os testes batem num Postgres e num Redpanda reais.
**Pare o `gerenciador-backend` antes** (`docker stop gerenciador-backend`): o relay e o consumer dele (ligados no compose desde a #28/#29)
compartilham o `meu_banco` e drenariam o `event_outbox` dos testes (quebrando `ReservationReplayTest` e a prova de overselling do
naive); o script aborta com mensagem clara se o container estiver rodando. O script
passa `SPRING_KAFKA_BOOTSTRAP_SERVERS=redpanda:9092` e `EVENTS_CONSUMER_GROUP=gerenciador-eventos-test` ao container
de teste (group próprio: os testes nunca entram no group do backend vivo que consome do mesmo Redpanda).

**Serviço `admission` e Redis (#41):** os testes do contador usam o **Redis REAL** (container `gerenciador-redis` na rede `gerenciador-net`, `REDIS_HOST=redis`), então o script
**exige o `gerenciador-redis` no ar** (`REDIS_PASSWORD=<valor> docker compose -f Projeto/docker-compose.yml up -d db redpanda redis`: o compose recusa subir sem a variável, que vem do
`Projeto/.env` ou é exportada na shell só para o comando) e **aborta se o `gerenciador-admission` estiver rodando** (`docker stop gerenciador-admission`: ele contaria tentativas de teste no mesmo
Redis). **RabbitMQ (#42):** os testes da fila e do worker usam o **RabbitMQ REAL** (container `gerenciador-rabbitmq` na rede `gerenciador-net`, `RABBITMQ_HOST=rabbitmq`), então o script
**exige o `gerenciador-rabbitmq` no ar** (`docker compose -f Projeto/docker-compose.yml up -d db redpanda redis rabbitmq`; o compose recusa subir sem `RABBITMQ_USER` e `RABBITMQ_PASSWORD`, do `Projeto/.env` ou
exportadas na shell só para o comando) e repassa `RABBITMQ_USER`/`RABBITMQ_PASSWORD` da shell com `-e` **só se estiverem exportadas** (senão valem as do `--env-file`), como a `REDIS_PASSWORD`. Os testes nunca usam as filas
`admission.*` do serviço: cada classe monta `admission.amqp.prefix=${admission.test.prefix}<sufixo>` (o prefixo é sorteado por JVM no `AdmissionTestSession`, que também apaga as filas e exchanges no fim). **Credencial:** o container de teste recebe a `REDIS_PASSWORD` do `--env-file` (`Projeto/.env`) e, **se a variável estiver exportada na shell, a da shell por cima** (`-e REDIS_PASSWORD`,
só nesse caso); a senha nunca vai na linha de comando do `docker exec`. **`FLUSHDB` no `gerenciador-redis` no INÍCIO e ao FIM da rodada** (verde ou vermelha): os ids de evento voltam a 1 com
`RESTART IDENTITY`, e uma contagem de uma rodada antiga seria lida como carga da seguinte; o início aborta se o `FLUSHDB` falhar (senha errada), o fim só avisa e imprime o comando.
- `monolito/src/test/.../SchemaValidationTest` valida o schema real contra o esperado (`public`, `notification.processed_event`, e que
  `eventcap`/`walletevent`/`event_availability`/`idempotency_key` SAÍRAM de `public` e `users`/`mywallet`/`pending_verifications` foram para `identity`, sem FK cross-schema); o do módulo `reservation`
  (`reservation/src/test/.../SchemaValidationTest`) valida o schema `reservation` (tabelas, colunas, chaves, sem FK, event store próprio).
  Desde a #59 também há asserções **negativas** (`assertColumns` é "contém" e não pega coluna que volta): o do monólito exige que nenhuma tabela de `public` tenha
  `capacity`/`quant`/`buy_time_limit`/`lot_quantity`/`max_time_in_line`, e o do `catalog` que `event`/`eventpresenter` não as tenham. A migração `20261027` tem o harness
  `db/migrations/verify-20261027-migration.sh` (ver `db/CLAUDE.md`).
- `TestSupport/GlobalDbTruncator` dá `TRUNCATE` (início/fim da suíte) em **todas** as tabelas dos
  schemas configurados, descobertas por catálogo (`TestSupport/TestSchemas`) — não há mock de banco.
  Schemas alvo: propriedade `test.db.schemas` (lista separada por vírgula, default `public,notification,reservation,catalog,identity` no monólito (o `identity` entrou na #36), só o schema do serviço no módulo de cada um (`reservation`, `catalog`, `identity`); vale
  também via env `TEST_DB_SCHEMAS` ou `-Dtest.db.schemas=`), usada também por `SchemaValidationTest`
  (`table_schema = any(?)`). Nomes validados por `[a-z_][a-z0-9_]*` (identificador não é
  parametrizável em SQL). **O default só lista schemas do app** (`TestSchemas.DEFAULT`): os schemas do Supabase (`auth`, `storage`,
  `extensions`...) vivem no mesmo banco e não podem ser truncados nem validados. Cada serviço extraído acrescenta o seu schema
  ao default (Fase 7: `notification`, `reservation`, `catalog`, `identity`). O `GlobalDbTruncator` do monólito também zera o estado do `FakeReservationServer`,
  do `FakeCatalogServer` e do `FakeIdentityServer`
  (os ids de evento voltam a 1 com `RESTART IDENTITY`). O `run-tests.sh` roda o mvn num
  container com env fixo (`--env-file ../.env`): para mudar `test.db.schemas` por ali, passe
  `-e TEST_DB_SCHEMAS=...` no `docker run` do script. Coberto por `TestSchemasTest`.
- `UserTest`, `MyWalletTest` (monólito), `EventTest` (módulo `catalog`, desde a #35) e `EventWalletTest` (módulo `reservation`) exercitam
  services + repositories.
- `CatalogEventSourcingTest` (issue #28; módulo `catalog` desde a #35; ver "Catalog em CQRS + Event Sourcing"): **teste de replay do agregado `Event`**
  (cria/edita/adiciona e remove apresentador/troca imagem/cancela vários eventos, reconstrói `event`/`eventpresenter` na
  sombra a partir do `event_store` e compara com a viva nas colunas comparáveis, sem `image_data` e sem carimbos; uma
  divergência provocada é detectada), tipos e versões contíguas de cada stream, payload sem PII/imagem e com valores
  calculados (o `EventUpdated` não carrega capacidade), evento pré-ES (`version = 0`) recusado, backfill da migração
  `20261022` aplicado 2× (um `EventCreated` v1, replay == viva), conflito de versão (transitório: o command repete; permanente: esgota as tentativas e não grava nada),
  8 updates concorrentes no mesmo evento (log contíguo, sem versão perdida) e `DELETE` que falha por FK desfazendo o
  `EventCancelled`. `EventUpdateAtomicoTest` (issue #60): `updatePolicy` recusado (400, 409, 5xx) ou o fallback de criar o `eventcap`
  falhando não grava nada no catalog; falha na transação do catalog (spy na projeção) não deixa metadados nem apresentadores pela
  metade e o reservation já tem a capacidade nova (a janela documentada); sucesso com versões contíguas e replay == viva.
- Reservation em event sourcing (issue #29; ver "Reservation em event sourcing"): `ReservationEventSourcingTest` (o ciclo
  reserva / confirma / cancela / reserva de novo / expira gera os 4 eventos no mesmo stream com versões contíguas vindas da
  guarda; payload sem dado pessoal; transição que a guarda não aceita não gera evento; conflito de versão no append faz
  rollback de reserva, confirm, cancelamento e expiração), `ReservationReplayTest` (**teste de replay do wallet**: roteiro
  aleatório de 200 jogadas por 6 usuários em 3 eventos; `walletevent` e `ativos` reconstruídos na sombra só do `event_store`
  == vivos nas colunas comparáveis; `ativos` == reservas ativas do `walletevent`), `EventAvailabilityProjectionTest`
  (**ponta a ponta**: reserva → relay → tópico → consumer → `ativos` → `findAvailable`, com relay e consumer ligados e
  `@DirtiesContext`; lag observável; reenvio não conta de novo; e, na #30, o `addLink` do braço `naive`
  (`readPath` trocado por reflexão, restaurado no `finally`) reflete na disponibilidade pela projeção real, com
  `eventcap.quant` intocado, e o `addLink` seguinte é barrado como "Evento lotado"), `EventWalletNaivePathTest` (o braço naive com o consumer
  **desligado**: é o "consumer parado" determinístico que prova o overselling do braço de controle; também confere que o
  naive appenda `SlotReserved` e que a leitura nunca usa `eventcap.quant`), `EventsKafkaConfigTest` (o `RetryListener` loga
  em ERROR a partir da N-ésima tentativa). Os testes ponta a ponta esperam o EFEITO no banco, nunca a atribuição de
  partição do próprio contexto: o tópico tem 1 partição e o mesmo group, e outros contextos Spring em cache também têm o
  listener (todos escrevem no mesmo banco, o checkpoint atômico evita contar duas vezes).
- `IdempotencyRetentionTest` (issue #130): o job apaga chave com `created_at` além do prazo (envelhecida via `UPDATE`) e preserva a recente; repetição com chave ainda retida segue idempotente; apaga em lotes (2500 linhas; o lote de 1000 devolve exatamente 1000); o scheduler tem mais de 1 thread.
- `IdempotencyKeyTest` (issue #24; escopo por usuário na #129): repetição com a mesma `Idempotency-Key` não decrementa `eventcap` de novo
  (sequencial, após `confirm`, e 8 threads concorrentes com a mesma chave), conflito do mesmo usuário com outro evento, mesma chave em usuários diferentes sem colisão,
  falha não deixa chave. O braço `naive` tem o seu em `EventWalletNaivePathTest`; o header/422 em `HttpContractTest`.
- Backbone de eventos (issue #27, `src/test/.../shared/events`, Postgres e Redpanda reais; ver "Event store e backbone
  de eventos"): `EventStoreTest` (append com conflito otimista, outbox na transação do chamador com rollback, leitura de
  stream), `OutboxRelayTest` (publica no tópico na ordem por stream com chave e header `publishedAt`, apaga o outbox,
  falha de envio = rollback, dois relays concorrentes: só um pega o lock), `IdempotentConsumerTest` (checkpoint atômico:
  duplicata, `eventId` divergente, buraco preenchido do `event_store`, buraco que falta = lança, 8 aplicadores
  concorrentes; na #146, o `onBatch`: lote com duplicata, dois streams intercalados, buraco preenchido, `eventId` divergente,
  falha no meio do lote — buraco, JSON inválido e `SQLException` — comitando só o prefixo e acusando o índice via
  `BatchListenerFailedException`, e 8 aplicadores concorrentes do mesmo lote), `EventReplayTest` (**teste de replay**: N eventos, projeção reconstruída do zero na sombra == viva;
  snapshot + cauda == replay completo; as páginas do replay leem o mesmo snapshot, `REPEATABLE READ`), `EventBackboneTest` (ponta a ponta com relay `@Scheduled` + `@KafkaListener` +
  dead-letter topic; política de erro: SQLException transitória é reentregue sem limite e nunca vai ao DLT, buraco
  irrecuperável e JSON inválido vão ao DLT; o listener de teste usa `idIsGroup = false` e um teste confere o `group.id`;
  na #146, um segundo listener `batch = "true"` em outro tópico, com o container pausado para acumular o lote: só a mensagem
  culpada (buraco ou JSON inválido) vai ao DLT e o resto do lote é aplicado, e o erro transitório no meio do lote não vai ao
  DLT; os filtros do DLT usam os streams de cada teste porque o DLT é lido do início e compartilhado).
  Os que precisam de relay/consumer ligam a flag por `@SpringBootTest(properties=...)`; `EventReplay.divergentTables`
  ganhou o overload com `Map<tabela, colunas>` (compara só as colunas informadas: as com `clock_timestamp()` diferem entre viva
  e sombra);
  `EventBackboneTest` usa `@DirtiesContext` para o relay de 50 ms não sobrar no cache de contextos e roubar o outbox
  dos outros testes. Projeção de teste: `TestSomatorio` (tabela `public.test_somatorio`, criada pelos testes e
  derrubada no `@AfterAll` de cada classe: não é schema do app e não sobra no banco compartilhado; nenhum outro teste
  depende dela). O `GlobalDbTruncator` trunca **todas** as tabelas de `public` descobertas por catálogo, `test_somatorio`
  inclusive quando existir; ela só não existe nessa hora. O `SchemaValidationTest` não a menciona. Helpers em `TestSupport/EventsTestSupport` (espera com timeout, leitura de tópico).
- Extração do `notification` (issue #32; ver "Serviço notification"): `IdentityNotificationEventsTest` (monólito: pedido de
  cadastro, reenvio e MFA appendam `VerificationCodeRequested`/`PasswordResetMfaRequested` em `identity.notification` com o
  `event_outbox` na mesma transação e o mesmo código gravado em `pending_verifications`/`users`; falha no append desfaz o cadastro
  pendente; **cadastro, verificação e login funcionam sem o serviço** e o evento sai pelo relay para o tópico) e, no módulo
  `notification`, `NotificationConsumerTest` (Postgres e Redpanda reais + `JavaMailSender` fake via `@MockitoBean`: e-mail de
  verificação e de MFA montados com código/nome/prazo, **mensagem publicada antes do contexto subir é enviada quando ele sobe**,
  **reentrega do mesmo evento não manda dois e-mails**, falha transitória de SMTP reentrega até enviar sem duplicar e sem
  checkpoint prematuro, rejeição permanente do destinatário e JSON inválido vão ao `.DLT` sem travar os próximos, **código já
  vencido não é enviado**, evento sem `expiresAt` vai ao `.DLT`, tipo desconhecido não envia), `RejeicaoPermanenteTest` (unitário:
  usuário inexistente = permanente; quota/limite de taxa do remetente, falta de conexão e autenticação = reentrega) e
  `NotificationEventRetentionTest` (monólito, retenção do dado pessoal: vencido há mais de 30 s e já publicado some; dentro da
  carência, ainda válido, ainda no outbox e outro stream ficam). O group do teste (`notification-test`) é próprio, nunca o do
  serviço vivo.
- Extração do `reservation` (issue #33; ver "Serviço reservation"). **Módulo `reservation`** (Postgres e Redpanda reais): os testes que
  eram do monólito vieram com ele (`EventWalletTest`, `WalletEventStateMachineTest`, `IdempotencyKeyTest`, `IdempotencyRetentionTest`,
  `ReservationEventSourcingTest`, `ReservationExpiryTest`, `ReservationReplayTest` — o **replay do wallet** —,
  `EventAvailabilityProjectionTest` — o **ponta a ponta do naive**, agora pelo `ReservationClient` real por HTTP —,
  `ReservationSchemaConstraintsTest`, `SchemaValidationTest`), adaptados a "usuário e evento são só ids" (`ReservationTestSupport`).
  `EventWalletNaivePathTest` agora cobre o lado do SERVIÇO do naive (reserva sem CAS, sem checar disponibilidade; leitura separada).
  Novos: `ReservationApiE2ETest` (**o cliente REAL contra o serviço REAL por HTTP**: CAS sob 40 threads com overselling 0; naive com
  consumer parado oversella; **as duas chamadas HTTP do naive** — `disponibilidade` e DEPOIS `reservar`, por `InOrder` no controller —
  e só uma no cas; "lotado" já na 1ª chamada; repetição com chave do cliente devolve o resultado salvo; mapeamento 400/422/409;
  **criação do `eventcap` idempotente por `event_id`**; lote/inexistente; `updatePolicy`; apagar recusado com reserva),
  `CatalogReconciliationTest` (**reconciliação pelo `EventCreated`** do tópico: cria o que faltava, repetição/reentrega não altera,
  `eventcap` da chamada síncrona não é sobrescrito, tipos que não são `EventCreated` ignorados, payload inválido rejeitado; `capacity` 0 ou &lt; -1 — que o CHECK `eventcap_capacity_valid` recusaria, #58 — também é payload inválido e vai ao DLT em vez de travar a partição) e
  `ReservationConfigTest` (Tomcat 300, keep-alive, virtual threads off, Hikari 1000, `events.schema=reservation`). **Módulo
  `monolito`**: `EventWalletGatewayCasTest` / `EventWalletGatewayNaiveTest` (o gateway decide o braço: cas = UMA chamada
  `POST /internal/reservations`; naive = `GET .../availability` e DEPOIS `POST`, na ordem, sem a 2ª quando a disponibilidade é 0; carteira e
  evento conferidos no monólito antes de qualquer chamada; validação compõe os erros na ordem de antes; criar evento com o reservation
  fora NÃO quebra e o `eventcap` é idempotente), `EventsSchemaTest` (schema do event store e chave do advisory lock por serviço),
  `ModuleBoundaryArchTest` (nada depende do pacote `reservation`; `reservationclient` só é lib) e o `CatalogEventSourcingTest`
  (`eventcap` removido do serviço no cancelamento; o delete recusado pelo reservation, 409, desfaz o `EventCancelled`).
- `HttpContractTest` (`webEnvironment = RANDOM_PORT` + `TestRestTemplate`) fixa path + método
  + forma de request/response de cada endpoint `/bff/**` que o Flutter consome — bate no
  HTTP real (inclusive `SecurityConfig`), não MockMvc. Desde a #32 não há mock de `JavaMailSender` (o monólito
  não tem SMTP); `RECAPTCHA_SECRET_KEY` é forçada vazia via `@TestPropertySource` para não depender do Google real. **Sem mudança de
  expectativa na #33**: as chamadas de reserva/capacidade vão ao `FakeReservationServer` (HTTP de verdade). **Mudança de contrato na #57**
  (IDOR em `/bff/event-wallets/**`): `userId` divergente do dono do token dá 403 nos 5 endpoints, e `userId` ausente vale o do token
  (`eventWallet_tokenDeAnaoAgeEmNomeDeBeto_returns403NosEndpoints`, `eventWallet_proprioUsuario_comESemUserId`,
  `eventWallet_semToken_returns401NosEndpoints`). **Mudança de contrato na #166**: o id de usuário no path de `/bff/users/{id}/**` e de
  `/bff/my-wallets/**` tem de ser o do token (403 caso contrário; id inexistente também é 403, não mais 404) e o `PUT` recusa e-mail de outra conta (400).
- `gateway/ErroInternoNoCorpoTest` (issue #89): todo 500 do `gateway/*` devolve o corpo genérico `ErroInterno.MENSAGEM` (o `Map` do reCAPTCHA
  mantém `success`/`error`) e a mensagem da exceção (detalhe de SQL/infra) vai só para o log SLF4J (`log.error("...", ex)`, com stack trace).
  MockMvc standalone com as dependências mockadas falhando, sem Spring/banco. Os 400 de negócio continuam com a mensagem da exceção (é contrato
  que o Flutter mostra). Controller novo no `gateway`: nunca ecoe `getMessage()` num 500.
- Quase tudo é teste de integração com banco (exceto os mocks pontuais do `HttpContractTest` para dependências externas
  e o `ErroInternoNoCorpoTest`, MockMvc standalone sem Spring/banco).
- Serviço `admission` (#41; ver "Serviço admission"): módulo `admission-client` — `AdmissionClientTest` (sem Spring, servidores HTTP do JDK: pedido e token enviados, **fail-open** em 5xx, conexão
  recusada, timeout de resposta e 401 (este com log ERROR), **400 não falha a reserva (sync, sem contar) e não conta para o disjuntor**, **disjuntor** abre com 5 falhas seguidas e fecha na sonda bem-sucedida, sonda que falha
  reabre, sucesso zera a contagem, log com limite de taxa e a contagem acumulada, construção sem token). Módulo `admission` (Redis REAL, sem Postgres): `RpmCounterTest` (contagem, conversão em
  RPM pelo tempo coberto (**taxa constante de 12.000 RPM lida certa em qualquer ponto do bucket**), **janela que desliza**, leitura que não conta nem cria chave, eventos independentes, **TTL em toda chave**, bucket/janela configuráveis, 400 chamadas concorrentes sem perda, janela que não é
  múltiplo do bucket recusada), `AdmissionApiTest` (**401 sem/errado em toda rota, inclusive `/internal;x=1/...`**, contrato do `POST` e do `GET .../rpm`, os 400 e que não contam, e o
  `AdmissionClient` REAL contra o serviço REAL), `AdmissionRedisRecusadoTest` e `AdmissionRedisTravadoTest` (**Redis recusando conexão (503 na hora) e Redis CONGELADO com a conexão aberta, por um proxy TCP do teste que para de repassar: `POST` e `GET .../rpm` dão 503 no timeout de 200 ms**, para o disjuntor do gateway contar a falha; medido com o `HttpClient` do JDK, porque o `TestRestTemplate` repete resposta 503 depois de 1 s) e `AdmissionConfigTest` (porta 8085, Tomcat 300, sem datasource, defaults do contador, sem token o serviço não sobe). Módulo `monolito`: `FakeAdmissionServer`
  (`TestSupport`, JDK `HttpServer`, `LauncherSessionListener` `AdmissionFakeSession`, URL em `admission.service.url`; devolve `sync` por padrão, valida a chave, exige o token e deixa injetar falha) —
  é o que mantém o `HttpContractTest` **sem mudança de expectativa** e sem Redis —, `EventWalletGatewayAdmissionTest` (uma chamada por `addLink`, depois das validações e ANTES do reservation,
  com a chave do cliente igual nos dois serviços; **sem chave, o UUID vai só ao admission e o reservation recebe SEM header `Idempotency-Key`**; chave > 255 ignorada pelo admission e recusada pelo reservation com o 400 de sempre; **fail-open** com o admission em 503 e o **disjuntor abrindo após 5 falhas seguidas**) e o teste do braço naive em
  `EventWalletGatewayNaiveTest` (conta com `path=naive` antes da leitura da disponibilidade); o `ModuleBoundaryArchTest` ganhou `admissionclient`.
- `identity-client` (#36): `IdentityClientIndisponivelTest` (sem Spring/banco, servidores HTTP do JDK: porta morta, 500 e resposta lenta →
  `IdentityUnavailableException`, uma chamada por falha, sem retry; 404 e 401 com/sem marcador; 400; construção sem token; contrato feliz).
- `LayerBoundaryArchTest` e `ModuleBoundaryArchTest` (ArchUnit) são a exceção: não usam Spring/banco, só analisam bytecode.
  Roda em qualquer `mvn test`, com ou sem `db` no ar.

## Quality gates (Checkstyle + ArchUnit) — issue #83

- `maven-checkstyle-plugin` roda no `mvn test`/`mvn clean test` (preso na fase `validate`,
  antes de compilar) — por isso `./run-tests.sh` já quebra se uma regra travar. Config em
  `checkstyle.xml`, baseline de violações antigas em `checkstyle-suppressions.xml` (ambos na
  raiz de `Backend/`, valendo para todos os módulos; as `suppress` casam por nome de arquivo, não por caminho).
  - Rodar isolado (sem subir o resto da suíte): `mvn checkstyle:check` (ou `mvn validate`).
    Via Docker, sem precisar do container `db`:
    ```
    docker run --rm -v gerenciador-eventos-m2:/root/.m2 \
      -v "$(pwd -W)":/workspace-src:ro maven:3.9.7-eclipse-temurin-21-jammy \
      bash -c 'mkdir -p /tmp/build && cp -r /workspace-src/* /tmp/build/ && cd /tmp/build \
        && mvn -Dmaven.repo.local=/root/.m2/repository checkstyle:check'
    ```
  - Regras hoje: `FileLength` (máx. 350 linhas, só `src/main/java` — medido em 2026-09-04:
    a maioria dos arquivos fica bem abaixo de 300; só `BffUserController.java` (465) e
    `UserRepository.java` (351) violavam, e estão na baseline) e `RegexpSinglelineJava`
    banindo `System.out/err.print*`/`println` (id `ProibirConsoleDireto` — baseline:
    `UserRepository.java`; o do `EventRepository.java` saiu na #28) e
    `printStackTrace()` (id `ProibirPrintStackTrace` — zero ocorrências, já trava sem
    baseline). Use um logger SLF4J (`org.slf4j.Logger`/`LoggerFactory`, ver
    `reservation/ReservationExpiryService`) em vez de escrever direto no console.
  - Método "medir antes de travar": regra sem violação nasce em `error` sem entrada na
    baseline; regra com violação existente também fica em `error`, mas os arquivos que já
    violavam no dia em que a regra entrou ganham uma linha em `checkstyle-suppressions.xml`
    (não corrigidos por essa issue — é o próximo passo). Corrigiu um arquivo da baseline?
    Remova a linha dele do suppressions.
- ArchUnit (`archunit-junit5`, em `monolito/src/test/java`), dois testes, sem baseline (zero violações):
  - `LayerBoundaryArchTest` trava se o pacote `gateway` (controllers) depender direto de uma classe
    `@Repository` (DAO) ou de JDBC cru
    (`java.sql.Connection/PreparedStatement/Statement/ResultSet/DriverManager`) — acesso a dado
    deve passar por `Service`.
  - `ModuleBoundaryArchTest` (issue #23) trava: (a) `identity`/`catalog`/
    `gateway` só dependem de outro módulo por `<modulo>.api` (nenhum módulo importa `gateway.*`; `notification` saiu do
    monólito na #32 e o `reservation` na #33: nada depende do pacote `com.gerenciador.eventos.reservation`, e o `reservationclient`
    — a lib de contrato — não depende de módulo do monólito); (f) `monolito_nao_envia_email` (#32): nada do monólito depende de
    `org.springframework.mail..`/`jakarta.mail..` — o e-mail é do serviço `notification`;
    (g) `admissionclient` (#41) é lib de contrato como as outras (não depende de módulo do monólito nem das outras libs) e nada depende do pacote `com.gerenciador.eventos.admission` (o código do
    serviço); (b) `shared` não depende de módulo de domínio; (c) todo código de produção mora num módulo (nada volta para
    `POJO/Repository/Service`); (d) `<modulo>.api` não depende de classe interna de módulo nenhum
    (só de outros `*.api`, `shared` e libs); (e) `@RestController`/`@Controller` só no `gateway`
    (`controller_so_no_gateway`, issue #25: os demais módulos não expõem HTTP). Ver "Módulos".
  - Rodar isolado: `mvn -Dtest='LayerBoundaryArchTest,ModuleBoundaryArchTest' -DfailIfNoTests=false test`
    (não precisa do container `db`, mesmo comando funciona no container Maven efêmero do
    `run-tests.sh`).

## Módulos (pacote `com.gerenciador.eventos`) — issues #23, #25 e #36

Na Fase 5 o monólito foi dividido em pacotes-por-serviço (mesmo processo, deploy e banco), preparando a decomposição em microsserviços
(CQRS/ES na Fase 6, extração na Fase 7). **Hoje, depois da #36, só sobrou o `gateway` no monólito (`monolito/`)**: o `notification` saiu na #32, o
`reservation` na #33, o `catalog` na #35 e o `identity` na #36 — cada um é um módulo Maven/serviço próprio (ver "Layout multi-módulo Maven"). O
monólito fala com os três últimos por HTTP (libs `*-client`) e com o `notification` só por evento no backbone. Dentro de cada módulo as classes ficam
**planas** (sem `POJO/`/`Repository/`/`Service/`), mais o subpacote `api`: as **interfaces e DTOs públicos** que os outros módulos podem usar.

```
Main.java        entrypoint @SpringBootApplication (único no monólito; o component scan cobre os subpacotes)
gateway/         BffUserController, BffEventController, BffEventWalletController, BffMyWalletController,
                 BffSeedController (@RestController, paths /bff/**) + SeedData; roteia e agrega, sem domínio.
                 EventWalletGateway (#33): decide o braço cas/naive e chama o reservation por HTTP (desde a #36 NÃO confere mais a carteira)
                 CatalogIndisponivelHandler (#35): catalog fora => 503 genérico; CreatorNames (creator_name por composição)
                 IdentityIndisponivelHandler (#36): identity fora => 503 genérico (log só da classe)
  security/      (#36) SecurityConfig (cadeia deny-by-default de /bff/**), JwtAuthenticationFilter (filtro próprio, bearer inválido em rota
                 pública segue anônimo), JwtDecoderConfig (NimbusJwtDecoder + JWKSource montado à mão), JwtAuthorization, HostAuthorizationApi
                 (currentUserId() = claim `uid`; ensureUserIsHost() = claim `isHost`; sem consulta)
shared/          CorsConfig, SchedulingConfig (monólito); DatabaseConnection e shared.events (módulo `shared`, lib): infra de event sourcing sem
                 domínio (#27): EventEnvelope, NovoEvento, EventStore, OutboxRelay, IdempotentConsumer + Projection, EventReplay,
                 EventSnapshots/Snapshot, EventsKafkaConfig, NotificationEvents (#32: contrato do stream identity.notification)
identityclient/  (lib `identity-client`, #36) IdentityClient (HTTP, pool), IdentityClientConfig (o bean, no monólito)
  api/           User, MyWallet, LoginResult, RecaptchaResponse, UserApi, EmailVerificationApi, MyWalletApi (`walletExists`, não `exists`: o cliente
                 implementa as duas interfaces), RecaptchaApi, IdentityUnavailableException, IdentityNaoEncontradoException
admissionclient/ (lib `admission-client`, #41) AdmissionClient (HTTP, pool, fail-open, disjuntor), AdmissionClientConfig (o bean, no monólito), LogComLimite
  api/           AdmissionApi, AdmissionRequest, AdmissionResult, AdmissionStatus (#42)
catalogclient/   (lib `catalog-client`, #35) CatalogClient (HTTP, pool), CatalogClientConfig (o bean, no monólito)
  api/           Event, EventApi, EventoNaoEncontradoException, EventoEmConflitoException, CatalogUnavailableException
reservationclient/ (lib `reservation-client`, #33) ReservationClient (HTTP, pool), ReservationClientConfig (o bean, no monólito)
  api/           EventCap, EventWallet, IdempotencyConflictException (DTOs/erros do contrato), EventCapacityApi, EventWalletApi
```

Os pacotes `identity`, `catalog`, `reservation` e `notification` NÃO estão em `monolito/`; o código deles mora nos módulos de mesmo nome:
`identity/` (UserService, UserRepository, EmailVerificationService, PendingVerification(+Repository), MyWalletService/Repository,
IdentityNotifications e IdentityEvents, JwtSigningKey + JwtIssuer, RecaptchaService, controllers internos — ver "Serviço identity"),
`catalog/` (EventService, CatalogEventWriter... — "Serviço catalog"), `reservation/` (EventWalletService, CAS, expiração, projeção... — "Serviço
reservation") e `notification/` (consumer + e-mail — "Serviço notification").

- **Regra de fronteira**: um módulo (e o `gateway`) só enxerga outro módulo pelo pacote `<modulo>.api` (ou pela lib `*-client`);
  nunca importa `Repository`/`Service`/config interno de outro. `shared` não depende de módulo de
  domínio (módulos dependem dele). Dado de outro módulo entra por id ou DTO da `api`. Travado por
  `ModuleBoundaryArchTest` (ver "Quality gates"). Desde a #33/#35/#36 a fronteira é também física: o monólito não tem o código dos serviços
  no classpath e **nenhum serviço lê tabela de outro nem há FK cross-schema**.
- **Grafo de dependências**: `gateway →` (por **HTTP**) `admission` (`admissionclient`, #41, fail-open), `reservation` (`reservationclient`), `catalog` (`catalogclient`, #35) e `identity`
  (`identityclient`, #36); `catalog → reservation` por **HTTP** (`EventCapacityApi` da lib `reservation-client`: criar a capacidade DEPOIS do
  commit do evento, `updatePolicy`, hidratar `lot_quantity`/`quantity` — `findByCreatorId` e a busca em UMA chamada em lote —, remover no
  cancelamento); `identity → notification` só por evento (`identity.notification`, congelado). O `reservation` não enxerga o catálogo (a existência
  do evento é o `eventcap` dele, mais a conferência do gateway), só recebe o `EventCreated` do tópico. Quem valida o `creator_id` com
  `UserApi.exists` é o `gateway` (o `catalog` não conhece usuário).
- **`gateway` é módulo, não container (issue #25)**: o antigo pacote `bff` virou `gateway` (roteamento + agregação). Desde a #36 ele é tudo o que
  resta no container `gerenciador-backend`. Os paths HTTP continuam `/bff/**` (o contrato do Flutter não mudou; `HttpContractTest` é o juiz). Os controllers só
  roteiam e agregam via `*.api`. As regras de rota/segurança de `/bff/**` ficam em `gateway/security/SecurityConfig` (única cadeia
  deny-by-default, auditável num arquivo só).
- **Serviço fora do monólito não volta a ser pacote**: `nada_depende_do_codigo_do_servico_reservation` (e os equivalentes do catalog e do identity,
  ArchUnit) trava.
- **Decisões**: `SeedData` fica em `gateway` (é o corpo do `POST /bff/seed` e agrega `User`+`Event`+`EventWallet` de três serviços); o envio de
  e-mail saiu de `EmailVerificationService` para `notification` (#23) e, na #32, de dentro do monólito (o cadastro em duas fases fica no `identity`,
  que só publica o evento); as `*Api` são implementadas pelas classes dos serviços (`UserService implements UserApi`, `EventService
  implements EventApi`...) e pelos clientes HTTP (`IdentityClient implements UserApi`...), sem classe de adaptação.
- Módulo novo ou chamada entre módulos nova → exponha só o necessário em `<modulo>.api`.

## Persistência — JDBC puro, não JPA

- Os `*Repository` usam `shared.DatabaseConnection.getConnection()` +
  `PreparedStatement` com SQL escrito à mão. `try-with-resources` para fechar conexão.
- `DatabaseConnection` delega ao `DataSource` do Spring (pool **HikariCP**, issue #96), não a
  `DriverManager`: `close()` devolve a conexão ao pool. Tamanho do pool:
  `spring.datasource.hikari.maximum-pool-size` (env `SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE`,
  default 1000 no reservation, 10 no monólito desde a #36 e 100 no catalog e no identity; o Hikari pede conexões ao **pooler** (não ao Postgres), então quem limita o Postgres é
  `POOLER_DEFAULT_POOL_SIZE` (ver "Pooler"). Em conexão direta (testes), o `db` do compose padrão tem
  100, então lá reduza o pool por env) e
  `spring.datasource.hikari.minimum-idle` (env `SPRING_DATASOURCE_HIKARI_MINIMUM_IDLE`, default 5:
  o pool cresce sob demanda). **Cada contexto Spring de teste distinto tem seu próprio pool**; sem
  `minimum-idle` pequeno, N contextos em cache segurariam N×50 conexões e estourariam o
  `max_connections`. Coberto por `ConnectionPoolTest` e `ConnectionPoolSizeTest`.
- `spring-boot-starter-data-jpa` está no classpath e `spring.jpa.hibernate.ddl-auto=update`
  está setado, **mas não há nenhuma `@Entity`** → Hibernate não cria/altera nada.
- O schema é definido em `db/init-scripts/*.sql`. Para alterar o modelo, edite o SQL lá
  (ver `db/CLAUDE.md`), não crie entidade.
- **POJO ≠ coluna.** Ex.: `Event` usa `is_EAD`; a tabela `event` tem `ead`. A conversão é
  feita à mão em cada repository — ao mexer num campo, ajuste o mapeamento nos dois lados.
- **`Event` é um POJO de transporte.** Ele ainda carrega `lot_quantity` (= `eventcap.capacity`, do serviço reservation, lido por HTTP),
  `quantity` (= `eventcap.quant`), `buy_time_limit` e `presenters`, mas esses campos **não
  são colunas de `event`**: `EventRepository.save` grava o `eventpresenter` (pela projeção do `EventCreated`, ver "Catalog em CQRS + Event Sourcing") e
  `EventService.createEvent` cria o `eventcap` no serviço reservation por HTTP logo DEPOIS do commit; `EventService.hydrate(...)` os relê de volta ao sair
  do service. `lot_quantity` na criação: **`>= 1`** (capacidade fixa) ou **`-1`** (sem limite
  de vendas). Constante `EventCap.UNLIMITED == -1`; use `EventCap.isUnlimited()`.
  `buy_time_limit` não informado (`null`) ⇒ `EventService.applyDefaults` iguala à data do
  evento — roda no `createEvent` **e** no `updateEvent`.
- **Busca de eventos sem N+1 (issue #109).** `EventService.searchEvents` filtra no banco
  (`EventRepository.searchByName`: `lower(event_name) LIKE lower(?) ESCAPE '\'`, `%`/`_`/`\` do
  termo escapados; termo em branco = todos, ordem `event_id`) e hidrata em lote
  (`EventService.hydrateAll` → `EventCapacityApi.findByEventIds` (UMA chamada HTTP ao reservation, `ids=1,2,3`) /
  `EventPresenterRepository.findByEventIds`, `event_id = ANY(?)`): 2 consultas + 1 chamada no total,
  independente do nº de eventos. `hydrate` (1 evento) segue igual; `findByCreatorId` filtra no banco
  (`WHERE creator_id = ?`, índice `idx_event_creator_id`, issue #35) e hidrata em lote. Coberto por `EventSearchTest` e `EventTest` (módulo `catalog`).
- **Agregado `eventcap` isolado.** `EventCapRepository` faz a reserva de vaga por `UPDATE`
  condicional atômico (`tryReserve` → `false` = lotado) e a devolução (`release`). Os métodos
  que precisam ser atômicos com `walletevent` recebem a `Connection` da transação do service. (Desde a #33 isso é do **serviço reservation**, schema `reservation`.)
  Para evento ilimitado (`capacity = -1`) `tryReserve`/`release` são no-op e
  `EventWalletService` trata a reserva como sempre permitida.
- Nomes de tabela em minúsculas. **`public`** (monólito): só a infra da lib `shared` (`event_store`, `event_outbox`, `event_snapshot`,
  `projection_checkpoint`; usada pelos testes de `shared.events`; o monólito não tem tabela de domínio). **`identity`** (#36): `users`, `mywallet`,
  `pending_verifications` e o event store próprio (`identity.notification` e `identity.user`). **`catalog`** (#35): `event`, `eventpresenter` e o event
  store próprio. **`reservation`** (#33): `eventcap`, `walletevent`,
  `event_availability`, `idempotency_key` e o event store próprio (`event_store`, `event_outbox`, `event_snapshot`,
  `projection_checkpoint`). **`notification`** (#32): `processed_event`. Sempre qualificar com o schema nas queries (nada de
  `search_path`: o Supavisor em transaction mode proíbe).

### Pooler (Supavisor, transaction mode) — issue #19

O backend **em Docker** fala com o Postgres pelo Supavisor, não direto: no `environment:` do
`backend` em `Projeto/docker-compose.yml`,
`SPRING_DATASOURCE_URL=jdbc:postgresql://supabase-pooler:6543/meu_banco?prepareThreshold=0` e
`SPRING_DATASOURCE_USERNAME=${POSTGRES_USER}.gerenciador-eventos` (formato `<role>.<tenant>`; o
tenant `gerenciador-eventos` é fixo, ver `Projeto/supabase/README.md`). O `application.properties`
mantém o default de dev direto em `localhost:5433`, e os testes (`run-tests.sh`, `--env-file
../.env`) seguem **direto** no `db:5432`, pela URL do `Projeto/.env`.

- **`prepareThreshold=0`** é o que o PgJDBC precisa: ele só promove um `PreparedStatement` a
  prepared statement nomeado no servidor depois de 5 execuções, e em transaction pooling a próxima
  execução cairia em outra conexão do Postgres (erro típico "prepared statement ... does not exist").
  Com `0`, tudo vai pelo protocolo estendido não nomeado, que o Supavisor aceita.
- **Compatível com transaction pooling porque** (auditoria de `src/main`, 2026-10-16; atualizada na #27): nenhum
  `SET`/`SET LOCAL`/`SET ROLE`/`set_config`, `search_path`, advisory lock **de sessão** (`pg_advisory_lock`...; a
  única exceção é o `pg_try_advisory_xact_lock` do `OutboxRelay`, **permitido porque é de transação**: o Postgres o
  solta sozinho no commit/rollback, na mesma conexão que o Supavisor segura até lá),
  `LISTEN`/`NOTIFY`, `TEMP TABLE`, `PREPARE`/`DECLARE CURSOR` nem `DISCARD`. Os 15 `SET` do código
  são todos de `UPDATE ... SET` / `ON CONFLICT DO UPDATE SET`; a única outra exceção (#27) é o
  `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` do `EventReplay`, que vale **só para a transação** em que é o
  primeiro statement (não é estado de sessão, some no commit/rollback). Fica proibido
  `conn.setTransactionIsolation(...)`: no PgJDBC ele grava estado de sessão. Não há `search_path` (as tabelas vão sempre qualificadas
  com o schema do serviço) nem `connectionInitSql` no Hikari
  nem `setReadOnly`/`setCatalog`/`setSchema`/`setTransactionIsolation`. O único estado de conexão
  mexido é `setAutoCommit(false)` → `commit`/`rollback` → `setAutoCommit(true)` (em
  `EventWalletService`, `ReservationExpiryService`, `CatalogEventWriter`, e, em `shared/events`, `EventReplay`, `IdempotentConsumer`, `OutboxRelay`),
  que o PgJDBC traduz em `BEGIN`/`COMMIT`: a transação inteira (incl. o CAS de `eventcap` e o
  `walletevent`) roda numa conexão real só, que o Supavisor segura até o `COMMIT`/`ROLLBACK`.
  `DatabaseConnection` só devolve conexões do `DataSource`. **Código novo não pode** depender de
  estado de sessão (`SET`, advisory lock de sessão, `LISTEN`, temp table, prepared statement
  nomeado): em transaction mode ele vaza entre clientes ou some.
- **Dimensionamento** (números literais em `Projeto/supabase/docker-compose.pooler.yml`): `POOLER_MAX_CLIENT_CONN=1500` tem de ser >= a
  SOMA dos Hikari de todos os serviços no tenant (senão o Supavisor recusa cliente): **reservation 1000 + monólito (gateway) 10 + notification 3
  + catalog 100 + identity 100 = 1213** (1463 com o `stock` e seus 250, #47) (1353 na #33, 1453 na #35, 1213 na #36: o gateway deixou de tocar em tabela de domínio e caiu de 350 para 10, e o identity entrou com 100; antes era um Hikari de 1000 só, no monólito). O override de carga (`carga/docker-compose.carga.yml`) mantém o backend em 10 (com 350 a soma seria 1553 > 1500). Conexões reais ao Postgres: `POOLER_DEFAULT_POOL_SIZE=45` para o `max_connections=100`
  do compose padrão (+ `DB_POOL_SIZE=5` do próprio Supavisor, 3 reservadas do superuser,
  testes e psql); com `carga/rpm` (`max_connections=300`) o pool vai para 245 sozinho (override + `subir-host-rpm.ps1`). Ou seja,
  o `too many clients` não vem mais do Hikari, e sim do pool do Supavisor + o resto passar do
  `max_connections`.
- **O `admission` (#41) não tem datasource**: não depende de `shared` (que traz o `DatabaseConnection`), não tem Hikari nem tabela e não fala com o Postgres, então a conta abaixo (1213 &lt;= 1500) e o
  pool real do Supavisor **não mudam**.
- **Outros clientes do pooler** (#32, #33, #35, #36): o `notification` (Hikari 3), o `reservation` (Hikari 1000), o `catalog` (100) e o `identity` (100) entram pelo **mesmo tenant e o mesmo
  usuário** do monólito e NÃO aumentam o pool real (a conta está em "Serviço notification", "Serviço reservation", "Serviço catalog" e "Serviço identity"). Todo serviço novo
  divide esses mesmos 45/245: documente o Hikari dele e refaça a conta antes de subir.
- **Threads do Tomcat** (issue #124): `server.tomcat.threads.max` = 300 (env `SERVER_TOMCAT_THREADS_MAX`;
  o default do Spring Boot é 200), **no monólito/gateway, no reservation, no catalog e no identity**. Na configuração de carga o caminho quente é o `reservation`:
  Tomcat 300, Hikari 1000, pool do Supavisor 245 (a tabela por serviço está em "Serviço reservation"). Os testes de 2026-10-17 pelo pooler deram o mesmo teto de vazão com 200, 300 e 400 threads, mas 300
  teve o menor p95 (matriz CAS N=200: 155 → 114 ms; escada 50k–70k: 180–319 ms contra 192–392 ms com 200).
  **Virtual threads ficam desligadas** (padrão; não há `spring.threads.virtual.enabled`): sobem a vazão
  (~99k efetivos), mas pioram o p95 — a prioridade é a menor latência. Coberto por `TomcatThreadsTest`.
- Os logs do Supavisor trazem `User requested SSL connection but no downstream cert/key found`:
  o PgJDBC tenta SSL (`sslmode=prefer`), o pooler (sem cert) recusa e ele cai para texto puro, na
  rede interna do Docker. É inofensivo.

## Event store e backbone de eventos — issue #27 (ADR "Event-Backbone-Event-Store")

Diagrama command / evento / projeção / replay da Fase 6 (`catalog` e `reservation`): [`docs/arquitetura/fase6-cqrs-es.md`](/gerenciador-eventos/docs/arquitetura/fase6-cqrs-es).

Infra genérica de CQRS + Event Sourcing em `shared/events` (sem domínio; a #28 converteu `catalog`, ver a seção
seguinte, e a #29 converte o lado wallet de `reservation`, só appendando eventos com o seu `streamType`). Broker: **Redpanda** (container
`gerenciador-redpanda`, `redpanda:9092` na rede `gerenciador-net`, sem porta no host; imagem com tag fixa no compose;
`docker exec gerenciador-redpanda rpk topic list` para inspecionar). Cliente: `spring-kafka` (versão do Boot).
**Um event store POR SERVIÇO (#33):** a infra é parametrizada pelo schema do serviço (`events.schema`, env não exposta; default `public` =
o monólito; `reservation` no `reservation/application.properties`). `EventStore.tabela("event_store")` devolve o nome qualificado e o
`OutboxRelay`, o `IdempotentConsumer` (que confere o `eventId` e lê/avança o checkpoint), o `EventReplay` (tabelas vivas e sombra) e o
`EventSnapshots` usam o mesmo, então o `reservation` tem `reservation.event_store`/`event_outbox`/`event_snapshot`/`projection_checkpoint`
e **nenhum serviço lê a tabela de outro** (o consumer do `reservation` não olharia o `public.event_store` do catalog). O **advisory lock do relay é
por schema** (`OutboxRelay.lockKey`: `public` mantém `LOCK_KEY`; os outros derivam do nome), senão os relays de serviços diferentes se
serializariam (o lock é do BANCO) e inflariam o lag medido. Streams: `identity.notification` (#32; ver "Serviço
notification": a única exceção à regra de não pôr dado pessoal no payload) em `identity.event_store` (desde a #36; a migração `20261028` move os que já existiam de `public`) ao lado do `identity.user` (ciclo de vida, só ids); `reservation.wallet` em
`reservation.event_store` (a migração `20261025` move os que já existiam); `catalog.event` em `catalog.event_store` (#35; a migração
`20261026` move os que já existiam). Registrado também na ADR do backbone.
Esta infra vive no módulo Maven `shared` (lib); os testes dela, em `monolito/src/test` (schema `public`) e, para o schema `reservation`, nos do módulo `reservation`.

- **`EventStore.append(Connection, NovoEvento)`**: um único statement (`INSERT ... ON CONFLICT (stream_type, stream_id,
  version) DO NOTHING` + `INSERT` em `event_outbox` num CTE). Devolve `Optional<EventEnvelope>`: **vazio = a versão já
  existe** (conflito otimista; sem `unique_violation`, então a transação do chamador segue viva e ele decide: rollback e a
  resposta da corrida, ou repetir o command). Usa a `Connection` do chamador: evento e outbox só valem com o commit dele.
  `readStream(conn, tipo, id, deVersao)` lê o stream em ordem de `version`. A `version` esperada vem do estado lido na
  mesma transação (na reserva, do `UPDATE walletevent ... RETURNING version`). `partitionKey` (coluna `partition_key`) é
  a chave da mensagem: o id do evento DE DOMÍNIO, passado pelo chamador. **Sem dado pessoal no `payload`.**
- **`OutboxRelay`** (`events.relay.enabled`): `@Scheduled` a cada `events.relay.interval-ms` (50), drena até esvaziar; uma
  transação por lote (`events.relay.batch-size`, 200): `pg_try_advisory_xact_lock` → lê `event_outbox ⋈ event_store ORDER
  BY global_position LIMIT n` (sem `SKIP LOCKED`) → envia tudo e espera os acks → apaga o lote → commit. Falha de envio =
  rollback, o lote volta no tick seguinte (at-least-once). Tópico = `streamType`; chave = `partition_key`; header
  `publishedAt`; corpo = o envelope em JSON. Producer idempotente, `acks=all`, `max.block.ms`/`delivery.timeout.ms` curtos.
  O relay roda no scheduler do Spring (`spring.task.scheduling.pool.size`, 3 desde a #130, ver "Config"): o loop
  `drain()` ocupa uma das threads enquanto houver outbox; o relay está ligado no compose desde a #28: conferir se 3 threads bastam
  para o relay, `ReservationExpiryService` e `IdempotencyKeyRetentionService` junto com a medição da #31.
- **`IdempotentConsumer`** (`events.consumer.enabled`): o listener de cada projeção chama
  `onMessage(Projection, json, ack)` (uma mensagem por transação) ou `onBatch(Projection, List<json>, ack)` (#146, abaixo). Por mensagem, numa transação (checkpoint + projeção) e com ack manual depois do
  commit: confere o `eventId` no `event_store` (inexistente/diferente = descarta), descarta `version <= checkpoint`, relê
  as versões que faltam (`checkpoint+1 .. version`) e avança o checkpoint por CAS (`UPDATE projection_checkpoint ... WHERE
  version = v-1`; `INSERT ... ON CONFLICT DO NOTHING` na v1) aplicando só se o rowcount for 1. `Projection` = `name()`, `tables()`,
  `apply(conn, evento, schema)`. **Política de erro** (`EventsKafkaConfig`; o DLT é só para o que reentregar não
  conserta): (1) erro **transitório** (`SQLException`, conexão caída, pool esgotado — qualquer outro): backoff exponencial
  (`events.consumer.retry.interval-ms`, dobra até 30 s) **sem limite e sem DLT**, sem avançar o offset (mandar ao DLT
  perderia, por exemplo, o último evento de um stream); (2) **buraco irrecuperável** (`EventGapException`: a versão
  anterior não existe nem no `event_store`; não avança nada): `events.consumer.retry.max-attempts` retries a cada
  `interval-ms` e depois `<tópico>.DLT`; (3) **payload inválido** (`InvalidEventMessageException`: JSON quebrado/sem campos
  obrigatórios): DLT direto, sem retry.
  - **Em lote (`onBatch`, issue #146).** As mensagens do lote, na ordem, rodam a MESMA lógica de cima (`tentar`) na MESMA
    transação: um commit e um ack (`ack.acknowledge()` depois do commit) por lote, em vez de um por mensagem. Duplicata e
    várias versões do mesmo stream no lote funcionam porque a leitura do checkpoint, na mesma conexão, enxerga o avanço ainda
    não comitado; perder a corrida do CAS para outro aplicador desfaz e refaz o lote inteiro. **Falha na mensagem `i`
    (decisão): comita o prefixo `0..i-1` e acusa só a `i`.** A transação inteira é desfeita, as `0..i-1` são reaplicadas e
    comitadas numa transação nova e então se lança `BatchListenerFailedException(i)` (causa = a exceção original); o `DefaultErrorHandler` comita o offset de
    `0..i-1`, reentrega de `i` em diante e aplica a política de erro acima à CAUSA, então só a mensagem `i` vai ao DLT
    (buraco após `max-attempts`, JSON inválido direto) e o transitório (`SQLException`) tenta de novo sem limite, nunca DLT.
    O prefixo precisa estar comitado no banco porque o offset dele avança: o último evento de um stream, perdido ali,
    nunca seria preenchido como "buraco". Nunca escapa exceção crua do lote: uma exceção crua cairia no handler de lote
    genérico, que manda o LOTE INTEIRO ao DLT quando o retry esgota e não chama o `RetryListener` por mensagem (o
    `RetryListener` de lote é um método vazio por padrão). O ack não é dado na falha; mensagens já comitadas e reentregues
    são descartadas pelo checkpoint. Um `eventId` que não bate com o `event_store` não é falha: é descartado como antes.
    **Limite conhecido:** lotes concorrentes em ordens de stream diferentes podem dar deadlock de linha de checkpoint
    (`40P01`, tratado como `SQLException` transitória); em produção há 1 consumer e 1 partição, e na sobreposição de consumers de um
    rebalance o deadlock se recupera pelo retry. Quando o lote falha, o prefixo comitado não aparece no `events.lag` (o log só sai
    com o lote bem-sucedido).
- **`EventReplay`**: `rebuild(projecao, streamType, schema)` cria o schema-sombra (`CREATE TABLE ... (LIKE <schema do serviço>.t
  INCLUDING ALL)`), reaplica todos os eventos do tipo por `global_position` e `divergentTables` compara com a viva
  (`EXCEPT ALL` nos dois sentidos); `drop(schema)` derruba. Roda em **`REPEATABLE READ`** (`SET TRANSACTION` como primeiro
  statement): `global_position` é ordem de alocação e paginar por ela em READ COMMITTED (snapshot novo a cada página) pularia o
  evento que comita no meio; assim todas as páginas leem o mesmo snapshot (a sombra = o log no início da leitura). A sombra copia as tabelas
  vivas do schema do serviço (`LIKE <events.schema>.t`) e não pode ter o nome do schema vivo.
  `divergentTables(projecao, schema)` compara `SELECT *`; `divergentTables(projecao, schema, colunasComparaveis)` (#28)
  recebe um mapa tabela -> colunas e compara só elas (tabela fora do mapa, ou com lista vazia = `SELECT *`), para o que o
  log não determina (carimbo `now()`, `applied_at = clock_timestamp()`, `created_at`/`updated_at`, blob fora do ES);
  `LIKE ... INCLUDING ALL` **não**
  copia FK nem trigger, e coluna `serial` da cópia aponta para a sequence da tabela viva. Sem `TEMP TABLE`; o schema-sombra fica fora do
  `SchemaValidationTest` e do `GlobalDbTruncator` (que só olham `test.db.schemas`, default `public`).
- **`EventSnapshots`**: `due(version)` (a cada `events.snapshot.every`, 100), `save`/`load` (um snapshot por stream, o mais
  novo vence). **Cache descartável**: mudou o formato do estado → apaga `event_snapshot` e reconstrói pelo log.
- **`global_position` não é cursor**: é a ordem de alocação, não a de commit. Ninguém lê o `event_store` "a partir da
  posição X" para acompanhar novidades (o acompanhamento é pelo broker; o replay é completo).
- **Latência/medição (para a #31)**: cada evento custa +1 `INSERT` em `event_store` e +1 em `event_outbox` na transação
  do request (um statement só) e +1 `DELETE` assíncrono no relay; o `INSERT`+`DELETE` contínuo gera tuplas mortas (por
  isso o autovacuum agressivo em `event_outbox`). `occurred_at` (append) → `publishedAt` (relay) → `applied_at`
  (consumer, #29) delimitam o lag. O custo na reserva, desde a #29, está em "Latência (ponto 2 da série)". **Nota para a #31:** o Redpanda sobe com `--mode=dev-container`, que desliga o fsync
  (`--unsafe-bypass-fsync`): a latência do relay medida aqui é **otimista** em relação a um broker com disco durável.
- **Tópicos** nascem na primeira publicação (o modo dev-container do Redpanda liga `auto_create_topics_enabled`), com 1
  partição. O listener de teste do `EventBackboneTest` mostra o padrão do `@KafkaListener` para a #28/#29:
  **`idIsGroup = false`** (por padrão o `id` do listener vira o `group.id` e o `spring.kafka.consumer.group-id` — logo o
  `EVENTS_CONSUMER_GROUP` do `run-tests.sh` — não valeria). Um único `group.id` por ambiente; `auto.offset.reset=earliest`
  fixo (um group novo não pula nada; o checkpoint por stream e a conferência do `eventId` descartam o que já foi aplicado).

## Serviço notification — issue #32 (Fase 7: primeira extração)

O envio de e-mail saiu do monólito e virou o módulo/serviço `notification` (`Backend/notification/`, README próprio): processo,
imagem (`notification/Dockerfile`), container (`gerenciador-notification`) e schema (`notification`) próprios, sem porta HTTP.
O `gateway` e o contrato `/bff/**` não mudaram.

- **Fluxo**: `identity` (monólito) NÃO fala com SMTP. `EmailVerificationService.requestEmailVerification`/`resendVerificationCode`
  e `UserService.requestPasswordResetMfa` gravam o código (`pending_verifications` / `users.password_reset_mfa_code`) e, **na MESMA
  transação JDBC**, appendam um evento em `event_store` + `event_outbox` (`IdentityNotifications`, que usa o `EventStore` da
  `shared`). O relay (já ligado no compose) publica no tópico `identity.notification`; o `notification` consome e envia.
  Cadastro e login **não dependem** do serviço: parado, o evento espera no outbox/tópico e o e-mail sai quando ele volta
  (coberto por `IdentityNotificationEventsTest` e `NotificationConsumerTest`).
- **Contrato** (`shared.events.NotificationEvents`): `streamType` = `identity.notification` (= nome do tópico, 1 partição);
  cada notificação é **um stream novo de uma versão só** (`streamId` = UUID, `version` 1, chave da mensagem = o `streamId`).
  `eventType`: `VerificationCodeRequested` e `PasswordResetMfaRequested`, ambos com payload `email`, `userName`, `code`,
  `expirationMinutes` e `expiresAt` (ISO-8601, quando o código vence), `schemaVersion` 1, no envelope JSON da ADR do backbone. A
  validade vem das constantes que já existem (`verification.code.expiration.minutes` no cadastro; `NotificationEvents.MFA_VALIDADE`
  no MFA, usada também no SQL de `users.password_reset_mfa_expiration`): nada de número duplicado. Tipo novo: constante em
  `NotificationEvents` + `if` no consumer; mudança incompatível de payload incrementa `schemaVersion`.
- **Exceção deliberada à regra "sem dado pessoal no payload" — decisão do usuário (2026-10-21)** (ADR do backbone, seção 3): o
  e-mail só pode ser montado com destinatário e código, então estes eventos levam `email`, `userName` e o código de uso único.
  A senha e o hash NUNCA entram. **Retenção do dado pessoal = validade do código + 30 s** (`NotificationEvents.CARENCIA`), nas
  três cópias: (1) **`event_store`**: `identity/NotificationEventRetentionService` (`@Scheduled` a cada
  `notification.events.retention.scan.ms`, default 30 s, env `NOTIFICATION_EVENTS_RETENTION_SCAN_MS`; `run-tests.sh` estica para
  1 h) apaga, em lotes de 1000, as linhas do stream cujo `payload.expiresAt` venceu há mais de 30 s e que **já saíram do
  `event_outbox`** (cadastro: 5 min 30 s; MFA: 15 min 30 s; evento sem `expiresAt` conta como vencido em `occurred_at`); o
  stream tem 1 versão por stream e nunca passa por replay/projeção, e a "imutabilidade" do `event_store` é convenção (a tabela
  não tem trigger nem REVOKE), então nada quebra; (2) **tópico `identity.notification` e `.DLT`**: `retention.ms` = maior
  validade + 30 s = 15 min 30 s (`NotificationEvents.RETENCAO_TOPICO`, declarado por `NotificationEvents.topic()` /
  `deadLetterTopic()` nos DOIS lados, com `spring.kafka.admin.modify-topic-configs=true` para valer também no tópico que já
  existe) e `segment.ms` = 5 min (o broker só apaga segmento FECHADO; sem isso o `retention.ms` não teria efeito, então o dado
  some em até ~20 min, não em 15 min 30 s exatos). A validade do cadastro tem de ser `<=` a do MFA; (3) **consumer**: descarta, com
  log e sem enviar, evento cujo código já venceu (e-mail com código vencido é inútil). O `.DLT` guarda a mensagem original (e
  headers de exceção que podem trazer o endereço), por isso a mesma retenção curta.
- **Consumer** (`NotificationConsumer`): `@KafkaListener` com `idIsGroup = false`, group próprio `notification`
  (`NOTIFICATION_CONSUMER_GROUP`), ack manual. Por mensagem, numa transação de banco: `INSERT INTO notification.processed_event
  (event_id, ...) ON CONFLICT DO NOTHING` (rowcount 0 = reentrega, descarta) → envia o e-mail → commit → ack. Envio que falha
  desfaz a transação (sem checkpoint) e a mensagem volta. **Não usa o `IdempotentConsumer` da `shared`**: ele confere o
  `event_id` contra `public.event_store` e preenche buraco relendo o log, ou seja, depende de tabelas do monólito; o serviço
  extraído não lê o banco de ninguém. Reusa da `shared` o envelope, o `DatabaseConnection` e a política de erro/DLT
  (`EventsKafkaConfig`, importada por `@Import`).
- **Política de erro**: SMTP fora/banco fora = transitório, retry exponencial sem limite e sem DLT (loga ERROR a partir da 10ª
  tentativa). Payload inválido e **destinatário recusado de vez pelo SMTP** (`SendFailedException` com `invalidAddresses`, ou
  `MailParseException`) = `identity.notification.DLT` direto, sem retry — senão um e-mail digitado errado travaria todos os
  seguintes (tópico de 1 partição). **Exceção:** recusa por culpa do REMETENTE (quota diária do Gmail `550 5.4.5`, limite de taxa:
  o texto casa `NotificationConsumer.CAUSA_DO_REMETENTE`: "sending quota/limit", rate limit, `5.4.5`) também chega em
  `invalidAddresses`, mas passa quando a quota volta, então continua reentregue; já "over quota" (`552 5.2.2`) é a caixa do
  DESTINATÁRIO cheia e continua permanente. Tipo de evento desconhecido: aviso no log e ack, sem enviar. Código vencido: aviso no log e ack, sem enviar.
  Evento sem `expiresAt`/`expirationMinutes` válidos: `.DLT`. **Poll**: `max-poll-records=10` e `ack-mode=manual_immediate`
  (cada e-mail leva 1 a 3 s, até ~15 s com timeout; com os 500 do default um backlog grande estouraria o `max.poll.interval.ms` de
  5 min e giraria em rebalance).
- **Pool Hikari do serviço — a conta**: `maximum-pool-size` **3** / `minimum-idle` 1 (`SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE`
  no compose; o default do `application.properties` do módulo também é 3). Tópico de 1 partição + 1 thread no listener ⇒ no máximo
  **1** transação aberta por vez (ela segura a conexão durante o envio SMTP, timeouts de 5 s); 3 dá folga para reconexão. O
  serviço usa o **mesmo tenant e o mesmo usuário do Supavisor** (`${POSTGRES_USER}.gerenciador-eventos`), então consome **de
  dentro** do pool real de conexões ao Postgres (`POOLER_DEFAULT_POOL_SIZE` = 45 no compose padrão, 245 na configuração de
  carga) que o monólito já usa: o teto **não cresce** (nem consome a folga do `max_connections`, que é para superuser, Supavisor,
  suíte e `psql`). No transaction mode as 3 conexões de cliente só pegam uma conexão real durante a transação (1 em regime, segurada
  durante o SMTP; 3 no pior caso) e a devolvem no commit; ou seja, no máximo 1 dos 245 fica ocupado por ele de cada vez, o que
  tira uma conexão do monólito só enquanto o e-mail sai. O `POOLER_MAX_CLIENT_CONN` (1500) cobre a soma dos Hikari (1213 desde a #36: 1000 do `reservation` + 10 do gateway + 3 + 100 do `catalog` + 100 do `identity`; era 1453 na #35; ver a seção do `reservation`).
  **Não aumente** esse Hikari sem refazer a conta: ele divide o pool com o monólito, que é o que a carga mede.
- **Config do serviço** (todas por env var, mesmos nomes do monólito; valores reais em `Projeto/.env`, nunca imprimir):
  `SPRING_DATASOURCE_URL`/`_USERNAME`/`_PASSWORD`, `SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE`/`_MINIMUM_IDLE`,
  `MAIL_USERNAME`/`MAIL_PASSWORD` (SMTP Gmail, `spring.mail.*` igual ao do monólito antigo), `MAIL_HOST` (default `smtp.gmail.com`),
  `MAIL_PORT` (`587`), `MAIL_SMTP_AUTH` (`true`) e `MAIL_STARTTLS` (`true`; liga `enable` e `required` juntos) — parametrizáveis na #37 só para a
  suíte e2e apontar para um captador de e-mail (`NotificationMailConfigTest`), nada muda sem a variável —, `SPRING_KAFKA_BOOTSTRAP_SERVERS`,
  `NOTIFICATION_CONSUMER_GROUP` (default `notification`), `EVENTS_CONSUMER_RETRY_*`. O compose passa só esses nomes (interpolados do
  `.env`; **sem `env_file`**, para o serviço não receber `JWT_SECRET`/reCAPTCHA). O monólito não lê mais `MAIL_*`.
- **Pendências conhecidas**: (a) `notification.processed_event` cresce sem limpeza (com a retenção de 15 min 30 s do tópico, linhas
  mais velhas que isso nunca mais serão reentregues e poderiam ser apagadas; `processed_event` não tem dado pessoal, só id e tipo);
  (b) o `backend` do compose recebe `MAIL_USERNAME`/`MAIL_PASSWORD` vazios (sobrepostos,
  porque o `env_file` entrega o `.env` inteiro).

## Catalog em CQRS + Event Sourcing — issue #28

**Desde a #35 isto roda no serviço `catalog`** (schema `catalog`, event store/outbox próprios; ver "Serviço catalog"); o texto abaixo
descreve o desenho do agregado, que a extração não mudou.

Agregado `Event`: stream **`catalog.event`**, `streamId` = `partitionKey` = `event_id` (tópico `catalog.event`, relay
ligado no compose desde a #28; o `catalog` não tem projeção assíncrona, o consumer é o da #29 para `reservation.wallet`). `/bff/events/**` não mudou (`HttpContractTest`
sem mudança de expectativa).

- **Eventos** (`schemaVersion` 1; payloads em `catalog/EventPayloads`, com os valores **já calculados**, ex.:
  `buyTimeLimit` defaultado para a data do evento; datas em ISO-8601): `EventCreated` (`eventId`, `creatorId`, `eventName`,
  `isEad`, `address`, `eventDate`, `description`, `capacity`, `buyTimeLimit`, `presenters[]`), `EventUpdated` (só os
  metadados: `eventId`, `creatorId`, `eventName`, `isEad`, `address`, `eventDate`, `description`; **sem** `capacity`/
  `buyTimeLimit`), `PresenterAdded`/`PresenterRemoved` (`eventId`, `presenterName`), `EventCancelled` (`eventId`).
  **Sem PII**: só ids (`creatorId`) e dados do evento; nome de apresentador é dado público do evento, e-mail/telefone/senha
  nunca entram. **Capacidade é estado de `reservation`, não do stream `catalog`**: `eventcap` é o agregado relacional/CAS
  e não é projetado aqui. Só o `EventCreated` leva `capacity`/`buyTimeLimit` (valores iniciais), porque o `eventcap` nasce
  logo depois do commit, por chamada síncrona ao `reservation` (#33), e o `reservation` o reconcilia a partir deste mesmo evento se a
  chamada falhar. Mudanças de capacidade (`updatePolicy`, no reservation ANTES da transação do catalog, com `CHECK` que pode recusá-la) **não** entram no `EventUpdated`: o log imutável e o tópico nunca registram uma capacidade que o
  `eventcap` não aceitou (nem divergem em PUTs concorrentes). O histórico de capacidade, se for preciso, é do módulo `reservation`.
- **`image_data` fica FORA do ES.** É blob (até 5 MB, base64 no JSON inflaria o `event_store` imutável), servido por
  `/bff/events/{id}/image`. Não entra em payload nenhum; a coluna é gravada direto na linha viva (`EventRepository.gravarImagem`:
  na transação do `createEvent`, quando o corpo traz imagem, ou sozinha por `saveImage`), a projeção/replay nunca a tocam, e a
  comparação do replay a ignora. Desde a #35 (fatia 1) a imagem tem métodos próprios (`EventApi.findImage`/`saveImage`): o
  `POST .../image` chama só `saveImage` (um `UPDATE catalog.event SET image_data`, **sem evento no stream**), e o `updateEvent` não
  lê nem grava `image_data` (antes um PUT sem imagem a apagava).
  `created_at`/`updated_at` também ficam fora da comparação: são carimbos do banco (`CURRENT_TIMESTAMP`), não vêm do log.
- **Command side** (`CatalogEventWriter.executar`): uma transação JDBC manual por command, na ordem: (1) trava a linha de
  `event` (`SELECT version ... FOR NO KEY UPDATE`) e lê a `version` = versão do último evento aplicado. Esse lock não
  conflita com o `KEY SHARE` que as FKs de `eventcap`/`walletevent` tomam em `event` (reservas comuns seguem), mas
  operações que sobem a `FOR UPDATE` (renomear `event_name`, que é `UNIQUE`, e o `DELETE`) conflitam com o `KEY SHARE` e
  esperam as reservas em curso, como já era antes da #28; (2) `EventStore.append` na versão + 1;
  (3) aplica a `CatalogEventProjection` na MESMA `Connection` (atualiza `event`/`eventpresenter` e `event.version`); (4) commit.
  `append` vazio = conflito: rollback e o command **repete inteiro** (relê a versão), até 5 tentativas
  (`IllegalStateException`/HTTP 500, nada gravado). Com a linha travada o conflito só acontece se alguém appenda no stream
  por fora da projeção; commands concorrentes no mesmo evento se serializam pelo lock. Escolhido o `SELECT ... FOR NO KEY
  UPDATE` em vez de `UPDATE ... SET version = version + 1 RETURNING` porque a projeção já grava `version` com o valor do
  envelope (a mesma função serve ao replay) e um command pode appendar vários eventos.
  - `createEvent`: o `event_id` sai da sequence da identity (`nextval`) antes do append, vira o `streamId`, e a projeção
    insere a linha com `OVERRIDING SYSTEM VALUE`. Numa transação: `EventCreated` v1 (+ apresentadores no payload) +
    `event`/`eventpresenter` + `image_data` (se vier). **Depois do commit** (#33), `EventService` chama `PUT /internal/eventcaps/{id}` no
    reservation (idempotente por `event_id`; read-your-writes) e relê a capacidade para a resposta. **Sem atomicidade distribuída — janela
    de falha:** se a chamada falhar (reservation fora, rede), o evento JÁ existe sem `eventcap`; a criação NÃO quebra (responde com
    `lot_quantity`/`quantity` da requisição, loga ERROR) e o reservation cria o `eventcap` sozinho pelo `EventCreated` do tópico
    `catalog.event` quando voltar (`CatalogReconciliationConsumer`); reservar nesse intervalo falha com "Capacidade do evento não
    configurada". Um `EventCreated` replicado depois de o evento sumir não ressuscita nada (group com `auto.offset.reset=latest`).
  - `updateEvent` (issue #60: **reservation primeiro, sem saga**): (1) existência e TODAS as validações, antes de qualquer escrita; (2)
    `updatePolicy` (`PATCH /internal/eventcaps/{id}/policy` no reservation, HTTP; sem `eventcap` => 404 e o catalog o cria pelo PUT idempotente
    com os valores novos; **não** gera evento de `catalog`: a capacidade é do `eventcap`); (3) UMA transação do catalog (`EventRepository.update`,
    um command do `CatalogEventWriter`): `EventUpdated` + a diferença de apresentadores (`CatalogEventWriter.trocarApresentadores(tx, ...)`:
    1 `PresenterRemoved`/`PresenterAdded` por diferença, nomes aparados, sem vazios/repetidos; sem diferença não appenda), com versões
    contíguas; falha em qualquer ponto desfaz os dois. Recusa do reservation no passo 2 (400 capacidade abaixo do reservado; 409, que vira
    `EventoEmConflitoException`; serviço fora, 5xx, ou a criação do fallback falhando) interrompe tudo **antes** de gravar no catalog: nem
    `EventUpdated` nem apresentadores. **Janela de falha restante (sem compensação):** o reservation já atualizou e a transação do catalog
    falha (banco fora, conflito de versão esgotado, evento pré-ES): o `eventcap` fica com a capacidade/janela NOVAS e o catalog com
    metadados e apresentadores ANTIGOS; repetir o PUT converge (`updatePolicy` é idempotente), exceto no evento pré-ES (`version = 0`), que antes precisa do backfill da migração `20261022`. Coberto por `EventUpdateAtomicoTest`.
  - `delete`: `EventCancelled` appendado e, **na mesma transação**, a projeção faz o `DELETE` de `event` que sempre existiu
    (`eventpresenter` cai por `CASCADE`). O `eventcap` e o `walletevent` não têm mais FK (outro schema): `EventService.delete` chama
    `DELETE /internal/eventcaps/{id}` **antes** da transação, fora dela (sem segurar conexão nem lock durante a rede), e o serviço recusa com
    **409 se existe reserva do evento em qualquer status** (o antigo `ON DELETE RESTRICT`), com o evento intacto. (Depois do commit não
    preservaria o RESTRICT: o evento já teria sumido.) O stream fica no `event_store` como auditoria. Janela de
    falha: se o reservation apagou a capacidade e a transação do catalog falha em seguida, o evento fica sem `eventcap`. Evento inexistente = no-op
    no `EventService.delete` (sem evento); no `/bff`, desde a #35 (fatia 1), `DELETE /bff/events/{id}` de id inexistente responde **404**
    (era 204): o gateway confere o dono antes (`EventApi.findCreatorId`) e nem chega a chamar o delete. `event_availability`, de um evento apagado, fica órfã e inofensiva (a leitura parte de `eventcap`).
- **Read model** = `event`/`eventpresenter` (+ `event.version`), projeção **inline**: `HttpContractTest` lê o que acabou de
  escrever. A mesma `CatalogEventProjection` roda no command (schema `catalog` desde a #35; `public` antes) e no replay (schema-sombra).
- **Replay**: `EventReplay.rebuild(CatalogEventProjection, "catalog.event", sombra)` +
  `divergentTables(..., colunasComparaveis)` com `event`: `event_id, creator_id, event_name, ead, address, event_date,
  description, version` (e `eventpresenter` inteira). Ver `CatalogEventSourcingTest`.
- **Snapshot não é usado em `catalog`**: nenhum command reconstrói estado lendo o stream (a projeção inline já guarda o
  estado e a versão), então não há load do agregado onde um snapshot ajudaria. `EventSnapshots` continua disponível.
- **Eventos que já existiam** (antes da #28) têm `version = 0` e nenhum stream. A migração
  `20261022-catalog-event-version.sql` faz o backfill: um `EventCreated` v1 (estado atual, sem imagem) + a linha do outbox e
  `version = 1` (só nas linhas cujo `EventCreated` foi de fato inserido), então o replay também os reconstrói. **O command
  RECUSA evento com `version = 0`** (`IllegalStateException` "é pré-ES", em `Tx.bloquear`; HTTP 500 no update/delete):
  appendar aí deixaria um stream órfão começando na v1 sem `EventCreated`. Reaplique a migração depois de carregar o
  `db/seed-data.sql`, que insere em `event` direto (aviso no topo do seed).
- **Limitações conhecidas (para o artigo, sem código):** (a) o replay recria `event` com o `UNIQUE (event_name)` copiado
  (`LIKE ... INCLUDING ALL`); como o replay aplica por `global_position` (ordem de alocação, não de commit), um rename
  concorrente com um create do mesmo nome pode inverter a ordem na sombra e violar o `UNIQUE`, mesmo a viva estando
  consistente. Caso raro, não tratado. (b) Com o relay ligado ele faz ~80 statements/s pelo pooler mesmo com o outbox
  vazio (o tick de 50 ms); é uma variável a acompanhar na #31, não foi medida aqui.
- **Relay**: com `EVENTS_RELAY_ENABLED=true` no compose, o `catalog` publica no tópico `catalog.event` (desde a #35 o relay é o do
  serviço `catalog`, lendo `catalog.event_outbox`). O relay ocupa uma das
  3 threads do scheduler só enquanto houver outbox (o volume do catálogo é baixo); o efeito sobre a medição fica para a #31.

## Padrão dos Services

Cada service expõe, além do CRUD: `canBeCreated(...)` / `getValidationErrors(...)` para o
endpoint `/validate` correspondente (valida sem persistir). Fluxo típico de `create`:
`applyDefaults` → `validateRequired` → `validateRules` → `validateDuplicates*` → `repository.save`.
Erros de validação = `IllegalArgumentException` (vira HTTP 400 no controller).

## Rotas e segurança

- **Superfície HTTP única sob `/bff/**`** (issue #78): `gateway/BffUserController` (users — CRUD,
  login, `/me`, cadastro em duas fases, reset de senha com MFA, reCAPTCHA),
  `gateway/BffEventController` (events — CRUD, validate, search, imagem),
  `gateway/BffEventWalletController` (event-wallets — addLink/confirm/validate/removeLink/
  listByUser), `gateway/BffMyWalletController` (my-wallets — validate/getByUser/ensure),
  `gateway/BffSeedController` (seed, dev). Não existe mais `/api/**` de negócio nem um 2º
  `@SpringBootApplication`; `Main.java` é o único entrypoint e as classes `gateway/*` são
  `@RestController` de nível top-level, descobertas pelo component scan do próprio `Main`.
- **Nginx do frontend faz proxy de `/bff/` → `backend:8081/bff/` sem rewrite/strip**
  (`nginx.conf`): o path chega igual no backend. Em acesso direto ao backend (dev sem
  Nginx), use o mesmo path `/bff/...`.
- `gateway/security/SecurityConfig`: stateless, CSRF off. Desde o PR #79 (issue #78), deny-by-default também
  dentro de `/bff/**` — só a lista abaixo é pública, todo o resto exige
  `Authorization: Bearer <jwt>` (401 fixo via `HttpStatusEntryPoint`, sem token/token
  inválido numa rota protegida).
  - **Público**: `POST /bff/users/login`, `POST /bff/users/request-verification`,
    `POST /bff/users/verify-email`, `POST /bff/users/resend-verification-code`,
    `POST /bff/users/verify-recaptcha`, `GET /bff/events/**` (inclui `/bff/events/search` e
    `/bff/events/{id}/image` — este último servido via `<img>`/`Image.network` no Flutter,
    que nunca manda header customizado), `POST /bff/seed` (ferramenta de dev; desde a #35 só existe com `SEED_ENABLED=true`, senão 404) e
    `GET /actuator/health`.
  - **Autenticado**: todo o resto de `/bff/**` — `/bff/event-wallets/**` e
    `/bff/my-wallets/**` por inteiro, mutações de evento (`POST/PUT/DELETE /bff/events/**`,
    inclusive upload de imagem) e o resto de `/bff/users/**` (`/me`, `GET/PUT /{id}`,
    `/{id}/password`, `/{id}/password-with-mfa`, `/{id}/request-password-reset-mfa`,
    `/{id}/verify-password-reset-mfa`, `GET /email/{email}`, `/validate`,
    `POST /` criação direta).
  - **Preflight CORS**: `OPTIONS /**` é liberado por verbo (`HttpMethod.OPTIONS`, não por
    path) ANTES das regras acima, como defesa em profundidade — o `CorsFilter` que
    `.cors(...)` registra no filter chain já intercepta e responde o preflight antes do
    `AuthorizationFilter`, então na prática o preflight já não caía em `.authenticated()`
    mesmo sem essa regra (verificado empiricamente, ver
    `HttpContractTest#corsPreflight_onProtectedRoute_isNotBlockedByAuth`); a regra explícita
    protege contra reordenar filtros ou remover `.cors(...)` no futuro.
- **Dono do token no path (issue #166, mesma regra e corpo da #57)**: `gateway/AcessoNegado.barrarSeNaoDono` roda ANTES de qualquer chamada ao identity
  e compara o id do path com o dono do token (claim `uid`). Diferente => **403** com o corpo fixo "Acesso negado: o usuário informado não é o usuário
  autenticado" (vale mesmo para id que não existe: a negação não revela se a outra conta existe, então `GET /bff/users/{id}` de um id inexistente deixou de
  dar 404 e dá 403); igual => segue como antes. Cobre `BffMyWalletController` (`GET /{userId}`, `POST /ensure/{userId}`) e, em `BffUserController`, todas as
  rotas com `{id}`: `GET/PUT/DELETE /{id}`, `PUT /{id}/password`, `POST /{id}/request-password-reset-mfa`, `POST /{id}/verify-password-reset-mfa` e
  `PUT /{id}/password-with-mfa`. Fora: `GET /email/{email}` e `POST /` (sem id de dono no path; #181). Token sem `uid` => 401. Sem exceção de
  admin (como na #35). **`PUT /bff/users/{id}`** também recusa com **400** o e-mail que já é de OUTRA conta, sem diferenciar maiúsculas (regra do
  `identity`: `UserService.updateUser` confere `findByEmail` ignorando caixa; o próprio e-mail, inclusive com outra caixa, segue; check-then-update sem índice em `lower(email)`, a corrida fica para a #182). Testes:
  `HttpContractTest#usuarioA_naoLeNemAlteraNadaDoUsuarioB_emUsersEMyWallets` e `#putUsuario_emailDeOutraConta_returns400` (gateway) e
  `UserUpdateEmailDuplicadoTest` (identity, Postgres real).
- **JWT RS256 validado sem estado (issue #36)**: o `identity` assina e o gateway só verifica. `gateway/security/JwtAuthenticationFilter` (filtro
  próprio; **não** usa `oauth2ResourceServer()`, que daria 401 a bearer inválido até em rota pública) decodifica com o `NimbusJwtDecoder` de
  `JwtDecoderConfig` (só RS256; `exp`, `nbf` e `iss` = `gerenciador-identity`) e põe o `sub` (e-mail) como username; authority fixa `USER`. Bearer
  ausente, inválido, vencido, HS256, de outra chave ou sem `uid` numérico => anônimo: **200 em rota pública, 401 (`HttpStatusEntryPoint`) em rota
  protegida**. O `JWKSource` é montado à mão (`JWKSourceBuilder`): `GET {IDENTITY_SERVICE_URL}/.well-known/jwks.json` (connect 2 s / read 3 s),
  cache de **24 h** (`JWT_JWKS_CACHE_TTL_MS`), refetch por `kid` desconhecido com no máximo **1 fetch a cada 30 s**
  (`JWT_JWKS_MIN_REFRESH_INTERVAL_MS`; `kid` aleatório num bearer nunca vira um fetch por requisição) e tolerância a queda de 24 h
  (`JWT_JWKS_OUTAGE_TOLERANCE_MS`): identity fora não derruba quem já tem a chave em cache. Cache frio + identity fora => token não valida (rota
  protegida 401, pública anônima; nunca 500 nem thread presa além de 3 s). Efeito colateral aceito: se a 1ª busca (cache frio) falhar, as rotas
  protegidas dão 401 por até 30 s. Cobertura: `JwtDecoderConfigTest` e os casos de token do `HttpContractTest`.
- **Principal por claim, sem consulta (issue #36)**: `HostAuthorizationApi.currentUserId()` = claim `uid` (some a consulta `LOWER(email)` por reserva
  da #57) e `ensureUserIsHost()` = claim `isHost` (lido do banco **na emissão** do token). Desde o PR #79 (issue #78),
  `gateway/BffEventController.createEvent`/`updateEvent`/`deleteEvent` chamam `ensureUserIsHost()` (IllegalArgumentException → HTTP
  400, padrão do projeto); leitura (get/search/list/validate) e a imagem não ganham esse gate. **Nenhuma rota promove um usuário a host** (de
  propósito — o `identity` não persiste `host` em `POST`/`PUT /internal/users`, só o lê, pra não abrir auto-promoção via `PUT /bff/users/{id}`);
  hoje só existe host via SQL direto/seed manual (`UPDATE identity.users SET host = true`, e o usuário precisa **logar de novo**: a claim vale
  para tokens novos). Promover host por um fluxo de produto (ex.: endpoint de admin) é gap conhecido. **Consequências da validação sem
  estado**: desativar a conta, trocar a senha ou mudar `host` só valem para tokens NOVOS (um token emitido vale até `exp`, `JWT_EXPIRATION_SECONDS`,
  36000 s por padrão); um `uid` que não existe mais não dá 401 em `event-wallets` (o teste da #57 mudou); `/bff/users/me` resolve pelo `uid`
  (`findById`), não pelo e-mail do `sub`.
  `POST /bff/events` grava o usuário do token (o `creator_id` do corpo é ignorado); `PUT` ignora o do corpo e usa o gravado;
  `PUT`, `DELETE` e `POST /{id}/image` exigem o dono (`creator_id` do evento == usuário do token) → **403**; id inexistente → **404**
  (o `DELETE` dava 204). A checagem de dono lê só o criador (`EventApi.findCreatorId`: `SELECT creator_id`, sem blob nem
  hidratação, nem chamada ao reservation). **Sem exceção de admin**: nenhum gate usa `users.admin` (gravável pelo próprio usuário em
  `PUT /bff/users/{id}`). O upload de imagem exige dono, não host. A existência do criador (`UserApi.exists`) é conferida pelo
  gateway (`/validate`, mesma mensagem; `POST /bff/seed`, que aceita o `creator_id` do corpo), não mais pelo `catalog`.
- **Dono da inscrição (issue #57)**: em `/bff/event-wallets/**` (`addLink`, `confirm`, `/validate`, `removeLink`, `listByUser`) o `userId`
  vem do token (`HostAuthorizationApi.currentUserId()`, o mesmo do `BffEventController`), nunca do corpo/query/path. Ele é **opcional**
  nesses três lugares: ausente => vale o do token; igual ao do token => segue; **diferente => 403** (corpo "Acesso negado: ...", antes
  de qualquer outra validação ou chamada ao reservation, e sem revelar se o outro usuário existe). Desde a #36 o `userId` do token é a claim
  `uid` (sem consulta): um `uid` que não existe mais **não dá mais 401** (o 401 de "usuário do token inexistente" era da #57, que consultava o
  banco). A API interna do `reservation` segue recebendo `userId` explícito, agora sempre o do token. A uma rodada de carga anterior à #36 pagava
  `LOWER(email) = LOWER(?)` (seq scan em `users`) por reserva; depois da #36 esse custo some (não comparável com as anteriores). O mesmo IDOR em
  `BffMyWalletController` e em `/bff/users/{id}/**` foi fechado na #166 (ver "Rotas e segurança").
- **Resposta de `Event` (issue #35)**: ganha `creator_name` (somente-leitura no DTO; composto no gateway por `gateway/CreatorNames`:
  `UserApi.findNames(ids)` em lote, só `isactive = true` → conta desativada = `creator_name` nulo; Caffeine com TTL 45 s ±20% por
  entrada, ~10k entradas, sem cache negativo; **falha do `findNames` não falha a resposta**: o nome sai nulo, sem cache, e a próxima
  resposta tenta de novo — senão o GET viraria 404 e o POST/PUT já comitado viraria 500). As listas (`/search`, `?creator_id=`) **não trazem `image_data`** (o SQL nem lê a
  coluna); ela continua no `GET /{id}` e em `/{id}/image`. A imagem tem métodos próprios (`EventApi.findImage`/`saveImage`): o
  `updateEvent` não toca mais nela (antes um `PUT` sem `image_data` apagava a imagem). `exists(eventId)` é `SELECT 1` e o
  `EventWalletGateway` guarda o positivo por 30 s (Caffeine; negativo e falha nunca entram no cache).
- Senhas: `BCryptPasswordEncoder` (bean em `identity/PasswordEncoderConfig`, no serviço identity; o gateway não toca em senha). Nunca gravar senha em claro
  (o seed SQL grava em claro só para dados de teste — não replicar em código de produção).
- CORS tem **um único ponto de configuração** (#133): o bean `CorsConfigurationSource` de
  `shared.CorsConfig`, que o `SecurityConfig` injeta em `.cors(...)` (o filtro do Spring Security responde
  o preflight antes dos controllers; não há `WebMvcConfigurer` nem outro bean). Origens EXATAS de
  `CORS_ALLOWED_ORIGINS` (default `http://localhost:8088,http://localhost:3000`; `*` é recusado na subida, pois
  as credenciais ficam habilitadas — origem fora da lista não recebe `Access-Control-Allow-Origin`).
  `exposedHeaders`: `Authorization`, `Content-Type`, `Idempotency-Key` (#24). Outra origem = linha
  `CORS_ALLOWED_ORIGINS=...` (lista completa) no `Projeto/.env`, que o `backend` herda por `env_file`.
  Testes: `HttpContractTest#corsPreflight_*`/`cors_respostaReal_*` e `shared/CorsConfigTest`. Veja `CORS_CONFIG.md`.

## Inscrição em evento — reserva em duas fases (CAS)

> **Desde a #47** o `addLink` é uma **saga** de duas transações curtas no `reservation` com um `POST /internal/holds` no `stock` entre elas (sem conexão aberta durante a chamada);
> o CAS vive no `stock` e `removeLink`/expiração só appendam o evento (a vaga volta pelo consumer do `stock`). A lista abaixo é a da #24/#29 (uma transação só); a atual está em
> "Serviço stock e saga stock + wallet".

**Desde a #33 isto roda no serviço `reservation`** (ver "Serviço reservation"): o `gateway` (`EventWalletGateway`) confere a carteira no
monólito e o evento no serviço `catalog` (desde a #35, por HTTP, com cache positivo de 30 s) e chama a API interna dele por HTTP; o CAS, a guarda e o append continuam exatamente como abaixo, só que dentro do outro processo
e do schema `reservation`. `EventWalletService` (módulo `reservation`):

1. `addLink` (`POST .../event-wallets`): valida, checa janela de compra (`eventcap.buy_time_limit`)
   e duplicidade (`existsActive` = pending/confirmed), então numa **transação** (uma `Connection`,
   `setAutoCommit(false)` manual, não `@Transactional`): (a) reivindica a `Idempotency-Key`
   (`IdempotencyKeyRepository.claim`); (b) `CapacityReserver.tryReserve(conn, eventId)` (UPDATE
   condicional) → se `false`, rollback + `IllegalArgumentException("Evento lotado")`; (c)
   `ReservationWriter.reservePending(conn, ...)` grava `walletevent` como `pending` com
   `expires_at = now + eventcap.max_time_in_line` (UPSERT, revive linhas `expired`/`cancelled`; devolve a `version`);
   (d) appenda `SlotReserved` (#29); (e) commit.
2. `confirm` (`POST .../event-wallets/confirm`): numa transação, `pending → confirmed` (`expires_at` = NULL) e append de
   `ReservationConfirmed`.
3. `removeLink` (`DELETE .../event-wallets`): numa transação, um `UPDATE` condicional único
   (`cancelIfActive`: `pending`/`confirmed` → `cancelled`) e `release` + append de `ReservationCancelled` **só se** esse
   UPDATE afetou 1 linha — evita devolução dupla de vaga em cancelamento concorrente / corrida com o
   job. Reserva já `cancelled`/`expired`/inexistente ⇒ no-op silencioso (idempotente, sem evento).
4. `reservation/ReservationExpiryService` — `@Scheduled` (a cada `reservation.expiry.scan.ms`,
   default 30s; `@EnableScheduling` em `ReservationApplication`, desde a #33): varre `pending` vencidas **em lotes** (#61;
   `reservation.expiry.batch-size`, env `RESERVATION_EXPIRY_BATCH_SIZE`, default 100): cada lote é UMA transação que seleciona com
   `ORDER BY expires_at LIMIT n FOR UPDATE SKIP LOCKED` (duas execuções concorrentes não pegam a mesma linha; o lock só vale dentro da
   transação) e, por linha e num savepoint, `expireIfStale` (condicional, não pisa em confirmação concorrente) + `release` + append de
   `ReservationExpired` (um por linha expirada; erro numa linha desfaz só ela, as outras seguem). Repete lotes até um voltar incompleto ou
   sem nenhuma expirada (linha que falha sempre não prende o job). Testes: `ReservationExpiryBatchTest`.
   O lote segura o lock das linhas de `eventcap` (a linha quente do CAS) que o `release` toca até o commit — por isso ele é limitado e
   configurável (o compose repassa `RESERVATION_EXPIRY_BATCH_SIZE`, default 100). A ordem de lock é inversa à da reserva (reserva:
   `eventcap` → `walletevent`; job: `walletevent` → `eventcap`), o que alarga a janela de deadlock: o Postgres aborta um dos dois, o
   savepoint da linha desfaz só ela e o job segue (a reserva abortada devolve erro ao cliente).

### Reservation em event sourcing (híbrido) — issue #29 (ADR "Event-Backbone-Event-Store")

`eventcap` + CAS ficam **relacionais e síncronos**, sem mudança. O lado wallet/order passa a ser event-sourced: o
stream `reservation.wallet` (`streamId = "userId:eventId"`, **chave de partição = `event_id`**, tópico = `streamType`)
tem os eventos `SlotReserved` (`{userId, eventId, expiresAt}`, metadata `{idempotencyKey}`), `ReservationConfirmed`,
`ReservationExpired` e `ReservationCancelled` (`{userId, eventId}`): ids e valores já calculados, **nunca dado pessoal**
(o replay não chama `now()`). Código: `reservation/ReservationEvents`.

- **A versão sai da própria guarda.** `reservePending`, `confirm`, `cancelIfActive` e `expireIfStale` fazem
  `UPDATE/UPSERT walletevent ... SET version = version + 1 ... RETURNING version` (coluna `walletevent.version`, 0 =
  linha anterior ao ES; a 1ª reserva do par é a v1). Sem `SELECT` separado: uma reserva concorrente com a expiração do
  mesmo par não lê versão velha (a linha fica travada até o commit, e o `UPDATE` reavalia a guarda depois do lock).
  Reservar de novo uma cancelada/expirada **continua o mesmo stream** (`version` segue).
- **Append só com rowcount 1, na mesma transação.** Sem linha afetada (`RETURNING` vazio) não há evento. O append é o
  último comando antes do commit (`EventStore.append`, 1 statement com o `INSERT` do outbox). Conflito de versão no append
  (não deveria acontecer: a versão vem da guarda) = rollback: na reserva a resposta é "Vínculo já existente", como na
  corrida atual; em confirm/cancelamento/expiração é `IllegalStateException` (a guarda, a vaga e o evento voltam juntos).
  Os `catch` dessas transações pegam `SQLException | RuntimeException` (senão o `finally setAutoCommit(true)` comitaria a
  guarda sem o evento).
- **O braço `naive` também appenda `SlotReserved`** (só não toca em `eventcap`): a projeção vê as reservas dos dois braços.
- **`walletevent` = projeção inline** ("minhas reservas"): continua sendo gravado pelas guardas, na transação; o
  read-your-writes do `HttpContractTest` não mudou (a `version` não aparece no JSON de `EventWallet`).
- **Projeção assíncrona de disponibilidade** (`event_availability`, lida só pelo braço `naive`): o
  `EventAvailabilityConsumer` (`@KafkaListener(id = "reservation-availability", idIsGroup = false, topics =
  "reservation.wallet", batch = "true", properties = "max.poll.records=${events.consumer.batch-size:500}")`,
  `events.consumer.enabled`) usa o `IdempotentConsumer` da #27 e a `EventAvailabilityProjection`.
  **Em lote desde a #146:** recebe `List<ConsumerRecord>` (até `events.consumer.batch-size`, env `EVENTS_CONSUMER_BATCH_SIZE`,
  default **500**; vira o `max.poll.records` só deste listener) e chama `onBatch`: uma transação e um ack por lote, em vez de uma
  transação curta por mensagem. Só este listener é em lote (`spring.kafka.listener.type` continua `single`; o `onMessage` fica
  para os testes da #27). **Efeito esperado (a medir na Rodada 2, #31):** o achado da #31 foi X ≈ 56k RPM com o consumer ligado
  contra 60k estável com ele desligado, e backlog de ~793 mil mensagens; o lote troca N transações/commits/acks por 1, então
  o custo por mensagem cai (menos transações curtas disputando o mesmo Postgres e o mesmo pooler do caminho quente), o consumer
  passa a acompanhar o append (o lag deve cair e o backlog não crescer) e o X deve voltar para perto dos 60k. Com o consumer em dia o lote
  tem poucos registros e o comportamento é o de antes. Continuam 1 partição e 1 consumer (mais partições/consumers e mudar
  o relay estão fora do escopo da #146). O que não muda: o lag por evento (`events.lag`) é medido depois do commit do lote.
  A tabela guarda **só `ativos`** por evento (`SlotReserved` +1; `ReservationExpired`/`ReservationCancelled` −1;
  `ReservationConfirmed` 0) + `applied_at` (`clock_timestamp()` do statement; com o lote da #146 é a hora dentro de uma transação de até N mensagens, não exatamente
  a do commit, então `applied_at − last_occurred_at` pode subestimar o lag visível em até a duração do lote; o `events.lag` é medido depois do commit) + `last_occurred_at` (maior
  `occurredAt` visto, igual ao `occurred_at` do `event_store`). **Sem FK e sem CHECK** em `ativos`: toda violação no consumer
  é `SQLException`, retentada sem limite, e travaria a partição; um `Cancelled` sem `SlotReserved` (linha anterior ao ES)
  deixa o saldo negativo, e a leitura trata `ativos` negativo como 0 (senão a disponibilidade passaria da capacidade). A **disponibilidade é calculada na leitura**
  (`EventAvailabilityRepository.findAvailable`: `eventcap LEFT JOIN event_availability`, `CASE WHEN capacity = -1 THEN -1
  ELSE GREATEST(capacity - GREATEST(COALESCE(ativos, 0), 0), 0) END`; **nunca** lê `eventcap.quant`). Um evento sem nenhuma reserva já
  tem disponibilidade (= capacity) e a mudança de capacidade por `updatePolicy` vale na hora: só `ativos` é defasado.
  `null` só significa "sem `eventcap`" (já barrado antes por `validarPreRequisitos`); o antigo erro "disponibilidade ainda
  não calculada" não existe mais.
- **Lag observável (ADR, seção 4).** Na linha da projeção: `applied_at − last_occurred_at` (idade do último evento
  aplicado; o `Get-AmostraLag` do harness de carga mede isso). Por evento, o consumer loga no logger `events.lag`:
  `relay_ms` (`publishedAt − occurredAt`), `consumer_ms` (aplicação − `publishedAt`) e `total_ms`
  (**DEBUG, desligado por padrão**: um log por evento no thread do único consumer infla o `consumer_ms` medido; ligue com `LOGGING_LEVEL_EVENTS_LAG=DEBUG` só na rodada que mede o lag, e veja o offset lag). Complemento: offset lag
  do group (`docker exec gerenciador-redpanda rpk group describe reservation`). A amostra de `applied_at` só anda
  quando o consumer aplica evento: consumer parado não a atualiza, olhe também o offset lag. Falha transitória do consumer:
  retry sem limite, e a partir da 10ª tentativa (`events.consumer.retry.error-after-attempts`) cada tentativa loga em
  ERROR (`RetryListener` em `EventsKafkaConfig`).
- **`ReadModelRefreshService` e `READMODEL_AVAILABILITY_REFRESH_MS` saíram.** O **lag do braço naive deixou de ser
  variável controlada** (`lag_ms` da matriz): é o lag real do relay + consumer, medido sob a carga (variável independente =
  a carga: N concorrentes / RPM). Ver `Projeto/carga/README.md`.
- **Overselling (#9).** Os testes concorrentes do CAS seguem verdes (`eventcap` nunca negativo, reservas ≤ capacidade). O
  braço naive com o consumer atrasado continua oversellando (é o braço de controle):
  `EventWalletNaivePathTest.doisAddLinkNaMesmaJanelaOversellamSemTocarOCas` prova, de forma determinística, com o consumer
  desligado.
- **Replay** (`ReservationReplayTest`): reconstrói na sombra o `walletevent` (colunas `user_id, event_id, status,
  expires_at, version`) e a projeção (`event_id, ativos, last_occurred_at`; `applied_at` fica de fora) só do `event_store`.
  Só vale para streams nascidos depois da migração `20261023` (linhas anteriores têm `version = 0` e nenhum evento; o
  baseline de `ativos` vem das reservas ativas que já existiam).

O `gateway/BffSeedController` (`POST /bff/seed`) cria inscrições já confirmadas (`addLink`
seguido de `confirm`).

### Idempotency-Key, invariante e compensação — issue #24

- **Invariante**: (1) reservas ativas (`pending`/`confirmed`) ≤ capacidade — **só no braço `cas`** (o CAS em
  `eventcap` e o `CHECK eventcap_quant_bounds` garantem; o `naive` oversella de propósito); (2) **uma `Idempotency-Key`, por usuário, produz no máximo uma reserva**
  (PK `(user_id, idempotency_key)`). Nenhuma outra requisição observa um estado em que a vaga foi debitada
  sem a reserva gravada (ou o contrário): tudo é uma transação.
- **Header** `Idempotency-Key` em `POST /bff/event-wallets`, **opcional e aditivo**: sem ele, o servidor
  gera um UUID; a chave usada (gerada ou recebida) volta no header `Idempotency-Key` da resposta 201
  (exposto no CORS). O corpo JSON e o contrato do Flutter não mudam (`EventWallet.idempotencyKey` é
  `@JsonIgnore`, só em memória). Máx. 255 caracteres (senão 400). **A chave tem escopo por usuário**
  (issue #129): a PK é `(user_id, idempotency_key)`, então dois usuários podem usar a mesma chave sem
  colidir — cada um tem a própria reserva (claim e lookup usam o par).
- **Repetição** (mesma chave, mesmo usuário e evento) devolve **201 com o resultado da primeira**
  (`status = pending`, `expiresAt` salvo — mesmo depois de confirmar/cancelar a reserva) e **não** toca
  `eventcap`. **Mesma chave, mesmo usuário e outro evento ⇒ 422** (`IdempotencyConflictException`; segue o
  rascunho IETF do header, que reserva 422 a "mesma chave, payload diferente"). Como o `INSERT` da chave
  *bloqueia* até a transação concorrente terminar, não há estado "em andamento" visível e portanto
  nenhum 409. Para reservar de novo o mesmo par depois de cancelar, use outra chave.
- **Só reserva bem-sucedida grava a chave**: lotado / vínculo já existente fazem rollback e a mesma
  chave pode ser repetida depois.
- **Concorrência**: duas requisições com a mesma chave serializam no `INSERT ... ON CONFLICT DO NOTHING`
  (a PK segura a 2ª até a 1ª dar commit/rollback). 1ª commita → a 2ª lê a linha salva e devolve o
  resultado (sem CAS). 1ª faz rollback → a 2ª segue como primeira. Antes da transação, se uma checagem
  falha (ex.: "Vínculo já existente" numa repetição sequencial), `addLink` consulta a chave e devolve o
  resultado salvo — a consulta extra só roda no caminho de erro.
- **Fronteira interna**: `CapacityReserver` ("decrementar capacidade", `EventCapRepository`) e
  `ReservationWriter` ("gravar reserva", `EventWalletRepository`) são interfaces de `reservation` (não
  `api`); `EventWalletService.addLink` orquestra as duas na **mesma `Connection`**. É a costura do split
  futuro `stock` + `wallet` (#47).
- **Ponto de compensação**: se a gravação da reserva (ou qualquer passo) falha **depois** do CAS, faz-se
  `rollback` da `Connection` — a vaga e a chave voltam juntas. No split futuro `stock` + `wallet`, o
  `rollback` deixa de cobrir os dois lados e a compensação vira um `release` (hoje
  `EventCapRepository.release`, o que `removeLink`/expiração usam, ainda fora da interface
  `CapacityReserver`) que **terá de ser idempotente por chave no split**.
- **Braço `naive`**: a idempotência vale nos dois caminhos (a reivindicação da chave está na mesma
  transação curta; só o `tryReserve` é pulado). Na repetição sequencial a checagem do read model
  ("Evento lotado") falha como o "Vínculo já existente" e cai no mesmo desvio para o resultado salvo.
- **Retenção** (issue #130): `reservation/IdempotencyKeyRetentionService` — `@Scheduled` (a cada
  `idempotency.retention.scan.ms`, default 10 min, env `IDEMPOTENCY_RETENTION_SCAN_MS`) apaga as linhas de
  `idempotency_key` com `created_at` mais antigo que `idempotency.retention.hours` (default **24h**, a janela
  em que um retry do cliente faz sentido; env `IDEMPOTENCY_RETENTION_HOURS`). Passado o prazo, repetir a
  mesma chave deixa de ser reconhecida: vira reserva nova (ou "Vínculo já existente" se a anterior ainda
  estiver ativa). O `DELETE` roda em **lotes de 1000** (CTE com `LIMIT ... FOR UPDATE` + junção por `ctid`),
  um por instrução em autocommit, repetidos até um lote voltar incompleto — não varre nem trava a tabela de
  uma vez. Filtra por `created_at` com o índice `idx_idempotency_key_created_at`. `purgeExpired()` é `public`
  e chamável direto (os testes o invocam; `run-tests.sh` estica o timer para 1h via env). A tabela não tem FK, então nada mais a apaga (não some com o evento).
- **Latência (ponto 2 da série, não medido)**: sob carga a rejeição ("Evento lotado") é o caminho quente,
  não só o sucesso. **Custo novo por reserva bem-sucedida desde a #29, nos DOIS braços:** +1 `INSERT` em `event_store`
  e +1 `INSERT` em `event_outbox` (num único statement, o último antes do commit, +1 ida ao banco) na transação do request,
  mais a escrita da linha e dos índices do `event_store` (PK + `UNIQUE (stream_type, stream_id, version)`) e do outbox, e +1
  `DELETE` assíncrono do outbox no relay (tuplas mortas, autovacuum agressivo). Além disso, o `confirm` deixou de ser 1
  `UPDATE` em autocommit e virou `UPDATE ... RETURNING` + append + `COMMIT` (a mesma ida de rede a mais por transição:
  cancelamento e expiração também appendam); a pré-checagem do naive virou `eventcap LEFT JOIN event_availability` (join por
  PK) no lugar da leitura de uma tabela. A rejeição ("lotado") **não** paga o append (rollback antes dele no `cas`; pré-checagem
  no `naive`). Custo por braço: no **sucesso**, `cas` e `naive` pagam 1 `INSERT` de chave (+1 ida ao banco, mais
  a escrita da linha e dos 2 índices: PK + `created_at`, #130). Na **rejeição**, o `cas` paga `INSERT` + rollback (tupla morta na
  `idempotency_key` **e entrada morta nos dois índices**, vacuum), pois o `tryReserve` roda depois do `claim`; o `naive` rejeita nas
  pré-checagens, antes da transação, e **não paga nada** (a consulta prévia da chave só roda com chave do
  cliente, nunca com a gerada). O ponto 2 da série compara os braços medidos **com este código**, não com
  as rodadas antigas.

### Feature flag `reservation.readpath` — caminho CAS (default) vs. ingênuo (experimento)

`addLink` tem dois caminhos de checagem de capacidade, escolhidos **no gateway** (o monólito) por
`reservation.readpath` (`@Value` em `EventWalletGateway`, env `RESERVATION_READPATH`, lida na subida; o `reservation` não tem a flag, recebe
o modo no pedido: `POST /internal/reservations?path=cas|naive`):

- **`cas`** (default) — **UMA chamada HTTP** `gateway → reservation`; lá dentro o que está descrito acima: `EventCapRepository.tryReserve`
  (UPDATE condicional atômico). Nunca oversella.
- **`naive`** — **DUAS chamadas HTTP**, uma depois da outra (`ReservationClient.addLink(..., naive = true)`): (1) `GET
  /internal/events/{id}/availability` lê a disponibilidade **defasada** via `EventAvailabilityRepository.findAvailable`
  (`eventcap.capacity` menos `ativos` da projeção assíncrona `event_availability`, ver "Reservation em event sourcing"); `== 0` ⇒ "Evento
  lotado" **sem a 2ª chamada**; (2) `POST /internal/reservations?path=naive` insere em `walletevent` **sem CAS** (só `reservePending`, **nunca**
  toca `eventcap`, mas appenda `SlotReserved`) e **não relê** a disponibilidade. A janela check-then-act inclui uma ida e volta de rede inteira:
  é o que o braço de controle do experimento (ponto 3, Rodada 3) precisa mostrar. Oversella proporcional ao lag do consumer — é o **braço de
  controle** do experimento de concorrência (issues #12/#13), não um bug. Diferença de ordem de erros vs. antes da #33: a disponibilidade é lida
  ANTES do "Vínculo já existente", então quem já tem a vaga num evento esgotado vê "Evento lotado". Repetição com `Idempotency-Key` **do cliente**
  e disponibilidade 0 consulta `GET /internal/reservations/replay` e devolve o resultado salvo (com chave gerada pelo servidor não consulta nada).

O refresh por timer da Fase 2 (`ReadModelRefreshService`, `READMODEL_AVAILABILITY_REFRESH_MS`) **saiu** na #29: o lag deixou
de ser variável controlada e passou a ser o lag real do consumer, medido (ver "Reservation em event sourcing"). Os dados da
Rodada 1 (`docs/carga/resultados-*`) foram medidos com o refresh e ficam como histórico.

## Serviço reservation — issue #33 (Fase 7: segunda extração)

> **Desde a #47** o `eventcap`, o CAS, a API `/internal/eventcaps/**` e a reconciliação pelo `EventCreated` (group `stock-catalog`) moraram no serviço **`stock`**
> (schema `stock`); o `reservation` é o lado `wallet` e **orquestra a saga** (`POST /internal/holds` no `stock`, ver "Serviço stock e saga stock + wallet"). O texto abaixo
> descreve a #33; onde fala de `eventcap`/CAS "dentro do serviço", leia "no `stock`"; o `CapacityReserver` virou o `StockClient` e a Hikari soma 1463 com o `stock` (250).

`eventcap` (CAS), `walletevent` (event sourcing, stream `reservation.wallet`), `idempotency_key` e a projeção `event_availability` saíram do
monólito e viraram o módulo/serviço `reservation` (`Backend/reservation/`, README próprio): processo, imagem (`reservation/Dockerfile`), container
(`gerenciador-reservation`, API interna na `:8082` **sem porta no host**) e schema (`reservation`) próprios. O contrato `/bff/**` não mudou
(`HttpContractTest` sem mudança de expectativa). Diagrama do salto: [`docs/arquitetura/fase7-servicos.md`](/gerenciador-eventos/docs/arquitetura/fase7-servicos).

- **Fronteira física.** `reservation` NÃO depende de `monolito` (só de `shared` e da lib de contrato `reservation-client`) e não lê tabela
  de ninguém; o monólito não tem o código dele no classpath. **Schema `reservation`**: `eventcap`, `walletevent`, `event_availability`,
  `idempotency_key` **sem nenhuma FK** (nem para `users`/`event`) e o **event store do serviço** (`event_store`, `event_outbox`,
  `event_snapshot`, `projection_checkpoint`; `events.schema=reservation`, ver "Event store e backbone"). `mywallet` NÃO veio: é extensão 1:1
  de `users` (criada por trigger) e continua em `public`, no `identity` (`MyWalletService`/`MyWalletApi`). O que as FKs garantiam virou
  responsabilidade de quem chama: o **gateway** confere a carteira (`MyWalletApi.exists`) e o evento (`EventApi.exists`) antes de reservar,
  e dentro do serviço a existência do `eventcap` é o "evento existe" ("Capacidade do evento não configurada" quando falta); "minhas reservas"
  (`GET /internal/reservations/user/{id}`) devolve só `walletevent` (não há join: nunca houve). Migração a quente:
  `db/migrations/20261025-reservation-schema.sql` (idempotente; `ALTER TABLE ... SET SCHEMA`, derruba as FKs, **move os streams `reservation.wallet`
  do `public.event_store`/outbox/checkpoint/snapshot** — sem isso o consumer acharia buraco em todo stream antigo —, `lock_timeout` 5 s; pare o
  backend e o reservation antes).
- **API interna** (HTTP, `/internal/**`, só alcançável na rede `gerenciador-net`; o `userId` vai como **parâmetro
  explícito** no corpo/query; desde a #57 o gateway passa o `userId` do TOKEN, nunca o que o cliente mandou). **Autenticada por token de serviço compartilhado (volta 3 da #33):**
  header `X-Internal-Token` com o valor de `INTERNAL_API_TOKEN`, enviado pelo `ReservationClient` em TODA chamada e exigido pelo
  `InternalTokenFilter` do reservation em TODA requisição do serviço (sem filtro por caminho: o serviço não tem rota pública, o healthcheck é TCP, e
  um teste do URI cru deixaria passar `/internal;x=1/...` e `/%69nternal/...`, que o Spring MVC normaliza) (comparação em tempo constante, `MessageDigest.isEqual`; **401** sem o header ou
  com valor errado, sem chegar ao controller; o healthcheck é TCP e não passa por aí). **Sem valor default** (nem no código, nem no compose): o
  reservation e o monólito **falham no boot** com mensagem clara se `INTERNAL_API_TOKEN` faltar. **Você precisa acrescentar ao `Projeto/.env`**
  `INTERNAL_API_TOKEN=<valor aleatório>` (gerar: `openssl rand -hex 32`); o compose passa o mesmo valor aos dois containers
  (`INTERNAL_API_TOKEN: ${INTERNAL_API_TOKEN:?...}`: o compose recusa subir sem a variável); o `run-tests.sh` usa o valor de teste `token-de-teste-nao-e-segredo`. Custo no caminho
  quente (comparabilidade com o ponto 2): a leitura de um header e uma comparação de bytes. Testes: `ReservationApiE2ETest` (sem token,
  token errado ou vazio -> 401 em toda rota e o PUT sem token não grava; token certo -> fluxo normal; sem a variável o filtro e o cliente
  não sobem) e o `FakeReservationServer`, que responde 401 sem o header (prova que o cliente o envia). Erros: corpo = mensagem em texto puro; **400** regra de negócio
  (`IllegalArgumentException`: "Evento lotado", "Vínculo já existente"...), **422** `Idempotency-Key` reusada com outro evento
  (`IdempotencyConflictException`), **409** apagar capacidade de evento com reserva (`IllegalStateException` no cliente), **404** sem
  `eventcap`/sem chave (o cliente devolve `null`), 500 o resto.
  `POST /internal/reservations?path=cas|naive` (header `Idempotency-Key` opcional; 201 + header com a chave usada) ·
  `GET /internal/reservations/replay?userId&eventId&idempotencyKey` · `POST /internal/reservations/confirm` ·
  `DELETE /internal/reservations?userId&eventId` · `GET /internal/reservations/user/{userId}` ·
  `GET /internal/reservations/active?userId&eventId` · `GET /internal/events/{eventId}/availability` (`{"available": n}`, defasada) ·
  `PUT /internal/eventcaps/{id}` (idempotente por `event_id`: 201 criou / 200 já existia) · `GET /internal/eventcaps/{id}` ·
  `POST /internal/eventcaps/batch` (ids no **corpo**: a busca de eventos hidrata a lista inteira, milhares de ids, e na query string
  estouraria o limite de header de 8 KB do Tomcat) · `PATCH /internal/eventcaps/{id}/policy` (**404** se o evento não tem `eventcap`: o catalog
  então o cria com os valores novos pelo PUT idempotente, em vez de a edição se perder para a reconciliação) · `DELETE /internal/eventcaps/{id}`.
  Pedido malformado (JSON ilegível, parâmetro ausente/de tipo errado) responde **400**, não 500. Os DTOs são os da lib
  `reservation-client` (`EventWallet`, `EventCap`), os mesmos dos dois lados.
- **`eventcap` nasce por chamada síncrona do catalog** (decisão do usuário): depois do commit do evento, `PUT /internal/eventcaps/{id}`
  (read-your-writes: reservar logo depois funciona). **Sem atomicidade distribuída** (janelas de falha em "Catalog em CQRS + Event Sourcing"): se a
  chamada falha, o `CatalogReconciliationConsumer` cria o `eventcap` pelo `EventCreated` do tópico `catalog.event` (group `reservation-catalog`,
  `auto.offset.reset=latest` — um group novo não relê o histórico, porque ids de evento se repetem depois de `TRUNCATE ... RESTART IDENTITY` —,
  criação idempotente por `event_id` sem checkpoint, só liga com `RESERVATION_CATALOG_RECONCILIATION_ENABLED`).
  Cancelar o evento chama `DELETE /internal/eventcaps/{id}` ANTES da transação do catalog, fora dela (409 se há reserva, o antigo
  `RESTRICT`, antes de qualquer escrita; a chamada de rede não segura conexão nem o lock da linha `event`).
- **`updatePolicy` (`PATCH /internal/eventcaps/{id}/policy`) e a conversão ilimitado -> limitado (#56):** `quant = novaCapacidade - ativas`,
  com `ativas` = reservas `pending` + `confirmed` do evento (`reservation.walletevent`) contadas num subselect do MESMO `UPDATE` (um statement,
  atômico com a escrita); capacidade menor que as ativas viola `eventcap_quant_bounds` (23514) => `IllegalArgumentException` => **400** e nada muda.
  Limitado -> limitado acompanha a variação (`quant += nova - atual`) e limitado -> ilimitado vira `-1`. **Janela de corrida conhecida, não
  tratada:** a reserva de evento ilimitado roda sem CAS e não trava a linha de `eventcap`. A janela vai da leitura da política (fora da transação
  da reserva) até o commit da reserva: uma reserva em voo que comite DEPOIS do `count` do `UPDATE` não é contada e `quant` fica acima do real
  (overselling de no máximo as reservas em voo na conversão). Caso inverso, lado seguro: cancelamento/expiração em voo durante a conversão
  (contados como ativos) pode deixar `quant` 1 abaixo do real (uma vaga a menos, nunca a mais). Fechá-la exigiria travar `eventcap` no caminho
  quente da reserva ilimitada, o que ficou fora da #56.
- **Jobs dentro do serviço**: `ReservationExpiryService` (`reservation.expiry.scan.ms`), `IdempotencyKeyRetentionService` (#130) e o relay do
  outbox do serviço; `@EnableScheduling` em `ReservationApplication`. Projeção `event_availability` + `EventAvailabilityConsumer` (lote da
  #146) no serviço, group `reservation` (antes `gerenciador-eventos`; `EVENTS_CONSUMER_GROUP`).
- **Costura `stock` + `wallet` (#47)** preservada: `CapacityReserver` (decrementar capacidade) e `ReservationWriter` (gravar reserva) seguem
  como interfaces separadas dentro do serviço, orquestradas na mesma `Connection` pelo `EventWalletService`.
- **Cliente `gateway → reservation`** (`ReservationClient`, lib `reservation-client`): Apache HttpClient 5 com **pool dimensionado para a
  carga** (default do cliente é 5/20 e serializaria a medição): `reservation.client.max-connections` = **400** no total e por rota (>= as 300
  threads do Tomcat do gateway; senão a fila se formaria no gateway), keep-alive, timeouts explícitos (conectar 2 s, esperar conexão livre do pool
  5 s, resposta/leitura 10 s), `evict-idle` **20 s** (o evictor varre a cada 20 s e fecha o ocioso há mais que isso: uma conexão fica ociosa no máximo ~40 s) **menor** que o
  `server.tomcat.keep-alive-timeout` do reservation (60 s), para um socket já fechado pelo servidor nunca virar 5xx (sem retry automático) e
  `server.tomcat.max-keep-alive-requests=-1` (o default de 100 reconectaria sem parar), sem retry automático. Envs: `RESERVATION_SERVICE_URL`
  (`http://reservation:8082` no compose), `RESERVATION_CLIENT_MAX_CONNECTIONS`, `RESERVATION_CLIENT_{CONNECT,CONNECTION_REQUEST,RESPONSE}_TIMEOUT_MS`,
  `RESERVATION_CLIENT_EVICT_IDLE_MS`. **Efeito do timeout de resposta de 10 s sob sobrecarga (para a Rodada 3 vs. o ponto 2, que não tinha
  timeout):** acima do limiar X uma reserva lenta vira **5xx no gateway** (`ResourceAccessException`) mas pode comitar no `reservation`; não afeta
  o overselling (a verdade é lida do banco) nem o critério de X (p95 > 1 s dispara muito antes), mas quem compara taxa de erro entre os pontos
  deve saber que o 5xx pode ser do timeout, não de falha do serviço.
- **Configuração por serviço** (comparabilidade com o ponto 2; mexer quebra a comparação da Rodada 3):

  | serviço | Tomcat (threads) | Hikari (max / min idle) | virtual threads | cliente HTTP |
  |---|---|---|---|---|
  | `reservation` (caminho quente) | **300** | **1000** / 5 | desligadas | — |
  | `monolito` (gateway; até a #35 também identity, Hikari 350) | 300 | **10** / 5 desde a #36 (350 na Rodada 3) | desligadas | pool 400, resp. 10 s (reservation) · pool 400, resp. 15 s (catalog, #35) · pool 400, resp. 5 s (identity, #36) |
  | `identity` (#36) | 300 | **100** / 5 (timeout 5 s) | desligadas | — (recebe do gateway; fala só com o banco e o broker) |
  | `catalog` (#35) | 300 | **100** / 5 (timeout 5 s) | desligadas | pool 100, resp. 10 s (reservation) |
  | `notification` | sem HTTP | 3 / 1 | — | — |

  O monólito (na Rodada 3, com Hikari 350) só fazia as pré-checagens curtas (carteira, evento: uma conexão por vez por requisição, 300 threads + as do scheduler = 350); desde a #36 o gateway não toca em tabela de domínio (Hikari 10, só `actuator/health`) e
  segura a thread durante a chamada HTTP; o `docker stats` dos dois na escada da Rodada 3 mostra se ele virou gargalo.
- **A conta do pool do Supavisor.** Os três serviços usam o **mesmo tenant e o mesmo usuário** (`${POSTGRES_USER}.gerenciador-eventos`), então
  todos consomem do MESMO pool real de conexões ao Postgres (`POOLER_DEFAULT_POOL_SIZE` = 45 no compose padrão, 245 na configuração de carga =
  `max_connections` 300 − 55): ele **não cresce** por causa do `reservation` (outro usuário/tenant abriria outro pool e a soma teria de caber em
  `max_connections − 55`; por isso não foi feito). Já as conexões de CLIENTE ao Supavisor somam os Hikari: **1000 (reservation) + 350 (monólito)
  + 3 (notification) = 1353 &lt;= `POOLER_MAX_CLIENT_CONN` 1500** na #33 (que tirou 650 do Hikari do monólito, que era 1000 sozinho); com o
  `catalog` (#35, Hikari 100) a soma é **1453**; na #36 o gateway cai para 10 e entra o `identity` (Hikari 100): **1000 + 10 + 3 + 100 + 100 = 1213**. Subir qualquer um
  desses Hikari exige refazer esta conta.
- **Custo por requisição (para a Rodada 3, vs. o ponto 2; antes da #36)**: `cas` — gateway: JWT + 2 SELECT curtos (carteira, evento) no Postgres do monólito (desde a #36 nenhum: `uid` do claim, sem conferir a carteira)
  + **1 chamada HTTP**; reservation: 1 SELECT `eventcap`, 1 SELECT `existsActive` e a transação (`claim`, CAS, `reservePending`, append) —
  as mesmas do ponto 2, menos carteira/evento que agora são do gateway. `naive` — gateway: os 2 SELECT + **2 chamadas HTTP**; reservation: GET =
  1 SELECT `eventcap LEFT JOIN event_availability`; POST = SELECT `eventcap`, `existsActive` e a transação sem CAS. A rejeição "lotado" do naive
  custa só a 1ª chamada. Criar evento: +1 chamada HTTP ao reservation (+1 `GET` para reler); listar/buscar eventos: +1 chamada HTTP em lote.
  **Desde a #35 (a Rodada 3, #34, mediu sem este salto)**: o SELECT do evento virou `GET /internal/events/{id}/exists` no `catalog` (+1 salto HTTP, só
  quando o positivo não está no cache de 30 s do gateway), e ler/listar/buscar evento passa por gateway → catalog → reservation.
- **Cobertura do caminho real `/bff → reservation`**: não há teste automatizado que passe pelo `/bff` até o serviço REAL (a suíte de integração
  ponta a ponta é a #37, fora da #33). Até lá o caminho real é coberto pelo `ReservationApiE2ETest` (cliente real × serviço real) **mais** o
  roteiro `smoke-reservation-servico-separado.sh`, que deve rodar antes da Rodada 3. O `FakeReservationServer` está alinhado ao serviço real nas
  mensagens do confirm, na janela de compra, no CAS (seção crítica) e no PATCH sem `eventcap` (404), mas continua sendo um fake.
- **Smoke da stack real**: `docs/testes-manuais/smoke-reservation-servico-separado.sh` (stack no ar com o override de carga, que liga o
  seed): cria evento, 8 reservas simultâneas no evento de capacidade 3 pelo gateway → serviço, no braço do backend no ar
  (`RESERVATION_READPATH`, variável `BRACO`), e confere o banco no schema `reservation` (reservas ativas = 201 = `SlotReserved` no
  `reservation.event_store`, nada no `public.event_store`). **`cas`**: 3 x 201 + 5 x "Evento lotado", overselling 0 exigido,
  `eventcap.quant = 0`. **`naive`** (braço de controle): exige só 201 + "Evento lotado" = usuários e `eventcap.quant` = capacidade (o naive
  não toca o `eventcap`) e **reporta** o overselling (`ESPERADAS_201` opcional): a janela check-then-act passa pela rede e oversela mesmo
  sem backlog relevante na projeção (na #35: 8 x 201 e 7 x 201 em duas rodadas; o `cas` deu 3 x 201 nas duas). O roteiro antigo
  `overselling-sob-concorrencia.sh` (#9) já não roda desde a #78/#79 (cria usuário sem JWT); só as queries foram qualificadas.
- **Pendências conhecidas**: (a) o healthcheck do compose é "a porta aceita conexão" (`bash /dev/tcp`; o `/bin/sh` da imagem é dash e não tem
  `/dev/tcp`), não há health HTTP; (b) o `HttpContractTest` do monólito roda contra
  o servidor falso — o contrato com o serviço real é do `ReservationApiE2ETest` (e do smoke, até a #37); (c) `idempotency_key` e `event_availability` de eventos apagados
  ficam órfãs (inofensivas); (d) a limpeza do banco entre blocos da carga (`Projeto/carga/limpar-banco.sh`) trunca
  `public`, `reservation` e `catalog` numa instrução, move os groups `reservation`/`reservation-catalog`/`notification` para o fim dos
  tópicos e sobe `reservation` + `catalog` antes do `backend` (#35; resumo em `Projeto/carga/README.md`).

## Réplicas: estado em memória e jobs (issue #111)

> **Desde a #47** o `stock` é UMA réplica fixa (fora do scaler e do lb) e o `reservation` ganha o `SagaReaperService` (N réplicas se dividem as órfãs por `FOR UPDATE SKIP LOCKED` + CAS
> por (PK, `hold_id`, status), provado em `SagaReaperConcorrenteTest`); a soma dos Hikari do override é 1489 (ver "Serviço stock e saga stock + wallet").

Pré-requisito da autoescala de `gateway` (monólito) e `reservation`: com 2+ réplicas do mesmo serviço, (1) nenhum estado de domínio pode morar na memória
de uma réplica e (2) os `@Scheduled` rodam em TODAS as réplicas ao mesmo tempo e têm de continuar corretos. O mecanismo de subir/descer réplicas
(ADR `docs/adr/Architecture-Decision-Autoescala.md`) está na seção seguinte; esta é a auditoria do código e a prova dos jobs.

**Auditoria do estado em memória** (2026-10-28; `monolito`, `reservation` e as libs `*-client`; busca por `Map`/`List`/`Set`/`Atomic*`/`volatile`/`Caffeine`/
`ThreadLocal`/campos estáticos mutáveis e por campos não-`final` em beans singleton). Nada de domínio vive na memória: sessão não existe (JWT validado sem
estado, CSRF off), a `Idempotency-Key` está só em `reservation.idempotency_key`, as reservas e a capacidade em `walletevent`/`eventcap`, o código de cadastro/MFA
no `identity`. Os únicos campos mutáveis:

| Onde | O que é | Classe | Com N réplicas |
|---|---|---|---|
| `gateway/EventWalletGateway.eventosExistentes` | Caffeine, `exists` do evento (só positivo), 30 s, 10 mil entradas | cache recomputável | ok: cada réplica enche o seu; no pior caso um evento apagado ainda é reservável por até 30 s em alguma réplica (já aceito, ver "Resposta de `Event`") |
| `gateway/CreatorNames.cache` | Caffeine, `creator_name` por id, 45 s ±20%, 10 mil entradas | cache recomputável | ok: falha do `findNames` já não derruba a resposta |
| `gateway/security/JwtDecoderConfig` (JWKS do Nimbus) | chave pública do `identity` em cache 24 h, refetch por `kid` desconhecido a cada 30 s no máximo | cache recomputável | ok. **Operação:** apagar a chave do JWT (limpeza de banco, `TRUNCATE ... RESTART IDENTITY`) exige reiniciar **todas** as réplicas do gateway, não só "o backend" |
| `admissionclient/AdmissionClient.falhasSeguidas`/`abertoAte` | disjuntor do admission | estatística local | ok por réplica: cada uma abre o seu sozinha e faz fail-open; não há decisão global a manter |
| `admissionclient/LogComLimite`, `gateway/AdmissionIndisponivelHandler.suprimidas`/`ultimoLog` | limitador de taxa de log | só log | ok por réplica (mais linhas de log, nenhum efeito) |
| pools HTTP/JDBC (`ReservationClient`, `CatalogClient`, `IdentityClient`, `AdmissionClient`, Hikari) | conexões | recurso por processo, não estado | **dimensionamento, não correção:** a soma dos Hikari de todas as réplicas tem de caber em `POOLER_MAX_CLIENT_CONN` (hoje 1213 de 1500 com 1 réplica de cada; o Hikari 1000 do `reservation` não pode ser multiplicado) |
| `reservation`: nenhum campo mutável (só repositórios/serviços injetados e `@Value` imutáveis) | — | — | ok. Offsets dos consumers estão no broker e o checkpoint em `projection_checkpoint` (banco) |

Nenhum item quebra com N réplicas. `catalog`, `identity`, `notification` e `admission` foram auditados na #112 (seção "Os outros quatro serviços com N réplicas"; o Redis e o RabbitMQ do admission são o
estado compartilhado dele por desenho).

**Jobs com 2+ réplicas** (cada réplica roda o seu `@Scheduled`; o que os mantém corretos, e o teste que prova com N execuções simultâneas, cada uma na própria
conexão, contra Postgres e Redpanda reais, repetidas para dar chance à corrida — `Concorrencia.emParalelo` solta as threads juntas numa `CyclicBarrier`):

| Job | O que o protege | Teste (módulo `reservation`) |
|---|---|---|
| `ReservationExpiryService` | `FOR UPDATE SKIP LOCKED` em lotes + `UPDATE` condicional (`expireIfStale`, só `pending` e vencida). **Cada um sozinho já basta para a corretude**; o `SKIP LOCKED` faz as réplicas dividirem as linhas do lote (nenhuma reserva é pega por duas), o `UPDATE` condicional é a rede de segurança. Isso NÃO elimina a espera entre réplicas: as que expiram reservas do mesmo evento ainda disputam a linha do `eventcap` e podem dar deadlock, que o savepoint por linha desfaz só naquela linha (ela segue `pending` e entra no próximo tick) | `ReservationExpiryConcurrentTest`: 4 execuções simultâneas, 28 vencidas em 2 eventos (lote de 3) + 4 reservas vivas; 5 repetições. Confere: todas `expired`, nenhuma vencida `pending`, `eventcap.quant` = capacidade − vivas (cada vaga volta UMA vez; as vivas impedem o teto de esconder devolução em dobro), um `ReservationExpired` por reserva e nenhum stream com o evento repetido |
| `IdempotencyKeyRetentionService` | o `DELETE ... FOR UPDATE` em lotes de 1000: a execução concorrente espera o lote da outra e pula as linhas que sumiram; apagar é idempotente | `IdempotencyRetentionConcurrentTest`: 4 execuções simultâneas sobre 2500 chaves vencidas + 50 dentro do prazo; 3 repetições. Soma do que as execuções relatam = 2500 (cada chave apagada uma vez), nenhuma tarefa falha, as 50 válidas ficam |
| relay do `reservation.event_outbox` (`shared/events/OutboxRelay`) | `pg_try_advisory_xact_lock` (chave derivada do schema) por lote: quem não pega o lock sai sem publicar | `ReservationRelayConcurrentTest`: 3 relays simultâneos (lote de 4) drenam 45 eventos de 3 streams; 3 repetições. Outbox da rodada vazio, o tópico tem exatamente 45 mensagens (pede-se uma a mais para a duplicata aparecer), a sequência inteira do tópico é a do append (`global_position`) e cada stream sai em ordem de versão. O `OutboxRelayTest` do monólito já cobre o schema `public`; este prova o schema do `reservation` (outra chave de lock), que é onde as réplicas vão rodar |

Prova de que os testes pegam a falha (mutação local, restaurada): sem o `FOR UPDATE SKIP LOCKED` (mantido o `UPDATE` condicional) OU sem a condição do `UPDATE` (mantido o lock) o teste de expiração ainda passa (cada
guarda cobre a outra; o `SKIP LOCKED` dentro do lote é do `ReservationExpiryBatchTest`); sem as DUAS, 4 das 5 repetições falham (`quant` volta acima do esperado: vaga devolvida em dobro). Sem o advisory lock, o relay publica
mensagens em dobro e o tópico passa das 45 esperadas. A retenção não tem guarda de concorrência a remover (o `DELETE` já é idempotente): o teste prova ausência de erro e de
contagem em dobro.

**Custo, não correção:** com N réplicas o relay roda N vezes por tick (50 ms); N−1 abrem uma transação curta que só tenta o lock e sai (a ~20 por segundo cada).
**Consumers Kafka do `reservation`** (group `reservation`, projeção de disponibilidade, e `reservation-catalog`, reconciliação do `eventcap`): tópicos de 1
partição, então com N réplicas **só uma consome** e as outras ficam ociosas; a queda de quem consome passa a partição às outras por rebalance, e o checkpoint
atômico (`projection_checkpoint`) / a criação idempotente por `event_id` evitam aplicar duas vezes. O teste de rebalance e a decisão de partições são da #112 (seção "Os outros quatro serviços com N réplicas").


### Os outros quatro serviços com N réplicas (issue #112)

Máximo de **3 réplicas** em cada um de `admission`, `identity`, `catalog` e `notification` (como em `backend`/`reservation`), sempre contando a stand-by. O mecanismo
(scaler, lb, stand-by) é o da #111 e a passada (b) da #112 o liga a eles (ver "Autoescala dos outros quatro", abaixo); esta seção é a corretude de cada serviço com N réplicas.

**Auditoria do estado em memória** (2026-10-28; `identity`, `catalog`, `notification`, `admission`: busca por `Map`/`List`/`Set` estáticos e de instância, `Atomic*`/`volatile`/
`synchronized`/locks/`Caffeine`/`@Cacheable`/`ThreadLocal`/sessão/`Executor` próprio e por campos não-`final` em beans singleton). Nada de domínio vive na memória. Os únicos campos
mutáveis do `src/main` são dependências `@Autowired`/`@Value` (imutáveis depois do boot), os POJOs `PendingVerification`/`Event` (por requisição), o `CatalogEventWriter.Tx`
(um por command, local à thread) e o `AtomicBoolean` do `BrokerBloqueado`:

| Serviço | O que parece estado | Onde mora de verdade | Com N réplicas |
|---|---|---|---|
| `identity` | chave RSA do JWT (`JwtSigningKey.key`, `final`) | arquivo no volume `identity-keys`, criado com `link(2)` (exclusivo) | **mesma chave** em todas (teste abaixo); o JWKS de qualquer réplica valida o token de qualquer outra |
| `identity` | código de **cadastro** (verificação de e-mail) e tentativas | `identity.pending_verifications` (`PendingVerificationRepository`: `INSERT`/`SELECT`/`UPDATE` JDBC) | banco, nenhuma cópia em memória: o `request-verification` numa réplica e o `verify-email` em outra funcionam |
| `identity` | código **MFA** do reset de senha e a validade | colunas `users.password_reset_mfa_code`/`password_reset_mfa_expiration` (`UserRepository`) | idem |
| `identity` | reCAPTCHA (`RecaptchaService`), `PasswordEncoder` (BCrypt) | sem estado (a chamada ao Google é por requisição) | ok |
| `identity` | `@Scheduled` `NotificationEventRetentionService` | `DELETE` em lotes, idempotente (a execução concorrente espera as linhas travadas e depois vê que sumiram; um deadlock raro vira exceção do tick e o próximo repete) | ok. **Sem teste de concorrência próprio** (mesmo padrão da retenção das chaves de idempotência, provada em `IdempotencyRetentionConcurrentTest`) |
| `identity`, `catalog` | relay do `<schema>.event_outbox` | `pg_try_advisory_xact_lock` com chave derivada do schema (`OutboxRelay.lockKey`) | ok: o lock é por schema, provado para o `reservation` em `ReservationRelayConcurrentTest` (mesma classe) |
| `catalog` | `CatalogEventWriter.Tx` (`eventId`, `version`) | uma instância por command, na thread dele; a versão vem de `event.version` lida com `FOR NO KEY UPDATE` | ok |
| `catalog` | nenhuma cache (leituras vão ao banco; `exists`/`creator_name` são caches do GATEWAY) | — | ok. Leitura com N réplicas: `SELECT` puro |
| `notification` | nenhum campo mutável (sem HTTP) | checkpoint em `notification.processed_event`; offsets no broker | ok |
| `admission` | `RpmCounter` (campos `final`), `AdmissionStore`, `FilaDeAdmissao`, `AdmissionWorker` | contador, modo, espera e resultado SÓ no Redis (`adm:*`); fila no RabbitMQ | ok. Não há contador em memória para tirar e ver um teste cair |
| `admission` | `BrokerBloqueado.bloqueado` (`AtomicBoolean`) | estado **da conexão** desta réplica ao RabbitMQ (alarme de memória/disco) | correto por réplica: cada uma tem a sua conexão e a sua condição de bloqueio |
| `admission` | relógio do `RpmCounter` | cada réplica manda o seu `agora` ao script Lua (que não chama `TIME`); os buckets são `floor(agora / bucketMs)` | réplicas são containers do mesmo host e dividem o relógio do kernel, então os buckets coincidem; em hosts diferentes o desvio de relógio desloca o bucket (impacto: ms no RPM) |

**Testes novos (#112)** (Postgres, Redpanda, Redis reais; cada "réplica" é uma instância própria com a sua conexão/thread; as concorrentes largam juntas numa `CyclicBarrier`):

- **`identity`, `JwtSigningKeyTest.primeirosBootsConcorrentes...`** (5 repetições): 8 primeiros boots ao mesmo tempo no mesmo diretório vazio terminam com a **mesma chave privada** (JSON inteiro, não só o `kid`), que é a do arquivo, com permissão 600 e sem temporário sobrando;
  um token emitido pela réplica `i` valida no JWKS de toda réplica `j`. Mutação (local, restaurada): trocar o `createLink` por `Files.move(..., ATOMIC_MOVE)` — `rename(2)` no Linux do container de teste — faz o teste cair (cada réplica guarda na memória a chave que gerou e o arquivo fica com a da última).
  `publicarSemSobrescrever` não tem mais o fallback para `Files.move` sem opções (o JDK faz "existe? então `rename`", com janela de corrida): o volume precisa aceitar hard link (o volume nomeado do Docker aceita) ou o boot falha com a mensagem de gravação.
- **`catalog`, `CatalogEventSourcingTest.commandsDiferentesConcorrentes...`** (5 repetições): 8 réplicas mandando `EventUpdated` com conjuntos de apresentadores diferentes (gera `PresenterAdded`/`PresenterRemoved`) ao mesmo evento. Cada chamada conclui ou vira
  409 (`EventoEmConflitoException`); o stream fica com versões 1..n contíguas, `event.version` = n, **um `EventUpdated` por chamada bem-sucedida**, saldo de `PresenterAdded`−`PresenterRemoved` = apresentadores da projeção, uma linha de outbox por evento e replay == viva.
  `deleteConcorrenteComUpdatesCancelaUmaVezEDepoisDeleNadaSeGrava` (3 repetições): 5 updates e 2 deletes ao mesmo tempo; `EventCancelled` aparece uma vez e é o último evento (update que perde a corrida vira 404), versões contíguas, evento fora da projeção. O `updatesConcorrentes...` e o
  `conflitoDeVersao...` da #28 seguem cobrindo o retry (5 tentativas) e o conflito permanente (409). Os commands concorrentes se serializam pelo `FOR NO KEY UPDATE` de `catalog.event`; o conflito otimista só aparece com append fora da projeção (o 409 de `conflitoDeVersao...`). Mutação (local, restaurada): sem o `FOR NO KEY UPDATE` o `updatesConcorrentes...` da #28 cai (409 por conflito esgotado entre 8 threads); os novos aceitam o 409, então o que eles travam são as invariantes do log (contíguo, sem duplicata, um `EventUpdated` por sucesso, outbox 1:1); o `ON CONFLICT` do `EventStore.append` e o `FOR NO KEY UPDATE` se cobrem.
- **`admission`, `RpmCounterReplicasTest`** (Redis real): duas instâncias de `RpmCounter`, cada uma com a sua conexão, 4 threads cada, contando o mesmo evento: o RPM lido por qualquer uma é a soma exata (240 tentativas, nenhuma perdida nem em dobro); e metade da carga em cada réplica
  já liga a fila do evento, porque o modo mora no Redis (`7 + 7` tentativas = 0,84 de X; sozinha cada uma ficaria em 0,42).
- **`notification`, `NotificationRebalanceTest`** e **`reservation`, `ReservationRebalanceTest`**: ver "Consumers com N réplicas" abaixo.
- **`reservation`, `CatalogReconciliationTest.mesmaMensagemEmQuatroReplicas...`**: a mesma mensagem `EventCreated` em 4 réplicas ao mesmo tempo cria o `eventcap` uma vez só (a idempotência do `reservation-catalog` está toda no `ON CONFLICT DO NOTHING`; sem checkpoint).

**Teto de concorrência no `reservation` (workers do `admission`).** O peso 0 do HAProxy NÃO para os workers: uma réplica do `admission` em stand-by já consome a fila do RabbitMQ assim que sobe, e cada worker faz um CAS no `reservation`. O base tem 32 workers (`ADMISSION_WORKER_CONCURRENCY`) numa réplica
só. No override (`docker-compose.autoescala.yml`, só esta variável do serviço `admission`) cada réplica ganha **`floor(32 / 3) = 10`**: com as 3 vivas são **30 workers** (3 × 10), dentro do teto de 32 (`ceil` daria 11 e 33, acima do teto). O preço: com UMA réplica
(começo do braço C) a fila drena com 10 workers em vez de 32, mais devagar; o braço sem autoescala (compose base) segue com 32. A Rodada 4 mede. Mudar o máximo de réplicas do `admission` exige refazer a conta (`AUTOESCALA_ADMISSION_WORKER_CONCURRENCY`).

**Consumers com N réplicas (`notification`, `reservation` e `reservation-catalog`) e partições.** Um group só tem tantos membros úteis quanto partições (no máximo uma réplica por partição), e os tópicos nascem com **1**. Decisão (extensão da ADR da autoescala, "Extensão aos demais serviços (#112)"):

| Tópico (group) | Chave | Decisão | Efeito na ordem |
|---|---|---|---|
| `identity.notification` (`notification`) | `streamId` (UUID; um stream de uma versão só por e-mail) | **3 partições** (= máx. de réplicas) | nenhuma ordem a manter entre e-mails; cada e-mail é um stream de 1 evento |
| `reservation.wallet` (`reservation`) | `event_id` | **3 partições** | a ordem por stream (e por evento) se mantém: a mesma chave cai sempre na mesma partição. **Um evento quente continua numa partição só** (a ADR do backbone já dizia: mais partições não ajudam o evento quente); escalar este consumer só ganha com vários eventos |
| `catalog.event` (`reservation-catalog`) | `event_id` | **fica 1** | só `EventCreated` de baixo volume e idempotente por `event_id`; réplicas extras ficam ociosas no group, sem custo |
| `identity.user` | — | não muda | sem consumer |

Ampliar de 1 para 3 muda o `hash(chave) mod N` UMA vez: o que já está no log fica onde está, e versões novas de um stream podem cair numa partição diferente das antigas ainda não consumidas, então dois consumers podem receber versões do mesmo stream **fora de ordem**. Isso fica coberto: o
checkpoint é por stream e, ao receber a versão `v`, o `IdempotentConsumer` relê do `event_store` as versões que faltam (`checkpoint+1 .. v`) e as aplica em ordem, e depois descarta o que chegar com `version <= checkpoint` (teste `versoesForaDeOrdem...`). **O `add-partitions` em si NÃO acontece nos testes**
nem no broker real: é irreversível e o broker é compartilhado com os testes. É o one-shot `particoes` do override de autoescala (ver abaixo), que roda só em quem sobe o override. **Os beans `NewTopic` seguem com `.partitions(1)` DE PROPÓSITO**: o `KafkaAdmin` AUMENTA as partições de um tópico que já existe quando o bean declara mais (nunca diminui), então um bean com 3
faria todo boot de serviço e todo contexto de teste ampliar o tópico real; um bean que diz 1 sobre um tópico de 3 é inofensivo.

- **`notification`, `NotificationRebalanceTest`** (tópico e group de teste `t112-*`, 3 partições criadas pelo teste, remetente fake: nenhum e-mail real): A sobe sozinho, B entra no group no meio do fluxo, A fica preso num envio além do `max.poll.interval.ms` (expulso do group com a mensagem sem commit) e depois A sai com mensagens ainda por consumir. Resultado exigido:
  **exatamente 1 envio por `eventId`** (24 eventos), todos enviados, todos em `processed_event`, **pelo menos uma reentrega observada** (sem ela "1 envio" não provaria nada), as duas réplicas consumiram, offsets do group no fim das 3 partições e o `.DLT` vazio. `reentregaAOutraReplica...`: a réplica A está no meio do envio (transação aberta, `processed_event` inserido sem
  commit) quando B recebe o mesmo evento; o `INSERT ... ON CONFLICT DO NOTHING` de B espera o commit de A e depois vê o conflito, então B não envia. Mutação (local, restaurada): fazer `registrar` devolver sempre `true` faz os dois testes cairem (2 envios).
- **`reservation`, `ReservationRebalanceTest`** (política de erro e `IdempotentConsumer` reais, tópico de teste de 3 partições, eventos appendados no `event_store` ANTES de publicar): (1) A e B no mesmo group, B entra e depois A sai, e os offsets de A nunca são comitados (A "morre" depois do commit do banco e antes do commit do offset: a janela at-least-once do rebalance), então B reentrega o que A já
  aplicou. Confere `ativos` por evento (cada reserva somada uma vez), o checkpoint de cada stream na última versão, reentrega observada, as duas réplicas consumindo, offsets no fim e `.DLT` vazio; (2) **rehash**: as versões v4, v3, v2 de um stream chegam por uma partição e a v1 por outra, depois: a v4 sozinha aplica v1..v4 (preenchimento do buraco) e o resto é descartado, `ativos` 1; (3) **`40P01`**: duas réplicas
  aplicam lotes dos mesmos dois streams em ordens opostas (o `Projection` de teste espera numa barreira depois da 1ª aplicação, com a vítima controlada pelo `deadlock_timeout`); o Postgres aborta a réplica do container com `40P01`, que sobe como `BatchListenerFailedException` com `SQLException` na causa, é **transitório** (retry, nunca DLT), a mensagem culpada é reentregue
  (≥ 2 invocações do listener), cada evento é aplicado uma vez, a partição chega ao fim (não travou) e o `.DLT` fica vazio. Mutação (local, restaurada): sem o checkpoint (`checkpoint()` devolvendo 0 e o CAS sempre verdadeiro) `ativos` do evento sobe de 2 para 8 no rebalance e de 1 para 2 no fora de ordem. O `40P01` não tem guarda de produção para tirar: o teste prova que a causa é 40P01 (o Postgres escolhe a vítima), que o retry é do handler real e que nada vai ao DLT.
- **Janela at-least-once que o aceite NÃO cobre.** Queda do processo DEPOIS do envio do e-mail e ANTES do commit do banco não é rebalance: a transação do `notification` é desfeita, o evento volta e o e-mail sai de novo (o preço de não perder nenhum, já documentado em "Serviço notification"). O mesmo vale para o commit do banco do `reservation` antes do commit do offset, mas ali a reentrega é descartada pelo checkpoint.

**Pool por réplica (a conta do Supavisor).** No override: `identity` e `catalog` com Hikari **50 por réplica** (base: 100; `AUTOESCALA_IDENTITY_HIKARI`/`AUTOESCALA_CATALOG_HIKARI`), contando a stand-by; `notification` segue com 3 e o `admission` não tem datasource. Com o máximo de 3 réplicas de cada:
`3 × 300 (reservation) + 3 × 10 (backend) + 3 × 3 (notification) + 3 × 50 (catalog) + 3 × 50 (identity) = 900 + 30 + 9 + 150 + 150 = 1239 <= POOLER_MAX_CLIENT_CONN 1500` (sobram 261). O pool real do Supavisor (45/245) continua sem crescer com réplicas. Mudar o Hikari por réplica ou o máximo de réplicas de qualquer serviço exige refazer a conta.

### Autoescala: pool por réplica, chave de réplicas ativas e guarda do run-tests (issue #111)

Mecanismo, regra 50/80 e parâmetros: ADR `docs/adr/Architecture-Decision-Autoescala.md` (opção A); como operar: `Projeto/autoescala/README.md`. Resumo do que mexe no backend:

- **Override opcional** `Projeto/docker-compose.autoescala.yml` (o compose base não muda): `backend` e `reservation` sem `container_name`/porta (`--scale`), `lb` (HAProxy 3.2.25,
  `autoescala/haproxy.cfg`) publica a 8081 e balanceia as réplicas do gateway; a porta interna `lb:8082` balanceia as do reservation e é o `RESERVATION_SERVICE_URL` do `backend`, do
  `admission` e do `catalog` (o worker pool da fila entrega já pela réplica promovida). O scaler (`autoescala/scaler.sh`, no host) sobe a réplica nova em stand-by (peso 0 no lb), promove em
  `u >= 0,80` e escoa (`state drain`) antes de descer.
- **Pool por réplica (a conta do Supavisor).** No override o Hikari do `reservation` é **300 por réplica** (`AUTOESCALA_RESERVATION_HIKARI`, = threads do Tomcat: nenhuma thread espera
  conexão no Hikari; a fila real continua no Supavisor, pool real 45/245, que não cresce com réplicas). Com o máximo de 3 réplicas de cada, **contando a stand-by** (ela abre o
  `minimum-idle`): `3 × 300 (reservation) + 3 × 10 (backend) + 3 (notification) + 100 (catalog) + 100 (identity) = 1133 <= POOLER_MAX_CLIENT_CONN 1500` na #111 (a #112 refez a conta com réplicas de `catalog`/`identity`/`notification`: 1239, ver acima; sobravam 367 para as réplicas de
  `identity` e `catalog` da #112. O compose base segue com 1000 (braço sem autoescala comparável com a Rodada R). Mudar o Hikari por réplica ou o máximo exige refazer a conta.
- **Réplicas ativas do reservation no `admission`.** O `RpmCounter` não fixa mais `X × réplicas` no construtor: o script Lua lê **`adm:replicas`** (escrita pelo scaler, TTL 15 s, renovada a
  cada laço) na MESMA ida ao Redis. Chave ausente (scaler parado) ou inválida (não inteiro, &lt; 1, > 1000, lixo) => vale `ADMISSION_RESERVATION_REPLICAS` (lado seguro: capacidade menor, fila mais
  cedo; nunca divide por zero). O mesmo script publica **`adm:hot`** (maior RPM visto, TTL de uma janela = staleness &lt;= 1 janela, atualizado a cada tentativa contada, só sobe) que o scaler
  lê por `docker exec` + `redis-cli` (a senha vem de `REDISCLI_AUTH` DENTRO do container, nunca na linha de comando). Gatilho (0,80/0,70), histerese e `HttpContractTest` inalterados com a
  chave ausente. Testes: `ReplicasAtivasTest` (Redis real; chave = 2 usa X×2, chave que muda sem recriar o contador, sem chave usa o env, 10 valores inválidos usam o env, `adm:hot` só sobe,
  tem TTL de uma janela e vai embora; o braço naive também publica, leitura não).
- **`run-tests.sh`** também aborta se houver container de `backend`/`notification`/`reservation`/`catalog`/`identity`/`admission`/`lb` rodando no project `gerenciador-eventos` (achado pelo label
  `com.docker.compose.service`, porque as réplicas do override se chamam `<project>-<serviço>-<n>` e as guardas por nome não as veem), com a lista dos nomes e o `docker stop` a rodar (pare também o scaler: com as réplicas paradas ele repõe o mínimo).
- **Falha de leitura do scaler (volta 3):** Redis ilegível, lb mudo ou `docker ps`/`inspect` com erro nunca viram "carga 0" nem "nenhum container": o laço não decide (reservation) ou não age (lb/docker) e zera os contadores de histerese; coberto no `scaler.selftest.sh` (`valida_leitura`, `zera_rastreio`, `ler_estado` com `docker`/`lb_cmd` falsos).
- **Selftest do scaler** (sem Docker): `Projeto/autoescala/scaler.selftest.sh` (decisão, histerese sem oscilar depois da promoção, descer com `A-1`, mínimo/máximo, cooldown e os parsers do HAProxy).

### Autoescala dos outros quatro: lb, regra por serviço e partições (issue #112, passada b)

Mecanismo da #111 sem mecanismo novo; detalhe e dry-run na ADR (`docs/adr/Architecture-Decision-Autoescala.md`, "Como ficou implementado (#112, passada b)") e a operação em `Projeto/autoescala/README.md`.

- **`lb`:** `haproxy.cfg` ganhou `catalog` (`:8083`), `identity` (`:8084`) e `admission` (`:8085`) (`server-template` de 3 slots, TCP check, só na rede). No override o `backend` (gateway) chama os três por `lb:<porta>` (`IDENTITY_SERVICE_URL`, `CATALOG_SERVICE_URL`, `ADMISSION_SERVICE_URL`; o JWKS do identity vem da primeira),
  porque os clientes têm pool keep-alive e ficariam presos às réplicas do início. `admission`, `identity`, `catalog` e `notification` sem `container_name`; as réplicas do identity dividem o volume `identity-keys` (mesma chave, criação exclusiva por `link(2)`).
- **Scaler (`autoescala/scaler.sh`):** a mesma `decidir_acao` para os 6 serviços. HTTP: `u = req/s da seção do lb ÷ (AUTOESCALA_<SVC>_RPS × A)` (defaults PROVISÓRIOS: identity 100, catalog 500, admission 1000; a Rodada 4 calibra). `notification` (consumer): `u = lag do group ÷ AUTOESCALA_NOTIFICATION_LAG`
  (100), sem stand-by, `ativa` = container healthy, sobe uma com `u > 0,50` e desce uma com lag 0 por 60 s, máximo = `min(AUTOESCALA_NOTIFICATION_MAX, partições de identity.notification lidas do broker)`; leitura que falha não age (CSV `sem_leitura`). CSV com a coluna `servico`
  (6 serviços; no notification `uso` = lag ÷ referência). Selftest (`scaler.selftest.sh`) cobre HTTP genérico (`rps_delta`), lag, máx. = partições, `ler_estado` com os 6 serviços e leitura do Kafka falha.
- **Partições:** one-shot `particoes` do override (`rpk topic add-partitions --num`, que ADICIONA N: lê a contagem e soma o que falta; só aumenta; não cria `identity.notification`, que nasce com a retenção curta do `NewTopic` do identity) leva `identity.notification` e `reservation.wallet` a 3. **Irreversível**: subir o override na stack
  real aumenta as partições do broker real para sempre (a Rodada 4 roda o braço sem autoescala antes do braço C). Os `NewTopic` seguem em `.partitions(1)`. Não mude `default_topic_partitions`.
- **Pool:** 1239 &lt;= 1500 (inalterado). O Hikari 50 de identity/catalog fica abaixo do Tomcat 300: as threads esperam conexão no Hikari (`connection-timeout` 5 s); 90 por réplica ainda caberia (1479). A medir na Rodada 4.
- **Dry-run (não é medição)** em project isolado com Mailpit: os 4 serviços sobem e voltam (stand-by, promoção, descarte nos HTTP; lag subindo e descendo no notification, parando em 3 réplicas = 3 partições), overselling 0 e nenhum e-mail duplicado (8001 mensagens = 8001 destinatários).
- **Pendências nomeadas:** rotação da chave com N réplicas do identity (parar TODAS, apagar o arquivo, subir, reiniciar o backend) e o `limpar-banco.sh` do kit de carga (resolvidos na #178: `Projeto/carga/limpar-banco.sh`, versionado e ciente de réplicas por label).

## Serviço catalog — issue #35 (Fase 7: terceira extração)

> **Desde a #47** o `catalog` chama o **`stock`** (`STOCK_SERVICE_URL`, `StockClient` com pool 100) onde este texto diz `reservation`/`eventcap`: mesmos verbos e caminhos de
> `/internal/eventcaps/**`, o 409 de apagar evento com reserva é a `StockConflictException`, e a reconciliação do `eventcap` (group `stock-catalog`) é do `stock`. O `catalog` NÃO
> depende do `stock` no boot.

O monólito NÃO tem mais o pacote `catalog` (nem `public.event`): o `gateway` usa o
`CatalogClient` (lib `catalog-client`) contra o serviço `catalog` (container `gerenciador-catalog`, `:8083` só na rede
`gerenciador-net`; o `backend` depende dele `service_healthy`), e `event`/`eventpresenter` e o stream `catalog.event` estão no schema
`catalog` (migração `db/migrations/20261026-catalog-schema.sql`; `03-event.sql`/`05-eventpresenter.sql` saíram, bancos novos nascem pelo
`14-catalog.sql`). Spec: `docs/superpowers/specs/2026-10-24-catalog-servico-design.md`; diagrama em
[`docs/arquitetura/fase7-servicos.md`](/gerenciador-eventos/docs/arquitetura/fase7-servicos).

- **Operação (fatia 4)**: smoke da stack real `docs/testes-manuais/smoke-catalog-servico-separado.sh` (com o override de carga, que liga o
  seed: host cria evento pelo BFF e recebe o `creator_name`; `/internal/events/**` 401 sem `X-Internal-Token` e sem porta no host; com o
  `gerenciador-catalog` parado `GET /bff/events/{id}` e a reserva dão 503, num evento sem positivo no cache de `exists`; volta e recuperação; `catalog.event` sem `public.event`; outbox
  do catalog escoando). O kit de carga lê `catalog.event` (`carga/rpm/subir-host-rpm.ps1 -Verificar`, agora com `ON_ERROR_STOP`) e a
  limpeza entre blocos trunca `catalog` junto com `reservation` (`Projeto/carga/README.md`). Lag do relay do catalog:
  `catalog.event_outbox` e `rpk group describe reservation-catalog`.

- **Gateway** (fatia 3): `CatalogUnavailableException` (rede, timeout, 5xx, 404 sem o marcador) vira **503 com corpo genérico**
  (`gateway/CatalogIndisponivelHandler`; o detalhe só no log): os `catch (RuntimeException)` dos controllers a relançam antes de virar
  404/500, inclusive na reserva (`exists` falhando nunca vira "Evento não encontrado"). Criar evento com o catalog fora/lento => 503
  "resultado incerto, confira em Meus eventos" (o timeout pode ser depois do commit). O cache positivo de `exists` (30 s) continua.
  `POST /bff/seed` só existe com `SEED_ENABLED=true` (`seed.enabled`, default `false` => 404 e nada criado); o override de carga liga.
  Testes do monólito: servidor falso `TestSupport/FakeCatalogServer` (mesmo contrato do controller real, capacidade no
  `FakeReservationServer`, subido pelo `LauncherSessionListener` `CatalogFakeSession`, URL em `catalog.service.url`; `foraDoAr(true)` =
  container parado); `HttpContractTest` (casos 1-6 do spec, `seed.enabled=true`), `SeedDesligadoTest` (caso 4), `EventWalletGatewayCasTest`
  (catalog fora na reserva). As cópias antigas (`CatalogEventSourcingTest`, `EventTest`, `EventSearchTest`, trechos de
  `SchemaConstraintsTest`/`SchemaValidationTest`) saíram do monólito (cobertura no módulo `catalog`, que ganhou os casos do reservation fora
  na criação, edição sem `eventcap`, hidratação em lote e o backfill da `20261022`); `EventCapMigrationTest` saiu (o estado-alvo dele,
  `public.event` com as colunas antigas, não existe mais em banco nenhum; a conversão segue coberta pelo `verify-20260901-migration.sh`,
  banco descartável). Migração verificada por `db/migrations/verify-20261026-migration.sh` (bancos descartáveis: guarda, casos 7, 9, 10 e o
  init completo do caso 8).

- **Serviço** (`Backend/catalog/`, README próprio; entrypoint `com.gerenciador.eventos.catalog.CatalogApplication`, porta **8083**): o
  código do pacote `catalog` do monólito (`EventService`, `CatalogEventWriter`, `CatalogEventProjection`, `EventRepository`,
  `EventPresenterRepository`, `EventPayloads`) com **toda query qualificada com `catalog.`** e `events.schema=catalog` (event store, outbox,
  snapshot e checkpoint próprios). `EventService implements catalogclient.api.EventApi` (o contrato 1:1 é checado pelo compilador dos
  dois lados). Scan: `catalog`, `shared` e `reservationclient` (o `eventcap` segue por HTTP no reservation, como antes); o
  `catalogclient` fica FORA do scan (sem cliente de si mesmo). Relay desligado por default (como no reservation; o compose da fatia 3
  liga), consumer sempre desligado. Hikari **100** com `connection-timeout` **5 s**, Tomcat 300, keep-alive sem teto / 60 s.
- **API interna** `/internal/events/**` (um endpoint por método do `EventApi`; `InternalTokenFilter` com `X-Internal-Token`, 401 em
  TODA requisição sem/errado): `POST /` (201), `PUT|GET|DELETE /{id}` (DELETE de inexistente = 204 no-op: o 404 é do gateway),
  `POST /validate` (texto), `GET /search?term=`, `GET ?creatorId=`, `GET /{id}/exists` (200 `true`/`false`, `SELECT 1`),
  `GET /{id}/creator` (só o `creator_id`, 404 se não existe), `GET|POST /{id}/image` (`application/octet-stream`, 404 sem imagem).
  Erros (`InternalApiExceptionHandler`, corpo = mensagem em texto): **400** `IllegalArgumentException`, pedido malformado e o
  **`23505`** só da constraint `Event_event_name_key` (procurado na cadeia de causas, constraint lida do `PSQLException`; dois creates
  concorrentes passam juntos pela pré-checagem; outro 23505, ex. `Event_pkey`, é 500);
  **404** `EventoNaoEncontradoException`, com o cabeçalho `X-Catalog-Nao-Encontrado` (`EventoNaoEncontradoException.HEADER`); **409** SÓ
  `EventoEmConflitoException` (delete recusado pelo reservation — o `ReservationConflictException` do cliente —, evento pré-ES, conflito de
  versão esgotado; uma `IllegalStateException` qualquer, como pool fechado ou buraco no stream, é 500); **500** o resto, com corpo
  genérico ("Erro interno no serviço catalog"; o detalhe, que pode ser SQL, fica no log).
- **Cliente** (`CatalogClient`, lib `catalog-client`; bean em `CatalogClientConfig`, o `EventApi` do gateway): HttpClient 5 como o
  `ReservationClient`, pool `CATALOG_CLIENT_MAX_CONNECTIONS` (default 400), conectar 2 s, pool 5 s, **resposta 15 s**, evict 20 s, **sem
  retry**; URL `CATALOG_SERVICE_URL` (default `http://localhost:8083`; `http://catalog:8083` no compose). 400 → `IllegalArgumentException`,
  404 COM o cabeçalho → `EventoNaoEncontradoException` (`null` em `findImage`/`findCreatorId`), 409 → `EventoEmConflitoException`; rede,
  timeout, 5xx, 404 SEM o cabeçalho (rota inexistente, URL de outro serviço) e qualquer outro status → `CatalogUnavailableException`
  (503 genérico no gateway). `exists` nunca devolve `false` por falha.
- **Schema**: `db/init-scripts/14-catalog.sql` (idempotente, só `IF NOT EXISTS`), incluído no `supabase-app-init.sql` (bancos novos).
  Banco existente: migração `20261026-catalog-schema.sql` (com o backend e o catalog parados e `pg_dump -n public` antes; derruba as
  tabelas VAZIAS que o 14 da fatia 2 criou e as sobras de teste do event store do serviço, faz o backfill de `version = 0`, `SET SCHEMA` de
  `event`/`eventpresenter` — a identity de `event_id` vai junto, sem `setval` —, derruba só as FKs que saem de `catalog.*` para fora e ABORTA se houver FK de fora apontando para `event`/`eventpresenter`
  (banco sem a `20261025`), move os
  streams `catalog.event` de `public` preservando `global_position` e ajusta só a sequence de `global_position`). Pool no compose: Hikari 100
  (1000 + 350 + 3 + 100 = 1453 &lt;= `POOLER_MAX_CLIENT_CONN` 1500 na #35; 1213 desde a #36), relay LIGADO (`EVENTS_RELAY_ENABLED=true`: sem ele o outbox cresce e a
  reconciliação do `eventcap` no reservation nunca recebe o `EventCreated`).
- **Testes do módulo `catalog`** (pacote `com.gerenciador.eventos.catalog`, nomes de relatório únicos; Postgres real, reservation =
  `TestSupport/FakeEventCapServer`, só `/internal/eventcaps`, subido pelo `LauncherSessionListener` `EventCapFakeSession`; `TestSchemas`
  default `catalog`): `CatalogEventSourcingTest`, `EventTest`, `EventSearchTest` (vieram do monólito, de onde saíram no cutover; criador = id
  solto; o `CatalogEventSourcingTest` aplica o backfill da `20261022` no schema `catalog`), `SchemaValidationTest` (tabelas/colunas/chaves,
  `eventpresenter_event_id_fkey` em cascata, zero FK cross-schema, índice de `creator_id`, autovacuum do outbox),
  `CatalogSchemaConstraintsTest` (23505 do nome, `creator_id` sem FK, cascata), `CatalogApiE2ETest` (**cliente real × serviço real**:
  CRUD e JSON do `Event`, imagem em bytes e fora das listas, `exists`/`creator` sem `findById`, 404 tipado, 400 de regra e de nome
  duplicado inclusive 8 creates concorrentes = 1×201 + 7×400, 409 delete com reserva e pré-ES, 401 sem/errado em toda rota e o POST sem
  token não grava), `CatalogClientIndisponivelTest` (sem Spring: porta morta, 500 e resposta lenta → `CatalogUnavailableException`,
  inclusive `exists`; uma chamada por falha, sem retry) e `CatalogConfigTest` (Tomcat 300, porta 8083, Hikari 100 / 5 s, schema
  `catalog`, consumer desligado, sem bean do próprio cliente). Fatia 3: `CatalogApiE2ETest` ganhou
  `illegalStateQueNaoEConflitoDa500ComCorpoGenerico` e a limpeza da linha crua em `violacaoDeOutraUniqueNaoViraNomeDuplicado`;
  `CatalogClientIndisponivelTest`, o 404 sem/com o marcador.

## Serviço identity — issue #36 (Fase 7: quarta extração)

O monólito NÃO tem mais o pacote `identity` (nem `public.users`/`mywallet`/`pending_verifications`, nem o jjwt): o `gateway` usa o `IdentityClient`
(lib `identity-client`) contra o serviço `identity` (container `gerenciador-identity`, `:8084` só na rede `gerenciador-net`, `identity/Dockerfile`; o
`backend` depende dele `service_healthy`). Os dados estão no schema `identity` (`db/init-scripts/15-identity.sql`; migração
`db/migrations/20261028-identity-schema.sql` em banco existente; `01/02/06/08` saíram do repo, o fixture dos verifys antigos está em
`db/migrations/legacy-fixtures/`). Spec: `docs/superpowers/specs/2026-10-26-identity-servico-design.md`; diagrama em
[`docs/arquitetura/fase7-servicos.md`](/gerenciador-eventos/docs/arquitetura/fase7-servicos); README do módulo em `identity/README.md`, contrato `/internal/**` tabelado em
`identity-client/README.md`.

- **Serviço** (`Backend/identity/`; entrypoint `com.gerenciador.eventos.identity.IdentityApplication`, porta **8084**): o código do pacote `identity` do
  monólito com **toda query qualificada `identity.`** e `events.schema=identity` (event store, outbox, snapshot e checkpoint próprios). É dono de
  `users`, `mywallet` (junto de `users`: a FK `mywallet_user_id_fkey` e o trigger 1:1 `create_wallet_for_user` não cruzam schema), `pending_verifications`,
  do login (BCrypt), do cadastro em duas fases, do reset de senha com MFA, da troca de senha, do reCAPTCHA (`RECAPTCHA_SECRET_KEY` **só** aqui) e da
  emissão do JWT. CRUD relacional, **não** event sourcing. Scan: `identity` e `shared` (o `identityclient` fica FORA: sem cliente de si mesmo).
  `UserService implements UserApi`; o gateway usa `IdentityClient implements UserApi`/`EmailVerificationApi`/`MyWalletApi`/`RecaptchaApi`.
- **JWT RS256** (`JwtSigningKey` + `JwtIssuer`, Nimbus JOSE+JWT 9.37.4, a do Spring Security 6.5.6, pela propriedade `nimbus-jose-jwt.version` do pom pai):
  chave RSA 2048 gerada no **1º boot** e persistida em `JWT_SIGNING_KEY_PATH` (default `/var/lib/identity/jwt-signing-key.json`, volume nomeado
  `identity-keys` no compose; 600 quando o FS suporta). **Nenhuma variável nova no `.env`** e `JWT_SECRET` deixou de ser lido por qualquer serviço.
  Header `kid` = thumbprint SHA-256 da JWK pública (RFC 7638); claims `sub` (e-mail), `uid` (long), `isHost` (boolean, lido do banco **na emissão**),
  `iss` = `gerenciador-identity`, `iat`, `exp` (`JWT_EXPIRATION_SECONDS`, 36000). **Todo** token (login e verify-email) leva `uid` e `isHost`. Arquivo
  ilegível ou corrompido = **falha no boot** (nunca regera por cima: tokens válidos sumiriam em silêncio). Sobrevive a `docker restart`/`up --build`;
  `docker compose down -v` apaga o volume (todo token vira 401: relogar). Rotação = apagar o arquivo e reiniciar (não automatizada). `GET /.well-known/jwks.json`
  devolve só a parte pública; o `InternalTokenFilter` isenta **somente a URI exata com GET** (`/.well-known/jwks.json;x` cai no filtro: 401).
- **`uid` reciclado (operação)**: `TRUNCATE ... RESTART IDENTITY` em `identity.users` (testes, limpeza do banco entre blocos da carga) devolve o `user_id` a 1, e o JWT
  é validado sem estado: um token emitido antes passaria a valer como o usuário novo com o mesmo id (reservar, criar evento como host se `isHost`). Regra: **sempre que
  truncar `identity.users` fora de um teste unitário, apague a chave do volume e reinicie o identity E o backend** (o gateway guarda o JWKS em cache por até 24 h; só
  reiniciar o identity não basta). O `run-tests.sh` apaga a chave no início e ao fim da rodada (identity e backend parados); o `limpar-banco.sh` da carga (`Projeto/carga/limpar-banco.sh`)
  também: logo depois de parar os serviços e ANTES do TRUNCATE apaga o arquivo do volume (se falhar, aborta sem religar identity nem backend), sobe o identity, espera `healthy` e só então religa o backend. Manual:
  `docker run --rm -v gerenciador-eventos_identity-keys:/k maven:3.9.7-eclipse-temurin-21-jammy rm -f /k/jwt-signing-key.json` com o identity parado.
- **API interna** `/internal/**` (`InternalTokenFilter` com `X-Internal-Token`; 401 em TODA requisição sem/errado, inclusive `/internal;x=1/...`):
  `/internal/users/**` (espelha o `UserApi`: create, `{id}`, `by-email`, update, deactivate, validate, `login`, `password`, `password-reset-mfa` (+ `/verify`),
  `password-with-mfa`, `exists`, `names` em lote), `/internal/registrations` (+ `/verify`, `/resend`), `/internal/wallets/{userId}` (+ `/exists`),
  `POST /internal/recaptcha/verify`. **Login e verify-email devolvem `{user, token}`** (o gateway não assina nada). Erros: **400** texto de regra
  (`IllegalArgumentException`; pedido malformado também, nunca o JSON padrão do Spring); **401** de credenciais SEMPRE com `X-Identity-Credenciais-Invalidas`
  (login e verify-MFA, inclusive usuário inexistente e código nulo; o 401 do `InternalTokenFilter` NÃO leva o marcador, para um `INTERNAL_API_TOKEN` errado virar
  503 e não "senha errada"); **404** com `X-Identity-Nao-Encontrado`; **500** genérico (detalhe só no log). reCAPTCHA: sempre 200 com o envelope `{status, body}`
  (`status` 200 + `{success, score, action}`, ou 500 + `{success:false, error}`); `RECAPTCHA_VERIFY_URL` (property, default a URL do Google; o teste aponta para um fake local),
  timeouts 2 s/5 s. `POST`/`PUT /internal/users` gravam `admin` como sempre e **nunca `host`** (senão o IDOR #166 viraria auto-promoção a host). `PUT /internal/users/{id}` (#170) é UM `UPDATE` com `COALESCE` (nascimento e `admin` não informados ficam como estão, sem ler-mesclar-gravar); `UserUpdateConcorrenteTest`. **Desde a #171 o PUT IGNORA o campo `password`** (nulo, vazio ou com valor: o `UPDATE` nem o menciona, e a resposta devolve `password` nulo, sem hash): a senha só muda por `/password` e `/password-with-mfa`, e o PUT appenda só `UserUpdated`, nunca `UserPasswordChanged` (`UserUpdateIgnoraSenhaTest`; contrato visível no `HttpContractTest#updateUser_passwordNoCorpoEIgnoradoELoginAntigoSegueValendo`, que segue dando 200 com `password` no corpo de `PUT /bff/users/{id}`). `PUT /internal/users/{id}` com e-mail de OUTRA conta (sem diferenciar caixa) => 400 (#166).
- **Cadastro**: `verify-email` consome uma tentativa por chamada (`UPDATE ... WHERE attempts < max_attempts`, atômico); depois de `max_attempts` até o código certo é
  recusado; o reenvio gera código novo e zera o contador. O fim do `pending_verifications`, o `INSERT` em `users` (a carteira nasce pelo trigger) e o `UserRegistered` entram na
  MESMA transação.
- **Eventos** (`IdentityEvents`, relay ligado no compose; sem ele nenhum e-mail de cadastro/MFA sai): `identity.notification` (pedido de e-mail; contrato e tópico
  **congelados**, o `notification` não muda; leva e-mail e código, apagado pelo `NotificationEventRetentionService` depois de 30 s) e `identity.user` (um stream por usuário,
  `UserRegistered`/`UserUpdated`/`UserDeactivated`/`UserPasswordChanged`, **payload só com ids**, na transação da escrita; sem consumer nesta issue, logo sem group novo para o
  `run-tests.sh` mover).
- **Cliente** (`IdentityClient`, lib `identity-client`; bean em `identityclient/IdentityClientConfig`, no gateway): HttpClient 5 como o `CatalogClient`, pool
  `IDENTITY_CLIENT_MAX_CONNECTIONS` (default 400, >= as 300 threads do Tomcat do gateway), conectar 2 s, pool 5 s, **resposta 5 s**, evict 20 s, **sem retry**; URL
  `IDENTITY_SERVICE_URL` (default `http://localhost:8084`; `http://identity:8084` no compose). 400 → `IllegalArgumentException`, 404 COM marcador →
  `IdentityNaoEncontradoException`, 401 COM marcador → `null`/`false` (só login e MFA); rede, timeout, 5xx, 404/401 SEM marcador e qualquer outro status →
  `IdentityUnavailableException` → **503 genérico** no gateway (`gateway/IdentityIndisponivelHandler`, log só da classe). `exists` nunca devolve `false` por falha. O
  `CreatorNames` segue tolerante (nome nulo).
- **Gateway** (cutover, fatia 3): validação do JWT e autorização por claim em `gateway/security` (ver "Rotas e segurança"); `EventWalletGateway` **não confere mais a carteira**
  (ela nasce no mesmo `INSERT` do usuário, nenhuma rota apaga usuário ou carteira e o `uid` vem assinado; conferir seria um salto HTTP por reserva); `/bff/my-wallets/**` chama
  `/internal/wallets/**`; relay do monólito desligado (`EVENTS_RELAY_ENABLED=false`, não há mais o que publicar) e Hikari 10 (só `actuator/health`). Identity fora: login,
  cadastro (request-verification, verify-email, resend), MFA, troca de senha, `/bff/users/**` (inclusive `/me`) e `/bff/my-wallets/**` → **503** (nunca 401/500); reserva e leitura de
  evento com token válido **seguem** (JWKS em cache). Contrato `/bff/**` igual (`HttpContractTest`), com as mudanças: token RS256 (os HS256 antigos viram 401, relogar uma vez),
  `uid` inexistente sem 401 em `event-wallets`, bearer lixo em rota pública continua 200.
- **Guarda de boot**: `PublicSchemaGuard` (`@PostConstruct`) recusa subir se `to_regclass('public.users')` não for nulo (migração `20261028` pendente): senão rodaria sobre
  tabelas novas vazias e o 1º cadastro herdaria `user_id` 1 de outro usuário. O `run-tests.sh` aborta pelo mesmo motivo. Enquanto a migração não é aplicada o container
  fica em crash-loop (`restart: unless-stopped`) e o `backend` não sobe (espera o identity `healthy`).
- **Pool (a conta do Supavisor)**: identity Hikari **100** (`connection-timeout` 5 s), Tomcat 300, virtual threads off (`IdentityConfigTest`); gateway Hikari **10**. Todos usam o
  MESMO tenant e usuário do Supavisor, então o pool real (45 / 245) não cresce. Soma dos Hikari de cliente: 1000 (reservation) + 10 (gateway) + 3 (notification) + 100 (catalog) +
  100 (identity) = **1213 &lt;= `POOLER_MAX_CLIENT_CONN` 1500**. O override de carga mantém o backend em 10 (com o 350 antigo seriam 1553). Subir qualquer um exige refazer a conta.
- **Token interno**: segue **um** `INTERNAL_API_TOKEN` para todos os serviços (todos usam o mesmo usuário de banco, então tokens por serviço não isolariam nada). O `identity` não usa
  `env_file`: recebe só banco, `INTERNAL_API_TOKEN`, `RECAPTCHA_SECRET_KEY` e `JWT_EXPIRATION_SECONDS`; o `backend` segue com `env_file` (CORS etc.) mas não lê mais `JWT_SECRET` nem
  `RECAPTCHA_SECRET_KEY` (sobrepostos por vazio no compose).
- **Testes**: no módulo `identity` (Postgres e Redpanda reais; chave de assinatura temporária por JVM e reCAPTCHA falso em `TestSupport/IdentityTestSession`): `IdentityApiE2ETest`
  (**cliente real × serviço real**: login RS256 com `kid` no JWKS e claims, cadastro em duas fases, tentativas, MFA, troca de senha, CRUD/nomes/carteira, reCAPTCHA com o fake,
  401 sem/errado em toda rota interna e JWKS só pela URI exata, `PUT` com `isHost:true` não promove), `JwtSigningKeyTest` (restart: mesma chave e token antigo válido; corrompido =
  falha no boot), `IdentityConfigTest`, `PublicSchemaGuardTest`, `SchemaValidationTest`, `IdentitySchemaConstraintsTest`, `UserLifecycleEventsTest`, `UserTest`, `MyWalletTest`,
  `IdentityNotificationEventsTest`, `NotificationEventRetentionTest`. No monólito: `FakeIdentityServer` (JDK `HttpServer`, `LauncherSessionListener` `IdentityFakeSession`, assina com uma
  chave RSA de teste e serve o JWKS dela; `foraDoAr(true)` = container parado), `HttpContractTest` (bearer lixo em rota pública = 200; token de outra chave, HS256, sem `uid` ou vencido
  = 401; identity fora = 503 em `/bff/users/me` e a reserva com token válido segue), `JwtDecoderConfigTest` (cache, 1 fetch por janela, tolerância a queda), `ModuleBoundaryArchTest`
  (nada depende do código do serviço `identity`), `IdentityClientIndisponivelTest` (lib), `ConnectionPoolSizeTest`.
- **Operação**: smoke da stack real `docs/testes-manuais/smoke-identity-servico-separado.sh` (com o override de carga, que liga o seed: cadastro com o código lido do banco, token RS256,
  login e `/me`, `/internal/**` 401 sem `X-Internal-Token` e sem porta no host, reserva no braço `cas` com overselling 0, `gerenciador-identity` parado → 503 e reserva com token válido
  201, volta, `docker restart` com o mesmo `kid` e token antigo válido; para o `gerenciador-notification` durante a execução para não mandar e-mail real). Migração verificada por
  `db/migrations/verify-20261028-migration.sh`. Lag do relay do identity: `identity.event_outbox`.
- **Fora de escopo / pendências conhecidas**: revogação de token /
  lista negra; rotação automática da chave; consumer dos eventos de ciclo de vida; remover o datasource do gateway (Hikari 10 só para o `actuator/health`).

## Serviço admission — issue #41 (Fase 7: contador de RPM por evento)

> **Desde a #47** nenhum código do `admission` mudou: o worker chama o mesmo `POST /internal/reservations?path=cas`; os 503 novos (stock fora, saga em andamento, dono que perdeu para o
> reaper) caem no caminho de 5xx existente (backoff, `nack` com requeue, mesma chave). O `replay` só vê sagas `reserved`. O teto de 32 workers passa a ser o teto de holds simultâneos.

Primeira peça da camada de alta carga (ADR "Async-Checkout-Queue"): o `gateway` conta **cada tentativa** de `POST /bff/event-wallets` no serviço `admission` (container
`gerenciador-admission`, `:8085` só na rede `gerenciador-net`, `admission/Dockerfile`), que mantém **um contador de RPM por evento em Redis**. Na #41 o RPM é **só sinal de carga** e o modo devolvido é
**sempre `sync`**: a reserva segue exatamente como antes (`HttpContractTest` sem mudança de expectativa, overselling 0 no `cas`). A fila (RabbitMQ, worker pool) é a #42 e o gatilho por uso de X, a histerese e o `202` são a #43 (subseção "Gatilho, modo fila e 202" abaixo; abaixo do gatilho nada muda).
Spec: `docs/superpowers/specs/2026-10-28-admission-servico-design.md`; README do módulo em `admission/README.md` e `admission-client/README.md`.

- **Onde contar (decisão da spec): salto HTTP ao `admission`, não o gateway direto no Redis.** O modo do evento (#43) depende do estado da fila e, em modo fila, a mesma chamada publica a mensagem; só o
  `admission` terá Redis e RabbitMQ, e contar no gateway o faria ler o keyspace de outro serviço e levar credenciais ao gateway. **Custo medido na #41:** a opção A (gateway → Redis) seria 1 ida ao Redis;
  a escolhida (B) são **1 ida HTTP keep-alive ao `admission` + 1 ida dele ao Redis**, as duas dentro do "no máximo 1 ida" do aceite. **Medido (2026-10-28, mini dry-run no project do e2e, não é medição de carga):**
  1000 `POST /internal/admissions` sequenciais em keep-alive, de um container na rede do project (salto HTTP + script Lua no Redis): **p50 0,82 ms, p95 1,74 ms, p99 2,77 ms** (máx. 10 ms). É o custo
  acrescentado a cada reserva síncrona, frente a uma p50 da reserva de ~165 ms no último degrau limpo da Rodada R; o efeito no X sai na Rodada 4.
- **Quando conta:** depois das validações do gateway (token, `userId`, `eventId` positivo, evento existe) e antes do `reservation`, **nos dois braços** (`cas` e `naive`; no `naive`, antes da leitura de
  disponibilidade: a janela check-then-act dele não muda). `EventWalletGateway.addLink` chama `AdmissionApi.admit` UMA vez. **`Idempotency-Key`:** sem chave na requisição o **gateway gera um UUID** (o `admission` exige uma chave, que na #42/#43 será a da
  mensagem) e o manda **SÓ ao `admission`**; o `reservation` é chamado exatamente como antes da #41, com a chave **do cliente** (nula se ele não mandou). Mandar sempre uma chave faria o serviço tratá-la como "do
  cliente" e consultar `idempotency_key` em toda rejeição de pré-requisito (custo novo no caminho síncrono; achado do revisor). O `admission` valida a chave com a regra do `reservation` (não vazia, até 255;
  mais que isso = 400 com a mesma mensagem), mas o cliente ignora esse 400 na #41 (a chave longa do cliente chega ao `reservation`, que dá o 400 de sempre). Na #43 o gateway
  passou a usar a chave efetiva (do cliente ou a gerada) também no `reservation`, mas SÓ no fail-open do braço `cas` (o `admission` pode ter publicado antes de o gateway desistir); nesse modo degradado o serviço a trata como
  "do cliente" e paga a consulta extra de `idempotency_key` nas rejeições de pré-requisito (custo aceito pela spec, linha "Idempotency-Key no gateway"). Com o `admission` respondendo `sync`, a chave segue a do cliente.
- **API interna** (`InternalTokenFilter`: `X-Internal-Token` em TODA requisição, 401 sem/errado, sem rota pública; sem `INTERNAL_API_TOKEN` o serviço e o cliente falham no boot):
  `POST /internal/admissions` (corpo `{eventId, userId, idempotencyKey, path}`; `200 {"mode":"sync","rpm":n}`; 400 de validação) e `GET /internal/admissions/events/{eventId}/rpm`
  (`{"eventId":n,"rpm":n}`, só leitura; 503 com o Redis fora). O corpo e a resposta já têm a forma final (a #43 só acrescenta `queued` e os campos de estado). Erros em texto puro.
- **Contador** (`RpmCounter` + `scripts/rpm.lua`): buckets de `ADMISSION_BUCKET_MS` (**50**) somados numa janela de `ADMISSION_WINDOW_MS` (**200**, múltiplo do bucket; recusado na subida se não for).
  Chave `adm:cnt:<eventId>:<bucket>` com `bucket = floor(agoraMs / bucketMs)`, `INCR` + `PEXPIRE` (janela + 1 bucket: **toda chave tem TTL**), RPM = soma dos buckets da janela x 60000 / **tempo coberto**, com
  tempo coberto = `janela − bucket + (agora mod bucket) + 1 ms` (o bucket corrente está parcial: dividir pela janela cheia leria 75–100% da taxa real e ficaria abaixo do limiar nos primeiros ms de cada bucket;
  `RpmCounterTest` confere uma taxa constante de 12.000 RPM lida a ±3% em qualquer ponto do bucket). **Um script Lua = UMA ida ao Redis, atômica** (lê chaves fora de `KEYS`: não serve a Redis Cluster, e o
  admission usa um Redis único). O "agora" é o do
  relógio do admission (um só processo). **Por que 200 ms:** o X (56k RPM ≈ 930 tentativas/s) foi medido no mapeamento `sequencial`, em que as 200 tentativas de cada evento chegam numa rajada de ~0,2 s e a
  taxa na linha quente é a do degrau; com 200 ms uma rajada a 56k RPM lê ~56k RPM, com 1 s leria 12k e o gatilho da #43 nunca dispararia, com 60 s nunca. Ruído no limiar de 44,8k RPM (≈ 149 por janela): ~8%
  (Poisson). As duas envs permitem outra escala (o e2e e o dry-run usam X baixo).
- **Fail-open (`gateway` e `admission`):** qualquer falha da chamada (rede, timeout, 5xx, 401, e na #41 também o 400) → **modo `sync`**, a reserva segue pelo caminho de hoje, com log. **No cliente** (`AdmissionClient`, lib `admission-client`):
  HttpClient 5, pool `ADMISSION_CLIENT_MAX_CONNECTIONS` (400, >= threads do Tomcat), conectar **200 ms**, pool **200 ms**, resposta **500 ms**, evict 20 s, sem retry, URLs montadas pelo `RestClient` (nada de
  concatenação), **disjuntor**: 5 falhas seguidas abrem o circuito por `ADMISSION_CLIENT_OPEN_MS` (5000; nesse tempo nenhuma chamada sai), depois UMA chamada testa (sucesso fecha, falha reabre); o 400 (serviço vivo recusando o pedido) zera a contagem de falhas e só loga; log WARN com limite de taxa (no máximo 1 linha a cada 10 s, com a contagem acumulada), **401 (token diferente nos dois lados) é ERROR**. **No serviço:** `spring.data.redis.timeout` e
  `connect-timeout` de **200 ms** (`ADMISSION_REDIS_TIMEOUT_MS`), comandos **rejeitados na hora** sem conexão (`REJECT_COMMANDS`, senão o Lettuce os enfileiraria até o timeout) e Redis fora ou lento
  responde **503** (no `POST` e no `GET`): o fail-open é do CLIENTE, e um 200 `sync` aqui esconderia a falha do disjuntor do gateway, que nunca abriria e pagaria os 200 ms do Redis travado em TODA reserva.
  O `backend` **não** depende do `admission` no compose.
- **Redis no compose** (`redis`, container `gerenciador-redis`): imagem `redis:7.4.12-alpine` (tag fixa), `--requirepass` de `${REDIS_PASSWORD:?...}` (**sem default**: qualquer `docker compose` recusa sem a variável),
  **sem persistência** (`--save "" --appendonly no`: o contador se refaz em 200 ms), `--maxmemory 512mb --maxmemory-policy volatile-ttl` (só chaves com TTL são candidatas, e toda chave tem; sob pressão saem primeiro as de vida mais curta; 512 MB desde a #42, que guarda também o resultado e a espera da fila), healthcheck
  `redis-cli ping` autenticado por `REDISCLI_AUTH` (a senha nunca vai na linha de comando do healthcheck), **sem porta no host**, só na `gerenciador-net`. O `admission` é o único cliente; o `backend` recebe
  `REDIS_PASSWORD` sobreposta por vazio (o `env_file` entrega o `.env` inteiro).
- **O que você acrescenta ao `Projeto/.env`** (o repo nunca edita nem imprime o `.env`): `REDIS_PASSWORD=<valor aleatório>`, por exemplo `openssl rand -hex 32` (o `INTERNAL_API_TOKEN` já existe). Sem ela o
  compose recusa (`up`, `config`, inclusive o `up -d db redpanda redis` dos testes); até lá, exporte na shell só para o comando (a shell vale mais que o `.env` na interpolação).
- **Configuração** (por env, defaults no `application.properties` de cada lado): serviço — `INTERNAL_API_TOKEN`, `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`, `ADMISSION_REDIS_TIMEOUT_MS`, `ADMISSION_BUCKET_MS`,
  `ADMISSION_WINDOW_MS`, `SERVER_TOMCAT_THREADS_MAX` (Tomcat 300, virtual threads desligadas, `max-keep-alive-requests=-1`, `keep-alive-timeout` 60 s); gateway — `ADMISSION_SERVICE_URL`
  (`http://admission:8085` no compose; default de dev `http://localhost:8085`), `ADMISSION_CLIENT_*`.
- **Sem datasource (a conta do Supavisor não muda):** o módulo não depende de `shared` (que traz o `DatabaseConnection`), não tem Hikari nem tabela: soma dos Hikari segue 1000 + 10 + 3 + 100 + 100 = 1213 &lt;= 1500.
- **Testes:** ver "Testes" (`RpmCounterTest` com Redis real, `AdmissionApiTest`, `AdmissionRedisRecusadoTest`/`AdmissionRedisTravadoTest`, `AdmissionClientTest`, `EventWalletGatewayAdmissionTest`). O `run-tests.sh` exige o Redis e aborta com o
  `gerenciador-admission` no ar. A prova de overselling 0 contra o `reservation` REAL é do e2e (`Projeto/e2e/run-e2e.sh`, que sobe `redis`, `rabbitmq` e `admission` isolados, com credenciais efêmeras, e confere que o
  Lua do contador rodou na stack real) e do dry-run.
- **Caminho síncrono idêntico ao anterior:** o `reservation-client` e o `reservation` NÃO mudaram na #41; a única diferença do caminho síncrono é o salto de contagem (+1 ida HTTP ao `admission` e +1 ida dele ao Redis).
- **Gatilho/histerese, `202` no gateway e a consulta no `/bff`:** são a #43 (subseção "Gatilho, modo fila e 202" no fim desta seção).

### Fila de admissão (RabbitMQ) e worker pool — issue #42

O `admission` ganhou a fila: **RabbitMQ**, a topologia declarada por ele, o caminho de enfileirar, o worker pool que chama o `reservation` e o resultado consultável por mensagem no Redis. **O gatilho que liga isto ao
`POST /internal/admissions` é da #43** (subseção seguinte): na #42 o `POST` seguia devolvendo `sync` e o caminho de enfileirar era um **método de serviço** (`FilaDeAdmissao.enfileirar`) exercido pelos testes. Spec: a mesma
(`docs/superpowers/specs/2026-10-28-admission-servico-design.md`, linhas "Topologia", "Mensagem", "Worker pool", "Ack e reentrega", "Dead-letter e reconciliação", "Resultado", "Repetição da chave", "Limite por usuário").

- **RabbitMQ no compose** (`rabbitmq`, container `gerenciador-rabbitmq`): imagem `rabbitmq:4.1.8-alpine` (tag fixa, **sem** o plugin de management: sem porta 15672 nem UI), `RABBITMQ_DEFAULT_USER`/`RABBITMQ_DEFAULT_PASS` de
  `${RABBITMQ_USER:?...}`/`${RABBITMQ_PASSWORD:?...}` (**sem default**: qualquer `docker compose` recusa sem as variáveis), healthcheck `rabbitmq-diagnostics -q ping`, **sem porta no host**, só na `gerenciador-net`.
  **Sem volume persistente** (`tmpfs` em `/var/lib/rabbitmq`): o usuário criado no 1º boot vive no diretório de dados, e um volume (inclusive o anônimo que a imagem declara) prenderia a senha do 1º boot.
  **Consequência aceita:** reiniciar o broker perde as mensagens em fila; os resultados `queued` delas viram `timed_out` depois do `deadline` e o cliente repete o `POST` com a mesma chave. O `admission` depende do
  `rabbitmq` e do `reservation` (`service_healthy`); o `backend` recebe `RABBITMQ_USER`/`RABBITMQ_PASSWORD` sobrepostas por vazio. O Redis do compose passou a `--maxmemory 512mb --maxmemory-policy volatile-ttl`
  (toda chave tem TTL; sob pressão saem primeiro as de vida mais curta).
- **O que você acrescenta ao `Projeto/.env`** (o repo nunca edita nem imprime o `.env`): `RABBITMQ_USER=<nome>` e `RABBITMQ_PASSWORD=<valor aleatório>` (ex.: `openssl rand -hex 32`), além da `REDIS_PASSWORD` da #41. Sem elas o
  compose recusa; até lá, exporte na shell só para o comando. Mudar o usuário/senha exige recriar o container (`tmpfs`: o 1º boot cria o usuário).
- **Topologia** (declarada pelo serviço ao conectar, `AdmissionTopology`): exchange **topic** durável `admission`, routing key **`event.<eventId>`** (a chave da mensagem é o `event_id`), ligada com `event.*` a **uma fila durável**
  `admission.requests` com `x-message-ttl` = `ADMISSION_QUEUE_TTL_MS` (30000, o tempo máximo na fila), `x-max-length` = `ADMISSION_QUEUE_MAX_LENGTH` (100000) com `x-overflow=reject-publish` e dead-letter para a
  `admission.dlx` (routing `timed_out`), que entrega na fila `admission.timed_out`. **Uma fila em vez de uma por evento**: o worker pool é um teto GLOBAL de CAS simultâneos (o que a ADR controla); filas por
  evento exigiriam declarar/escutar filas dinamicamente e limpá-las; a routing key por evento deixa a porta aberta. **A ordem por evento não é garantida**: a corretude é do CAS. Mudar o TTL ou o tamanho de uma fila que já existe
  exige apagá-la (PRECONDITION_FAILED na redeclaração; o broker não tem volume: reiniciá-lo basta). Nomes com prefixo `admission.amqp.prefix` (vazio em produção; **os testes usam um por classe**).
- **Mensagem** (`AdmissionMessage`): JSON `{userId, eventId, idempotencyKey, attemptId, deadline}`, persistente, **sem dado pessoal**. `attemptId` = UUID por publicação (amarra mensagem, espera e resultado: uma reentrega de uma tentativa
  antiga nunca mexe na nova da mesma chave); `deadline` = epoch ms da decisão + TTL.
- **Enfileirar** (`FilaDeAdmissao.enfileirar`, método de serviço): valida o pedido (a regra da Idempotency-Key é a do reservation) e **só aceita `path=cas`** (`naive` = `IllegalArgumentException` "a fila de admissão só aceita path=cas": a mensagem não leva o braço e o worker reserva sempre pelo CAS, o que falsearia o braço de controle), roda UM script Lua (`enfileirar.lua`: repetição da chave, limite por usuário, grava o `queued`
  e a espera) e **publica com publisher confirms correlacionados e `mandatory`**, numa **conexão AMQP própria** (`AdmissionRabbitConfig`: `setUsePublisherConnection(true)`; com uma só conexão, um alarme de memória/disco do broker bloquearia a conexão que publica e os acks dos workers, que andam nela, parariam de ser processados). A topologia é declarada pela conexão dos consumers. Falhas: chave de OUTRO evento = `ChaveReusadaException` (422); limite por usuário (`ADMISSION_MAX_WAITING_PER_USER`, 5) =
  `LimiteUsuarioException` (429); **fila cheia** (nack do broker, `reject-publish`) = `FilaCheiaException` (429; não vai ao CAS: é o que a ADR evita no pico); exceção antes do envio, **broker bloqueado**
  (`BlockedListener` → `ConnectionBlockedEvent`) ou **mensagem sem rota** (`returned`) = `NaoPublicadaException`, e nos quatro casos a entrada é **desfeita** (o chamador, na #43, segue `sync`). Envio feito mas SEM confirmação em
  200 ms (`ADMISSION_PUBLISH_CONFIRM_TIMEOUT_MS`) = tratado como **publicado** (devolve `queued`; se a mensagem não chegou, o `queued` vence pelo `deadline`). Repetição da chave: `queued`/`pending` do mesmo evento devolve o
  estado atual SEM publicar; `rejected`/`timed_out` (e o `queued` vencido) são sobrescritos por uma tentativa nova (uma falha não consome a chave, como no síncrono); a repetição é avaliada ANTES do limite por usuário.
- **Worker pool** (`AdmissionWorker`, `admission.worker.enabled`): `@RabbitListener` na `admission.requests`, **ack manual**, **concorrência FIXA** `ADMISSION_WORKER_CONCURRENCY` (32) e **prefetch 1**: é o teto de CAS simultâneos no
  reservation. O `ReservationClient` do serviço (`AdmissionReservationConfig`, lib `reservation-client`, URL `RESERVATION_SERVICE_URL`, o mesmo `INTERNAL_API_TOKEN`) tem pool = concorrência do worker + da dead-letter e os
  timeouts do gateway (conectar 2 s, pool 5 s, resposta 10 s). Por mensagem: (0) tira da espera; se o resultado da chave não é desta tentativa ou já é final, **ack e fim** (desvio consciente do "ack só depois da
  resposta do reservation": a mensagem já tem resultado final gravado); (1) `agora > deadline` = reconcilia e ack; (2) senão `POST /internal/reservations?path=cas` com a `Idempotency-Key` da mensagem: **201 → `pending`** (com o
  `expiresAt` do `walletevent`), **4xx de negócio** (400 "Evento lotado", "Vínculo já existente", janela de compra, "Capacidade do evento não configurada"; 422 chave reusada com outro evento) **→ `rejected`** com o motivo (o texto do
  reservation, sem dado pessoal), ack. **Reservation fora, timeout, 5xx, 401 ou QUALQUER exceção** (Redis fora, bug): espera `ADMISSION_RETRY_BACKOFF_MS` (500) na thread do worker, **volta à espera** (`ZADD`) e `basicNack(requeue=true)`:
  nenhuma mensagem fica sem ack e nenhum worker fica preso; a mensagem volta à MESMA fila (o TTL original vale) e o `deadline` do corpo garante o limite. **Reentrega depois de um CAS que comitou é segura**: o reservation devolve o
  resultado salvo pela chave (#129) e não toca o `eventcap` (provado contra o reservation REAL pelo `IdempotencyKeyTest` do módulo `reservation` e, ponta a ponta, pelo e2e/dry-run da #43; aqui, contra o falso).
  Mensagem ilegível, inclusive com campo obrigatório nulo (`userId`, `eventId`, `idempotencyKey`, `attemptId`), é descartada com ack (reentregar não conserta). Um `Error` da JVM no processamento também devolve a mensagem (nack) e vai para o
  log em ERROR, **sem ser relançado**: o Spring AMQP PARARIA o container inteiro (todos os workers, em silêncio: o healthcheck é TCP).
  **O teto de CAS simultâneos vale enquanto o CAS responde dentro do timeout de 10 s do cliente**: se o cliente desiste e o `reservation` segue com aquele CAS em voo, o worker devolve a mensagem e a reentrega pode ficar simultânea à primeira
  (a idempotência do reservation garante uma vaga só, mas o número de requisições em voo passa do teto por esse intervalo). Na reconciliação, um CAS que comita depois do `replay` deixa `timed_out` com a reserva feita: o lado seguro já descrito.
- **Dead-letter e reconciliação**: a mensagem que morre na fila (TTL) vai à `admission.dlx` → `admission.timed_out` (que tem o mesmo `x-max-length`, drop-head: com o listener parado não cresce sem teto; a reconciliação é best-effort). O listener dela (`ADMISSION_DLX_CONCURRENCY`, 4; só reconcilia um `queued` DESTA tentativa: resultado já final ou de outra tentativa só dá ack) e o passo (1) do worker **reconciliam**: `GET /internal/reservations/replay`
  (o método `ReservationClient.replay` passou a **público** na lib; o contrato HTTP não mudou). Há reserva com a chave (o CAS comitou e a resposta se perdeu) → `pending` com o `expiresAt` dela; senão, ou com qualquer erro
  (reservation fora, 422), → `timed_out`. Só sobrescreve um `queued` **da mesma tentativa**. O listener da dead-letter **sempre** dá ack (lado seguro: a reserva, se existir, aparece em "minhas reservas" e o job de expiração devolve a vaga).
  `timed_out` ≠ `expired` (o `pending` vencido pelo job do reservation). No classic queue o TTL só dispara com a mensagem na cabeça da fila: como todas têm o mesmo TTL e a ordem é FIFO, a expiração acompanha a ordem.
- **Resultado e espera no Redis** (`AdmissionStore`, scripts em `scripts/*.lua`): `adm:res:<userId>:<chave>` = JSON `{status, eventId, attemptId, deadline, expiresAt?, reason?}`, **toda escrita com `EX`** =
  `ADMISSION_RESULT_TTL_SECONDS` (600: cobre a janela de confirmação com folga; a 750 req/s em fila são ~450 mil chaves, ~110 MB), o `queued` gravado ANTES de publicar e o estado final por **compare-and-set** (`concluir.lua`:
  só sobrescreve o `queued` da mesma tentativa). Um `queued` cujo `deadline` + 60 s já passou vale como `timed_out` em toda leitura. **Espera** (o que foi publicado e ainda não foi pego por um worker; a #43 a lê para a
  histerese "fila do evento vazia"): ZSET `adm:wait:<eventId>` e `adm:uwait:<userId>`, membro `userId:chave:tentativa`, score = `deadline`; `ZADD` ao enfileirar e quando o worker devolve a mensagem à fila, `ZREM` quando o worker a
  pega, na dead-letter e quando a publicação é desfeita (idempotente: reentrega não decrementa duas vezes); o que passou do `deadline` sai sozinho (`ZREMRANGEBYSCORE`); TTL da chave = TTL da fila + 60 s.
- **`GET /internal/admissions/result?userId=&idempotencyKey=`**: 200 com `{status, eventId, expiresAt?, reason?}` (`AdmissionStatus`, na lib `admission-client`; **sem** `attemptId`/`deadline`) ou **404 sem corpo**; 400 sem parâmetros,
  `userId` não positivo ou chave em branco; 401 sem token; Redis fora = 503. O `/bff` que o expõe é da #43.
- **Log sem credencial**: o `CachingConnectionFactory` loga em INFO o `toString` da conexão (`amqp://<usuário>@<host>:5672/...`), que levaria o `RABBITMQ_USER` do `.env` ao log; o serviço o põe em WARN (`logging.level...CachingConnectionFactory=WARN`), coberto por `AdmissionLogsTest`. O serviço **recusa subir** com `ADMISSION_RESULT_TTL_SECONDS` menor que o TTL da fila + a carência de 60 s (o `queued` expiraria antes do worker e a mensagem seria descartada sem reservar).
- **Variáveis novas** (por env, defaults no `application.properties` do serviço; o compose repassa todas): `RABBITMQ_HOST`/`RABBITMQ_PORT`/`RABBITMQ_USER`/`RABBITMQ_PASSWORD` (sem default de usuário/senha), `RESERVATION_SERVICE_URL`, `ADMISSION_QUEUE_TTL_MS` (30000),
  `ADMISSION_QUEUE_MAX_LENGTH` (100000), `ADMISSION_WORKER_CONCURRENCY` (32), `ADMISSION_DLX_CONCURRENCY` (4), `ADMISSION_RETRY_BACKOFF_MS` (500), `ADMISSION_MAX_WAITING_PER_USER` (5), `ADMISSION_RESULT_TTL_SECONDS` (600),
  `ADMISSION_PUBLISH_CONFIRM_TIMEOUT_MS` (200), `ADMISSION_WORKER_ENABLED` (`true`; os testes o desligam por padrão), `ADMISSION_AMQP_PREFIX` (vazio; só testes). O pool do `ReservationClient` é a concorrência do worker + a da dead-letter (4: só `replay`, leitura; o teto de CAS é a do worker).
- **Testes** (Redis e RabbitMQ REAIS, reservation FALSO = `FakeReservationServer`, JDK `HttpServer`: CAS em memória numa seção crítica, idempotência por chave, contador de chamadas simultâneas, modos "fora" e "comitar e perder a resposta"):
  `AdmissionStoreTest`, `AdmissionTopologyTest`, `AdmissionLogsTest` (nenhum log traz `amqp://`, usuário nem senha), `FilaDeAdmissaoTest`, `FilaCheiaTest` (fila cheia = nack, sem rota = returned), `AdmissionWorkerTest` (reentrega não reserva duas vezes, concorrência ≤ configurada, N > capacidade =
  overselling 0, exceção no worker = nack sem preso, tentativa antiga não mexe na nova, vencida = reconcilia), `AdmissionDeadLetterTest` (mensagem vencida vai à dead-letter e vira `timed_out`, ou `pending` se o replay achou a
  reserva) e o `GET .../result` no `AdmissionApiTest`. **A prova de overselling 0 contra o reservation REAL é do e2e e do dry-run da #43** (o CAS do falso é uma seção crítica).

### Gatilho, modo fila e 202 — issue #43

Liga a fila da #42 ao `POST /internal/admissions` e ao `/bff`. **Abaixo do gatilho nada muda** (`POST /bff/event-wallets` 201, corpo e headers de antes; `HttpContractTest` sem mudança de expectativa nos casos
existentes; overselling 0 no `cas`); acima dele a tentativa vai para a fila e termina no **mesmo `pending`** do caminho síncrono (o `walletevent` nasce `pending` com `expires_at`; a confirmação segue em
`POST /bff/event-wallets/confirm` nos dois modos).

- **Gatilho (por evento, no MESMO script Lua do contador, `scripts/rpm.lua`):** `uso = RPM do evento ÷ (X × réplicas)` com `ADMISSION_X_RPM` (**56000**, o X medido na #40), `ADMISSION_RESERVATION_REPLICAS` (**1** até a
  #111), `ADMISSION_QUEUE_ON` (**0,80**) e `ADMISSION_SYNC_BELOW` (**0,70**); `queue-on` tem de ser maior que `sync-below` e tudo positivo (recusado na subida). Em `sync`, uso ≥ 0,80 liga o modo fila do evento
  (`adm:mode:<eventId>`, TTL 1 h, renovado a cada decisão em fila); com a fila ligada, **só volta ao síncrono com uso &lt; 0,70 E a espera do evento vazia** (histerese: entre 0,70 e 0,80, ou com mensagem esperando,
  segue em fila). A espera (ZSET `adm:wait:<eventId>`, a da #42: publicada e ainda não pega por um worker; o que passou do `deadline` sai dela) é lida ANTES de contar a tentativa. A decisão vale para o braço
  **`cas`** (`RpmCounter.decidir`); o **`naive` só conta** (`contar`) e nunca enfileira nem mexe no modo. O RPM tem a janela de **200 ms** (a rajada por evento na escada dura ~0,2 s; janela maior nunca dispararia).
- **`POST /internal/admissions`** (`AdmissionService.admit`): `sync` → `200 {"mode":"sync","rpm":n}` (corpo idêntico ao da #41, 1 ida ao Redis); em modo fila, chama `FilaDeAdmissao.enfileirar` (a decisão e o enfileirar são
  duas idas ao Redis, só no modo fila; **não são atômicas entre si** (desvio aceito da spec "Gatilho (#43)"). O que isso permite: (1) A decide fila; B (uso &lt; 0,70, espera vazia) desliga o modo; A entra na espera e o `enfileirar.lua` o religa (`SET adm:mode`, TTL 1 h): o modo
  fica ligado **sem uso ≥ 0,80** (com uso entre 0,70 e 0,80 segue em fila até a primeira decisão com uso &lt; 0,70 e espera vazia); (2) A decide fila, o `enfileirar.lua` marca o modo e a publicação falha (`NaoPublicada`, entrada desfeita): a resposta é `sync`, mas o
  modo fica ligado com a espera vazia (idem: a próxima decisão com uso &lt; 0,70 o desliga); (3) o worker segura a mensagem (a espera esvazia) e uma decisão com uso &lt; 0,70 desliga o modo; o requeue (`voltar.lua`) o religa, mantendo "mensagem esperando = modo fila".
  Nenhum estado fica preso (toda decisão `cas` com uso &lt; 0,70 e espera vazia desliga o modo; mensagem perdida sai da espera pelo `deadline`) e a corretude não é afetada (o CAS guarda; o `reservation` deduplica pela chave)) e responde `200 {"mode":"queued","rpm":n,"status":"queued"|"pending","idempotencyKey":"...",
  "eventId":n,"expiresAt"?}` (repetição da chave devolve o estado atual, sem publicar de novo). **Mensagem não publicada** (broker bloqueado, sem rota, falha ao enviar; a entrada é desfeita) → `sync`. Respostas de
  negócio (`InternalApiExceptionHandler`): **422** chave de outro evento, **429** limite por usuário (`ADMISSION_MAX_WAITING_PER_USER`) e fila cheia; 400 e 503 como na #41.
- **`AdmissionClient`** (`admit` e novo `result`): 422/429 viram a `AdmissionRecusadaException(status, mensagem)`, **fora do disjuntor** (serviço vivo: zeram a contagem de falhas, sem fail-open); o 400 segue como na #41
  (sync, sem contar). `result(userId, idempotencyKey)` chama `GET /internal/admissions/result` (URL pelo `RestClient`, parâmetros codificados), devolve vazio no 404, lança `AdmissionUnavailableException` em
  rede/timeout/5xx/401 e **nunca passa pelo disjuntor** do `admit` (a consulta que falha não desliga a contagem, e o circuito aberto não impede a consulta).
- **Gateway** (`EventWalletGateway.addLink`): o `admission` respondendo `queued` → `ReservaEnfileiradaException` (o `BffEventWalletController` faz o **`202 Accepted`**, header `Idempotency-Key` (a recebida ou a gerada),
  `Retry-After: 1` (exposto no CORS) e o corpo `{"status":"queued","eventId":n,"idempotencyKey":"..."}`; o `reservation` não é chamado); **429/422 do `admission` são repassados com o texto dele**. **Chave no `reservation`:**
  com o `admission` respondendo `sync` ela é a **do cliente** (nula se não mandou), exatamente como na #41; **só no fail-open do braço `cas`** (a chamada ao `admission` falhou: rpm −1) vai a **chave efetiva** (a do cliente
  ou a gerada), porque o `admission` pode ter publicado antes de o gateway desistir e o `reservation` deduplica pela chave (nunca duas vagas). O `naive` nunca enfileira e segue com a chave do cliente.
- **`GET /bff/event-wallets/admission?idempotencyKey=`** (autenticado, deny-by-default): o `userId` é a claim `uid` do token (nunca um parâmetro); **200** `{"status":"queued"|"pending"|"rejected"|"timed_out","eventId":n,
  "idempotencyKey":"...","expiresAt"?,"reason"?}`, **400** sem chave, **401** sem token, **404 igual** para chave inexistente e para a de outro usuário (a chave é escopada pelo usuário no `admission`: a resposta não revela
  existência), **503** genérico com o `admission` fora (`AdmissionIndisponivelHandler`; log só da classe). `timed_out` ≠ `expired` do `walletevent`. Fora do disjuntor.
- **Envs novas** (serviço `admission`, repassadas pelo compose com defaults): `ADMISSION_X_RPM`, `ADMISSION_RESERVATION_REPLICAS`, `ADMISSION_QUEUE_ON`, `ADMISSION_SYNC_BELOW`. Para o harness da Rodada 4: o modo fila
  liga acima de 80% de X (44,8k RPM por evento com os defaults); com X baixo no ambiente de teste o gatilho dispara com pouca carga.
- **Testes:** `ModoDoEventoTest` (Redis real, relógio manual: bucket = janela = 1 s no ms 999 torna RPM = 60 × tentativas e as contas exatas; entra com 14 tentativas a X=1000 e no limiar exato de 0,80 a X=1200;
  réplicas; histerese: espera segura a fila, 0,72 mantém, &lt; 0,70 com espera vazia volta; espera vencida pelo deadline; por evento; `contar` não muda o modo; configuração inválida), `AdmissionGatilhoTest` (HTTP real, Redis,
  RabbitMQ e worker REAIS, reservation falso: contrato `sync` idêntico abaixo de 80% de X (100 RPM), a tentativa 79 ou 80 vira `queued` e o worker leva todas ao `pending`; `naive` nunca enfileira),
  `AdmissionGatilhoLimitesTest` (sem worker: repetição sem publicar de novo, 422, 429 por usuário, 429 de fila cheia, broker bloqueado = `sync` sem `queued` fantasma), `AdmissionClientTest` (422/429 tipados fora do
  disjuntor, `result`), `EventWalletGatewayAdmissionTest` (202 sem chamar o reservation, 429 tipado sem abrir o circuito, chave efetiva no fail-open do `cas`, estado), `HttpContractTest` (**aditivo**: 202 + headers + corpo,
  422/429 repassados, o GET 200/400/401/404/503), `FakeAdmissionServer` (`modoFila`, `falhar(status, mensagem)`, `estado`). **Overselling 0 contra o `reservation` REAL:** passo 4b do e2e e dry-run (abaixo).
- **e2e (passo 4b de `Projeto/e2e/run-e2e.sh`):** o override do e2e baixa o X do `admission` (`ADMISSION_X_RPM`, default 600; o validador exige 500..5000: a reserva isolada do passo 4 lê ≤ ~397 RPM e segue
  síncrona, 201). O passo cria N usuários por SQL (hash BCrypt copiado do usuário do passo 3, sem e-mail; `E2E_RAJADA_USUARIOS`, default **20**), um evento de capacidade N/4 (`E2E_RAJADA_CAPACIDADE`; o passo aborta com N &lt; 2 ou capacidade fora de 1..N−1; a `max_time_in_line` do `eventcap` da rajada sobe a 1 h no project descartável, para uma rajada grande não passar dos 120 s padrão e expirar vagas), loga
  todos e dispara a rajada concorrente dentro do container auxiliar (`Projeto/e2e/rajada-container.sh`); exige **pelo menos um 202**, todos os estados finais pela consulta (`pending`/`rejected`/`timed_out`),
  a fila `admission.requests` com profundidade **0** (`rabbitmqctl list_queues`, amostrada durante e depois da rajada e impressa) e **overselling 0** (reservas ativas ≤ capacidade, `eventcap.quant` = capacidade −
  ativas, pending = reservas ativas), imprimindo as contagens de 201/202/400/429 e dos estados. O mesmo passo com `E2E_RAJADA_USUARIOS` alto (ex.: 2000) é o **dry-run local acima do limiar** (não é medição).

## Serviço stock e saga stock + wallet — issue #47 (Fase 7: quinta extração)

Spec: `docs/superpowers/specs/2026-10-29-saga-stock-wallet-design.md` (D1–D4, janelas de falha, conta do Supavisor, migração). O `reservation` foi
dividido em **`stock`** (o `eventcap`/CAS, o ledger de holds e a API `/internal/eventcaps/**`) e **`reservation`** (o lado `wallet`: `walletevent`, a
`idempotency_key` que agora é também o log da saga, a projeção `event_availability`, expiração, retenção, relay e o **orquestrador da reserva**).
O `reservation` mantém nome, container, porta `:8082` e a API `/internal/reservations*` (o `admission`, o gateway, o `lb:8082` e o scaler não mudam).
`/bff/**` não mudou (`HttpContractTest`).

- **Módulos** (reactor de 11 para 13): `stock` (serviço, `:8086` só na rede, container `gerenciador-stock`, schema `stock`, README próprio) e `stock-client`
  (lib: `HoldRequest`/`HoldResponse`/`ReleaseRequest`, `EventCap`, `EventCapacityApi`, `StockConflictException`, `HoldLiberadoException` e o `StockClient`
  com pool; `ReservationClient` deixou de implementar `EventCapacityApi`). Nenhuma lib de contrato depende de outra; o `ModuleBoundaryArchTest` ganhou
  `stockclient`. `catalog` troca só o alvo da capacidade (`STOCK_SERVICE_URL`, `StockClient` com pool 100, captura `StockConflictException` no delete).
- **Ledger `stock.hold`** (`hold_id uuid PK, event_id, user_id, decremented, status held|released`): cada tentativa de reserva tem um `holdId` (UUID gerado pelo
  `reservation`), que é a chave de idempotência dos passos no `stock`. `POST /internal/holds` (uma transação: `eventcap`? → `INSERT hold ON CONFLICT DO NOTHING`
  → janela de compra → CAS como último comando; 201 / 200 repetição / 400 "Capacidade não configurada", "Janela de compra encerrada", "Evento lotado" / 409
  lápide) e `POST /internal/holds/{holdId}/release` (UM statement, upsert: libera o hold e devolve a vaga se `decremented`, ou grava a **lápide** se o hold
  ainda não existia; sempre 200, idempotente por chave). Braço `naive` e evento ilimitado também criam hold (`decremented = false`). A conversão ilimitado →
  limitado marca `decremented` nos holds `held` e `deleteIfNoReservations` olha `stock.hold` (qualquer status). `LEAST(quant + 1, capacity)` é só rede de
  segurança (WARN se cortar).
- **Saga da reserva** (`ReservationSaga`, orquestração síncrona, D1 = a): o estado é a linha de `reservation.idempotency_key` (colunas novas `hold_id`,
  `saga_status reserving|reserved|compensating|compensated`, `updated_at`, `resolved_at`, `resolved_by inline|reaper`). Passos: pré-checagem (`existsActive`) →
  **tx1** `INSERT` da chave (`reserving`) e COMMIT → `POST /internal/holds` **sem conexão aberta** → **tx2** (`reserving → reserved` por CAS em
  PK + `hold_id` + status, `reservePending(hold_id)`, `SlotReserved{holdId}`). Toda transição é `UPDATE` condicional por (PK, `hold_id`, status esperado).
  Respostas do `stock`: 400 apaga a linha `reserving` e devolve o texto (não consome a chave, não é compensação); 409, timeout, 5xx, conexão recusada ou 401 →
  **compensação inline** (`reserving → compensating`, `release(holdId)`, `→ compensated`). Chave repetida: `reserved` devolve o salvo; `compensated` reabre
  com `hold_id` novo; `reserving` espera relendo a cada 50 ms até `RESERVATION_SAGA_WAIT_MS` (8000, abaixo do timeout de 10 s dos chamadores; linha apagada
  volta ao `INSERT`); `compensating` dá 503 na hora. **Desfecho incerto da tx2** (exceção de banco, inclusive no `commit()`): NÃO compensa inline, responde 503 e deixa
  para o reaper; toda compensação que perde o CAS relê a linha e só libera se ela não estiver `reserved` com este `hold_id`. Falha do `stock` sai como 503 da
  API interna e **500 genérico no `/bff`** (contrato de hoje com o `reservation` fora); o worker do `admission` trata como transitória (backoff + requeue).
  Failpoint de teste `reservation.saga.failpoint=after-hold` (vazio em produção, sem variável no compose).
- **Reaper** (`SagaReaperService`, `@Scheduled` a cada `RESERVATION_SAGA_REAPER_SCAN_MS` = 5000, lote `RESERVATION_SAGA_REAPER_BATCH` = 100): seleciona
  `reserving` **e** `compensating` com `updated_at < now() - RESERVATION_SAGA_ORPHAN_MS` (30000) com `FOR UPDATE SKIP LOCKED` (N réplicas), passa as `reserving` para
  `compensating` (é isso que faz a tx2 atrasada do dono perder) e comita; fora da transação faz `release(holdId)` e fecha em `compensated` (`resolved_by = reaper`).
  Falha no release deixa `compensating` **sem renovar o `updated_at`** (é relida a cada tick). Nunca libera hold de saga `reserved`. Tempo para resolver uma órfã
  com o stock no ar: ≤ `ORPHAN_MS + SCAN_MS + latência do release` (~35 s); com o stock fora é ilimitado, mas seguro (vaga presa, sem overselling). A retenção das
  chaves (#130) só apaga `reserved`/`compensated`. O scheduler do `reservation` passou a 4 threads (relay, expiração, retenção e o reaper, o único com HTTP).
- **Devolução ao cancelar/expirar por evento** (D4 = a): `removeLink` e `ReservationExpiryService` não chamam mais `release`; só a guarda e o append, agora com
  `holdId` (`SlotReserved`, `ReservationCancelled`, `ReservationExpired` em `schema_version` 2). O **`StockReleaseConsumer`** do `stock` lê `reservation.wallet`
  em lote (group `stock`, `STOCK_RELEASE_CONSUMER_ENABLED`, `auto.offset.reset=earliest`), libera os holds por `UPDATE ... WHERE status = 'held'` e devolve a vaga
  com **um** `UPDATE eventcap` por evento; ignora tipos que não sejam Cancelled/Expired e os v1 sem `holdId`. O one-shot **`stock-seek`** (compose) move o group `stock`
  para o fim de `reservation.wallet` só se o group não existe (cria o tópico antes, idempotente: `rpk group seek` falha com `UNKNOWN_TOPIC_OR_PARTITION` num tópico que ainda não existe). Com o stock fora, cancelar e expirar seguem respondendo; a vaga volta quando ele volta (venda a
  menos, nunca a mais). A reconciliação do `eventcap` pelo `EventCreated` mudou para o `stock` (`CatalogReconciliationConsumer`, group `stock-catalog`,
  `STOCK_CATALOG_RECONCILIATION_ENABLED`); `RESERVATION_CATALOG_RECONCILIATION_ENABLED` deixou de existir.
- **Disponibilidade do `naive`**: `capacity` (lida do `stock` por `GET /internal/eventcaps/{id}`) − `ativos` (local); 404 do `stock` → 404, falha do `stock` →
  503 (nunca 404). O gateway continua com 2 chamadas; dentro do `reservation` cada uma ganha um salto.
- **Compose / escala**: `stock` fixo em 1 réplica (fora do scaler e do `haproxy.cfg`; as réplicas do `reservation` o chamam por `http://stock:8086`),
  **Hikari 250 literal** no base e no override (nunca `${SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE...}`: o kit de carga exporta essa variável para o
  `reservation`). Só o `reservation` depende do `stock` (`service_healthy`, que espera o `stock-seek`); o `catalog` não (a criação de evento segue com o `stock`
  fora e o `eventcap` vem pela reconciliação). Cliente `reservation → stock`: pool 400 (≥ Tomcat 300), conectar 2 s, pool 5 s, resposta 10 s, evict 20 s, sem retry
  (`STOCK_CLIENT_*`). **Conta do Supavisor (≤ 1500):** base 1000 (reservation) + 250 (stock) + 10 (backend) + 3 (notification) + 100 (catalog) + 100 (identity) =
  **1463**; override de autoescala 3×300 + 3×10 + 3×3 + 3×50 + 3×50 + 250 = **1489** (folga de 11; pré-condição da R5: Hikari de identity/catalog da R4 ≤ 51 por
  réplica, senão o Hikari do `stock` = 1500 − soma da R4). Nenhum Hikari da R4 muda.
- **Schema e migração**: `db/init-scripts/16-stock.sql` (schema `stock`, `eventcap` movido do `13-reservation.sql`, `hold`), na lista do `db/supabase-app-init.sql`;
  banco existente: `db/migrations/20261029-stock-schema.sql` (+ `verify-20261029-migration.{sh,sql}`) — **com backend, reservation, catalog e stock parados e depois do
  backup `pg_dump -h localhost -U admin --clean --if-exists -n reservation meu_banco`**; move `reservation.eventcap` para `stock`, cria `stock.hold`, as colunas da saga
  e faz o backfill dos holds (por evento limitado, exatamente `capacity − quant` holds `decremented`; aborta se `capacity − quant` > ativas). Rollback no cabeçalho
  (perde as sagas em voo: com tudo parado). O `run-tests.sh` aborta se `reservation.eventcap` ainda existe ou se faltam `stock.eventcap`/`stock.hold`, se há container
  `gerenciador-stock` (ou réplica com o label) rodando, e ao fim move os groups `stock` (`reservation.wallet`) e `stock-catalog` (`catalog.event`) para o fim.
- **Testes do `run-tests.sh` com banco isolado**: `TEST_DB_NAME` (default `meu_banco`) escolhe o banco dos testes (conferências por `psql` e `SPRING_DATASOURCE_URL` do
  container, com `meu_banco` trocado por ele) e `ENV_FILE` (default `../.env`) o arquivo de ambiente; foi o que deixou o `meu_banco` no schema da R4 enquanto a #47 era
  desenvolvida (`meu_banco_s5` criado com os init scripts da worktree). O módulo `reservation` trunca também o schema `stock` (`test.db.schemas=reservation,stock`).
- **Testes** (Postgres e Redpanda reais): módulo `stock` — `StockHoldTest` (S1–S4, S7, S8: idempotência por `holdId`, `release` idempotente e lápide, overselling 0
  com releases misturados, release × reservar em voo), `StockReleaseConsumerTest` (S5/S5b: lote com duplicatas/tipos misturados, `quant` agregado, rebalance, `Cancelled`
  v1 sem `holdId`, `earliest`), `EventCapUpdatePolicyTest` (S6: conversão ilimitado → limitado), `CatalogReconciliationTest`, `StockApiE2ETest`, `StockConfigTest`;
  módulo `reservation` — `ReservationSagaTest` (W1, W3, W5, W6, W8, W10–W12), `SagaReaperTest` (W2, W4, W7, W13), `SagaReaperConcorrenteTest` (W9), com o `stock` REAL
  atrás do `StockProxy` (JDK `HttpServer` que fica fora, atrasa ou comita e perde a resposta), `SagaDb` e o helper `InvariantesDaSaga` (o único código de teste que lê os
  dois schemas: `quant = capacity − holds debitados`, nenhum `walletevent` ativo sem hold `held`, **e no sentido inverso** todo hold `held` tem `walletevent` ativo, saga em
  curso ou devolução pendente, e ao fim nenhuma saga `reserving`/`compensating`). O reaper vem desligado por padrão nos testes (surefire); as classes que o usam o religam e
  usam `@DirtiesContext`. e2e: passos 4c (stock fora) e 4d (queda do `reservation` no meio de uma rajada), ver "Suíte e2e".
- **O que a R5 coleta** (spec, "O que a R5/S6 coleta"): compensações por minuto por `resolved_by`, órfãs, tempo até resolver, devolução pendente, órfã inversa (0),
  overselling + invariante, `saga.timing` (logger DEBUG, desligado por padrão).

## Suíte e2e da stack inteira — issue #37 (Fase 7)

`Projeto/e2e/run-e2e.sh` sobe **tudo** (gateway, identity, catalog, reservation, notification, frontend, `supabase-*`, redpanda) num project
compose TEMPORÁRIO (`gerenciador-e2e`), isolado da stack real, e prova pelo gateway: cadastro em duas fases (o código é lido do **e-mail no
captador**, não do banco) → promover a host por SQL → login → criar evento → reservar (cas) → confirmar → e-mail; depois espera os outbox
esvaziarem e o lag dos groups `reservation`/`reservation-catalog`/`notification` chegar a 0 e roda o **replay** dos streams `catalog.event` e
`reservation.wallet` (`CatalogReplayE2eTest`, `ReservationReplayE2eTest`: `EventReplay.rebuild` + `divergentTables`, sombra == projeção viva;
exigem `E2E_REPLAY=1`, ficam PULADAS no `run-tests.sh`, não truncam nada e reutilizam a projeção do `ReservationReplayTest`). Verde = saída 0.
- **Saga stock + wallet (#47), passos 4c e 4d.** O `stock` e o `stock-seek` entram como `*isolado`; o override e2e dá ao `reservation` `RESERVATION_SAGA_ORPHAN_MS=5000` e `RESERVATION_SAGA_REAPER_SCAN_MS=1000`
  (o `run-e2e.sh` exporta `SAGA_ORPHAN_MS`/`SAGA_SCAN_MS`; o validador exige ORPHAN_MS entre 1000 e 10000, `STOCK_SERVICE_URL` no reservation e o Hikari 250 literal do stock) e as consultas de capacidade leem `stock.eventcap`.
  **(a) stock fora:** `docker stop` do `stock` do project → `POST /bff/event-wallets` com `Idempotency-Key` dá **500** genérico; no banco a saga fica `compensating`, `quant` intacto, nenhum `walletevent`;
  `start` + healthy → em até `ORPHAN_MS + SCAN_MS` a saga fica `compensated` (`resolved_by = reaper`), o hold `released`, invariantes verdes, e a MESMA chave reserva (201); cancelar a reserva devolve a vaga
  pelo consumer do `stock` (`quant` volta a 5). **(b) queda do `reservation` no meio de uma rajada** (20 usuários, capacidade 8; como a rajada acaba em ~100 ms, o `stock` fica em `docker pause` até a queda: as 20 sagas já estão `reserving` e penduradas no hold; `docker stop -t 0` do `reservation`, `unpause` do `stock` (que processa os holds com o chamador morto: 8 órfãs `held`) e `start`): depois da janela do reaper
  as invariantes valem (`quant = capacity − holds debitados`, sem wallet sem hold, sem hold preso, sem saga sobrando) e overselling 0; a contagem de 201 não é exigida. Os groups conferidos no passo 5 agora são `reservation`, `stock`, `stock-catalog`, `notification`.
- **`rabbitmq` (#42)** também entra como `*isolado`; o `run-e2e.sh` exporta `RABBITMQ_USER` e `RABBITMQ_PASSWORD` **efêmeros** (`openssl rand -hex`) e o validador de isolamento confere que o broker existe, que o `admission` aponta para ele
  com essas credenciais e que o `backend` NÃO as recebe. O passo 4b (#43) exercita a fila com uma rajada (abaixo).
- **`redis` e `admission` (#41)** entram no project como os demais serviços (`*isolado`: sem `container_name`, sem porta no host); o `run-e2e.sh` **exporta uma `REDIS_PASSWORD` efêmera** (`openssl rand -hex 16`, só
  para o project temporário: o compose exige a variável e o e2e nunca usa a do `Projeto/.env`), o validador de isolamento confere que os dois existem, que o `admission` aponta para o `redis` do project com senha e
  que o `backend` NÃO recebe a senha, e depois da reserva o script exige que o contador de comandos do Redis do project mostre ao menos um `EVAL`/`EVALSHA` (o gateway → `admission` → Redis rodou na stack real).
- **Isolamento** (`Projeto/e2e/docker-compose.e2e.yml`, sem tocar nos defaults do compose normal): `container_name: !reset null` e `ports: !reset []`
  em TODOS os serviços (inclusive os dos includes do Supabase) e a rede `default` sem o nome fixo `gerenciador-net` (vira `<project>_default`;
  na rede real `db`/`redpanda`/`supabase-pooler` resolveriam para os containers REAIS e o project escreveria no `meu_banco` de verdade).
  O script confere isso com `config --format json` (filtrado: só nomes, nunca valores, porque o `config` resolve o `.env`) ANTES do `up` e
  aborta se houver `container_name`, porta publicada, rede/volume sem o prefixo do project ou SMTP fora do captador. O project tem de se
  chamar `gerenciador-e2e*` (o real, `gerenciador-eventos`, é recusado) e o `down -v` do fim (também com `trap`, salvo `MANTER=1`) repete a guarda.
- **E-mail**: o override aponta o `notification` para o Mailpit (`axllent/mailpit`, versão fixada; `MAIL_HOST=mailpit MAIL_PORT=1025
  MAIL_SMTP_AUTH=false MAIL_STARTTLS=false`, sem senha, remetente `e2e-notification@example.com` em `MAIL_USERNAME`: o captador recusa remetente vazio); o script aborta se o `MAIL_HOST` efetivo do container não for `mailpit` e exige
  0 mensagens no captador depois do 1º `up`, **com prova do seek**: antes do `up` completo sobe só o redpanda e produz em `identity.notification` um
  `VerificationCodeRequested` válido (pedido de e-mail "pendente" de um group novo); depois do `up` exige o group `notification` em
  offset 1 / log-end 1 / lag 0 e 0 e-mails no captador (sem o seek o group novo, em `earliest`, o releria e mandaria o e-mail). O passo 5b roda o
  one-shot de novo com o group já existente e exige "offsets mantidos". O Studio do project usa `tmpfs` em vez do bind gravável
  `supabase/volumes/snippets` da stack real, e o validador rejeita qualquer bind mount gravável. Sem porta no host: as chamadas HTTP (gateway e API do captador) saem de um container auxiliar na rede do project.
- **Seek one-shot no 1º `up`** (compose normal, serviço `notification-seek`, imagem do redpanda): SÓ se o group `notification` ainda não existe
  (`rpk group list`), faz `rpk group seek notification --to end --topics identity.notification --allow-new-topics`; o `notification` depende dele
  (`service_completed_successfully`). Group novo não relê o log (evento de teste de uma stack apagada não vira e-mail); group existente (e-mail
  legítimo pendente com o serviço parado) fica intocado. Tópico inexistente não falha.
- **Healthchecks** (#37): `backend` (GET cru em `/actuator/health` por `bash /dev/tcp`, espera `200`), `notification` (sem HTTP: há conexão TCP ESTABELECIDA ao broker :9092 em `/proc/net/tcp`/`tcp6`, consumer ligado; o lag do group segue sendo o sinal de que ele consome) e
  `frontend` (`wget` do busybox do nginx); o `frontend` agora espera o `backend` `service_healthy`. `docker compose up -d --build --wait` termina com
  todo serviço de longa duração `healthy` (o `notification-seek` termina com 0).
- Pré-requisitos: `Projeto/.env` e `Projeto/supabase/.env`, python, e RAM para ~15 containers a mais (a stack real pode ficar no ar; se faltar,
  `docker compose -p gerenciador-eventos stop`, nunca `down`). O 1º build (inclui o Flutter do frontend) leva vários minutos.

### Imagens enxutas (Slim) — issue #177

Opcional, sem mexer nos Dockerfiles: `Projeto/slim/gerar-imagens-slim.sh` gera as imagens `gerenciador-eventos-<serviço>.slim` (probe nos
endpoints `/internal/**`, `/bff/**`, actuator, JWKS e no caminho Kafka) e `Projeto/docker-compose.slim.yml` as ativa por override
(`build: !reset null`). `E2E_SLIM=1 Projeto/e2e/run-e2e.sh` roda a suíte e2e com elas e confere que cada serviço usa o ID da imagem `*.slim`.
Tabela antes/depois, includes (com motivo) e perfis Seccomp/AppArmor (opcionais, não aplicados por padrão) em `Projeto/slim/README.md`. Desde a #47 inclui o `stock` (probe de `/internal/holds`,
`/internal/eventcaps/**` e do `StockReleaseConsumer`, com um `ReservationCancelled` produzido antes do start).

## Cadastro em duas fases + e-mail

1. `POST /bff/users/request-verification` (gateway -> identity) grava em `identity.pending_verifications` (hash da senha +
   código de 6 dígitos, expira em 5 min — ver `application.properties`).
2. `POST /bff/users/verify-email` confere o código (com contador de tentativas) e só então insere em `identity.users`, devolvendo `{user, token}` (o token já vem assinado pelo identity).
3. `identity/EmailVerificationService` (no serviço identity) grava o código e, na mesma transação, appenda o evento `VerificationCodeRequested`
   (`IdentityNotifications`); o **serviço `notification`** (processo à parte, #32) consome o tópico e manda o código via SMTP
   Gmail (`spring-boot-starter-mail` só nele), templates em `notification/EmailTemplates`. O monólito não envia e-mail. O
   `POST /bff/users/request-verification` responde igual; o e-mail chega de forma assíncrona (com o serviço fora, só depois que
   ele voltar). O MFA do reset de senha segue o mesmo caminho (`PasswordResetMfaRequested`).
4. reCAPTCHA v3: `POST /bff/users/verify-recaptcha` (em `gateway/BffUserController`) valida o
   token com a Google usando `RECAPTCHA_SECRET_KEY`, mas quem fala com a Google é o serviço identity (`POST /internal/recaptcha/verify`); a chave secreta só existe nele.

## Config

- `application.properties` lê tudo de env var com default de dev:
  `SPRING_DATASOURCE_*` (inclui `SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE`, default 10 no gateway, e
  `SPRING_DATASOURCE_HIKARI_MINIMUM_IDLE`), `IDENTITY_SERVICE_URL`, `IDENTITY_CLIENT_*` (cliente HTTP do gateway; ver "Serviço identity"),
  `JWT_ISSUER`, `JWT_JWKS_CACHE_TTL_MS`, `JWT_JWKS_MIN_REFRESH_INTERVAL_MS`, `JWT_JWKS_OUTAGE_TOLERANCE_MS` (validação do JWT no gateway; `JWT_SECRET` e `JWT_EXPIRATION_SECONDS` deixaram de ser lidos aqui na #36),
  (`RECAPTCHA_SECRET_KEY` saiu do monólito na #36: é do serviço `identity`; `MAIL_*` saiu na #32: é do serviço `notification`), `SERVER_TOMCAT_THREADS_MAX` (default `300`),
  `RESERVATION_READPATH` (default `cas`; `naive` = braço de controle do experimento; lido pelo **gateway**, no monólito),
  `RESERVATION_SERVICE_URL` e `RESERVATION_CLIENT_*` (cliente HTTP do gateway, ver "Serviço reservation"),
  **do serviço `reservation`** (mesmos nomes de antes, valores no `reservation/application.properties`): `SPRING_DATASOURCE_*` (Hikari default 1000),
  `SERVER_TOMCAT_THREADS_MAX` (300), `SERVER_TOMCAT_MAX_KEEP_ALIVE_REQUESTS` (-1), `SERVER_TOMCAT_KEEP_ALIVE_TIMEOUT` (60s),
  `EVENTS_*` (relay/consumer ligados no compose; `EVENTS_CONSUMER_GROUP` default `reservation`), (`RESERVATION_CATALOG_RECONCILIATION_*` saiu na #47: a reconciliação é do `stock`), `RESERVATION_SAGA_WAIT_MS` (8000), `RESERVATION_SAGA_ORPHAN_MS` (30000), `RESERVATION_SAGA_REAPER_ENABLED`/`_SCAN_MS` (5000)/`_BATCH` (100) e `STOCK_SERVICE_URL`/`STOCK_CLIENT_*` (#47),
  `RESERVATION_EXPIRY_SCAN_MS` (`reservation.expiry.scan.ms`, 30000), `IDEMPOTENCY_RETENTION_HOURS` (default `24`; prazo de retenção das chaves
  de idempotência) e `IDEMPOTENCY_RETENTION_SCAN_MS` (default `600000` = 10 min; intervalo do job de limpeza, issue #130),
  `NOTIFICATION_EVENTS_RETENTION_SCAN_MS` (default `30000`; intervalo do job que apaga do `event_store` os pedidos de e-mail
  vencidos há mais de 30 s, #32),
  `SPRING_TASK_SCHEDULING_POOL_SIZE` (default `3`, `4` no `reservation` desde a #47 por causa do reaper; threads do scheduler dos `@Scheduled`. O default do Boot é
  **1**, compartilhada pelo `OutboxRelay`, `ReservationExpiryService` e
  `IdempotencyKeyRetentionService` (no reservation) ou pelo relay e o `NotificationEventRetentionService` (no monólito): um purge em massa seguraria o relay e falsearia o lag medido do braço `naive`).
  Valores reais vêm de `Projeto/.env` — não commitar, não imprimir.
- Backbone de eventos (issue #27; ver "Event store e backbone de eventos"), todos com default de dev:
  `SPRING_KAFKA_BOOTSTRAP_SERVERS` (default `localhost:9092`; `redpanda:9092` no compose e no `run-tests.sh`),
  `EVENTS_RELAY_ENABLED` (default `false`), `EVENTS_RELAY_INTERVAL_MS` (`50`), `EVENTS_RELAY_BATCH_SIZE` (`200`),
  `EVENTS_CONSUMER_ENABLED` (default `false`), `EVENTS_CONSUMER_GROUP` (`gerenciador-eventos` no monólito, que já não tem consumer; `reservation` no serviço),
  `EVENTS_CONSUMER_RETRY_INTERVAL_MS` (`1000`; base do backoff transitório e intervalo do retry do buraco),
  `EVENTS_CONSUMER_RETRY_MAX_ATTEMPTS` (`5`; só para o buraco irrecuperável), `EVENTS_CONSUMER_RETRY_ERROR_AFTER_ATTEMPTS` (`10`; a
  partir daí cada tentativa do retry transitório ilimitado loga em ERROR), `EVENTS_CONSUMER_BATCH_SIZE` (`500`, #146; tamanho máximo
  do lote do listener da projeção de disponibilidade, o `max.poll.records` dele; o compose o repassa), `EVENTS_SNAPSHOT_EVERY` (`100`). Sem segredo novo. As flags
  `EVENTS_RELAY_ENABLED`/`EVENTS_CONSUMER_ENABLED` têm default `false` (os testes ligam por `@SpringBootTest(properties=...)`); o
  `docker-compose.yml` passou `EVENTS_RELAY_ENABLED=true` ao monólito desde a #28 (o `catalog` appendava eventos; desde a #35 o relay do monólito
  só publicava o `identity.notification` e o `catalog` tem o dele; desde a #36 o monólito volta a `false` e o `identity` liga o dele) e, desde a #33, ao `reservation` (relay do
  outbox dele) junto com `EVENTS_CONSUMER_ENABLED=true` (projeção assíncrona de disponibilidade, #29); o monólito passou a `EVENTS_CONSUMER_ENABLED=false`.
  **Aviso:** com o `gerenciador-backend`, o `gerenciador-reservation`, o `gerenciador-catalog` ou o `gerenciador-identity` no ar, o relay deles drena o `event_outbox` do
  mesmo banco que o `run-tests.sh` usa e o consumer move `ativos`: o `run-tests.sh` **aborta** se algum dos containers estiver
  rodando (`docker stop gerenciador-backend gerenciador-reservation gerenciador-catalog gerenciador-identity gerenciador-notification gerenciador-admission` antes; o `admission` por usar o mesmo Redis dos testes).
- Serviço stock (#47), variáveis do SERVIÇO (`stock/application.properties`): `SPRING_DATASOURCE_*` (Hikari 250, literal no compose), `SERVER_TOMCAT_THREADS_MAX` (300), `INTERNAL_API_TOKEN` (sem default),
  `EVENTS_CONSUMER_ENABLED`, `STOCK_RELEASE_CONSUMER_ENABLED`/`_GROUP` (`stock`)/`_TOPIC` (`reservation.wallet`), `STOCK_CATALOG_RECONCILIATION_ENABLED`/`_GROUP` (`stock-catalog`). Do `reservation` e do `catalog`:
  `STOCK_SERVICE_URL` (`http://stock:8086`) e `STOCK_CLIENT_MAX_CONNECTIONS` (400 no reservation, 100 no catalog), `STOCK_CLIENT_{CONNECT,CONNECTION_REQUEST,RESPONSE}_TIMEOUT_MS`, `STOCK_CLIENT_EVICT_IDLE_MS`. Nenhuma variável nova no `.env`.
- Serviço catalog e seed (#35): `CATALOG_SERVICE_URL` e `CATALOG_CLIENT_MAX_CONNECTIONS` (cliente HTTP do gateway, ver "Serviço catalog"),
  `SEED_ENABLED` (`seed.enabled`, default `false`: `POST /bff/seed` responde 404; só o override de carga liga).
- Serviço identity (#36), variáveis do SERVIÇO (`identity/application.properties`): `SPRING_DATASOURCE_*` (Hikari 100), `SERVER_TOMCAT_THREADS_MAX` (300), `INTERNAL_API_TOKEN` (sem default),
  `JWT_SIGNING_KEY_PATH` (default `/var/lib/identity/jwt-signing-key.json`), `JWT_EXPIRATION_SECONDS` (36000), `RECAPTCHA_SECRET_KEY` e `RECAPTCHA_VERIFY_URL`, `EVENTS_RELAY_ENABLED` (`true` no compose),
  `NOTIFICATION_EVENTS_RETENTION_SCAN_MS`. Nenhuma variável nova no `.env`; `JWT_SECRET` não é lido por ninguém.
- Serviço admission e Redis (#41), variáveis do SERVIÇO (`admission/application.properties`): `INTERNAL_API_TOKEN` (sem default), `REDIS_HOST` (default `localhost`; `redis` no compose e no `run-tests.sh`), `REDIS_PORT`
  (`6379`), `REDIS_PASSWORD` (**sem default**; vem do `Projeto/.env`, ver o aviso em "Serviço admission"), `ADMISSION_REDIS_TIMEOUT_MS` (`200`; timeout de comando e de conexão), `ADMISSION_BUCKET_MS` (`50`),
  `ADMISSION_WINDOW_MS` (`200`; múltiplo do bucket), `SERVER_TOMCAT_THREADS_MAX` (`300`), `SERVER_TOMCAT_MAX_KEEP_ALIVE_REQUESTS` (`-1`), `SERVER_TOMCAT_KEEP_ALIVE_TIMEOUT` (`60s`). Do GATEWAY (monólito):
  `ADMISSION_SERVICE_URL` (default `http://localhost:8085`), `ADMISSION_CLIENT_MAX_CONNECTIONS` (`400`), `ADMISSION_CLIENT_CONNECT_TIMEOUT_MS` (`200`), `ADMISSION_CLIENT_CONNECTION_REQUEST_TIMEOUT_MS` (`200`),
  `ADMISSION_CLIENT_RESPONSE_TIMEOUT_MS` (`500`), `ADMISSION_CLIENT_EVICT_IDLE_MS` (`20000`), `ADMISSION_CLIENT_OPEN_MS` (`5000`; tempo do circuito aberto). Variável nova no `.env` na #41: `REDIS_PASSWORD`; na #42: `RABBITMQ_USER` e `RABBITMQ_PASSWORD` (as demais variáveis da fila estão em "Fila de admissão (RabbitMQ) e worker pool — issue #42").
- Suíte e2e (#37): `MAIL_HOST`/`MAIL_PORT`/`MAIL_SMTP_AUTH`/`MAIL_STARTTLS` do `notification` (defaults do Gmail; ver "Serviço notification") e `E2E_REPLAY`
  (`1` liga as classes `*ReplayE2eTest`; sem ela ficam puladas). Variáveis do script: `E2E_PROJECT`, `MANTER`, `ESPERA_UP`.
- Actuator (issue #92): `spring-boot-starter-actuator` com **só** `health` exposto
  (`management.endpoints.web.exposure.include=health`); `GET /actuator/health` público devolve
  `{"status":"UP"}` (depende do Postgres). O health do mail deixou de existir com o `spring-boot-starter-mail` (#32).
  Cobertura em `HttpContractTest`.
- `spring.jpa.show-sql=true` e log de SQL em DEBUG: saída verbosa é esperada em dev.

## Ao mexer aqui

- Novo endpoint → entra em `gateway/*` (superfície HTTP única, ver "Rotas e segurança"), no
  controller do agregado correspondente. Desde o PR #79 (issue #78) o default dentro de `/bff/**` é
  **autenticado**: endpoint novo já nasce protegido; só adicione em `SecurityConfig` se ele
  precisar ser público (raro — normalmente já resolvido pelo padrão `GET /bff/events/**`).
- Mudou a API interna do `reservation` (`/internal/**`) → atualize o `ReservationClient` (lib `reservation-client`), o
  `ReservationApiE2ETest` (cliente real × serviço real) **e** o `FakeReservationServer` dos testes do monólito.
- Mudou path, método ou forma de request/response de um endpoint consumido pelo Flutter →
  atualize `src/test/.../HttpContractTest` (trava a superfície pro harness de carga da
  issue #11) e o `frontend/CLAUDE.md`.
- Nova query → JDBC parametrizado (`?`), nunca concatenar string em SQL.
- Rode `./run-tests.sh` (com `db` no ar) antes de dar por pronto.
- Mudou a API interna do `identity` (`/internal/**`) → atualize o `IdentityClient` (lib `identity-client`, com o `identity-client/README.md`), o
  `IdentityApiE2ETest` (cliente real × serviço real) **e** o `FakeIdentityServer` dos testes do monólito. Mudou claim do JWT (`uid`, `isHost`...) → atualize o `JwtIssuer`,
  o `gateway/security` e o `FakeIdentityServer` (que assina com uma chave de teste).
