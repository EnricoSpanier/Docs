# Back-end (Spring Boot, Maven multi-módulo)

Java 21, Spring Boot 3.5.7, Maven (sem wrapper `mvnw`). **JDBC puro** (sem JPA: o schema mora em SQL, ver [`db/README.md`](db/README.md)).
O `pom.xml` desta pasta é o agregador: cada serviço é um módulo com o próprio jar e Dockerfile, e o que é comum a mais de um serviço
é uma lib. Visão geral do sistema: [`../../README.md`](../../README.md). Regras e detalhes técnicos (pools, event sourcing, saga,
autoescala, quality gates): [`CLAUDE.md`](CLAUDE.md).

## Módulos

| Módulo | Tipo | O que é |
|---|---|---|
| [`shared`](https://github.com/endydragonn/GerenciadorEventos/blob/main/Projeto/Backend/shared) | lib | `DatabaseConnection` (Hikari) e `shared.events`: event store, outbox, relay para o Redpanda, consumer idempotente, replay e snapshots |
| [`monolito`](monolito/README.md) | serviço | o gateway/BFF: só os controllers `/bff/**` e a validação do JWT (container `gerenciador-backend`, :8081) |
| [`identity`](identity/README.md) | serviço | usuários, carteira, cadastro, MFA, reCAPTCHA e emissão do JWT RS256 (:8084) |
| [`catalog`](catalog/README.md) | serviço | eventos em CQRS + event sourcing (:8083) |
| [`reservation`](reservation/README.md) | serviço | lado wallet da reserva e orquestrador da saga (:8082) |
| [`stock`](stock/README.md) | serviço | `eventcap` (CAS) e ledger de holds (:8086) |
| [`notification`](notification/README.md) | serviço | consumer de `identity.notification` que envia e-mail por SMTP (sem HTTP) |
| [`admission`](admission/README.md) | serviço | contador de RPM (Redis), fila de admissão (RabbitMQ) e worker pool (:8085, sem banco) |
| [`reservation-client`](reservation-client/README.md), [`stock-client`](stock-client/README.md), [`catalog-client`](catalog-client/README.md), [`identity-client`](identity-client/README.md), [`admission-client`](admission-client/README.md) | libs | contrato HTTP de cada serviço (DTOs, interfaces e o cliente com pool); nenhuma lib de contrato depende de outra |
| [`db`](db/README.md) | fora do Maven | init-scripts, migrações e seed |

Um serviço só depende de `shared` e das libs de contrato dos serviços que chama: a fronteira entre serviços é o HTTP, e nenhum serviço
lê tabela de outro. As portas "de rede" não são publicadas no host. A conta de pools (Hikari de cada serviço contra o Supavisor) e as
regras de fronteira (ArchUnit) ficam no [`CLAUDE.md`](CLAUDE.md), seções "Persistência" e "Módulos".

## Build

Um Dockerfile por serviço (`monolito/Dockerfile`, `identity/Dockerfile`, `catalog/Dockerfile`, `reservation/Dockerfile`, `stock/Dockerfile`,
`notification/Dockerfile`, `admission/Dockerfile`), com **contexto em `Projeto/Backend/`**: multi-stage, compila com Maven 3.9 / JDK 21
(`-pl <serviço> -am`) e roda numa imagem JRE. Pelo compose, da raiz do repositório:

```bash
docker compose -f Projeto/docker-compose.yml build identity          # um serviço
docker compose -f Projeto/docker-compose.yml up -d --build backend   # o gateway (sobe junto o que ele exige)
```

Com Maven e JDK 21 no host (opcional), tudo a partir desta pasta: `mvn -pl monolito -am test` (módulo e libs de que depende),
`mvn -Dtest=ClasseTest -Dsurefire.failIfNoSpecifiedTests=false test` (uma classe). `-pl X -am` compila `shared` junto; sem `-am` o
Maven procura `shared` no repositório local e falha. Os testes de integração precisam da infra descrita abaixo; o jeito suportado de
rodá-los é o `run-tests.sh`. O Checkstyle (`checkstyle.xml`) roda no `validate`, então um `mvn test` ou o `run-tests.sh` quebram se uma regra travar.

## Testes: `run-tests.sh`

`Projeto/Backend/run-tests.sh` roda o **reactor inteiro** (`mvn -fae clean test`) num container Maven efêmero na rede `gerenciador-net`,
contra Postgres, Redpanda, Redis e RabbitMQ **reais** (sem mock de banco).

1. Suba só a infra: `docker compose -f Projeto/docker-compose.yml up -d db redpanda redis rabbitmq`.
2. **Pare todos os serviços** (compartilhariam banco, broker e Redis com os testes, e o `notification` mandaria e-mail de verdade):

   ```bash
   docker stop gerenciador-backend gerenciador-notification gerenciador-reservation gerenciador-stock gerenciador-catalog gerenciador-identity gerenciador-admission
   ```

3. `Projeto/Backend/run-tests.sh`. O script aborta com mensagem clara se faltar um dos containers de infra, se algum serviço (ou réplica
   da autoescala) estiver rodando, ou se o banco ainda não tiver as migrações de schema aplicadas (ver [`db/README.md`](db/README.md)).

Variáveis: `TEST_DB_NAME` (default `meu_banco`) roda os testes (e o `TRUNCATE`) num outro banco do mesmo container, deixando o `meu_banco`
intocado. **O script não cria esse banco**: ele precisa existir antes, criado com os init-scripts atuais (ver [`db/README.md`](db/README.md)), e o
script só o usa (sem ele, as conferências de schema por `psql` falham e o script aborta). `ENV_FILE` (default `Projeto/.env`) aponta para outro arquivo de ambiente. `REDIS_PASSWORD`, `RABBITMQ_USER` e `RABBITMQ_PASSWORD`
vêm do `Projeto/.env` ou, se exportadas na shell, as da shell valem por cima.

Efeitos colaterais da rodada (o resumo; o detalhe está no [`CLAUDE.md`](CLAUDE.md), seção "Testes"):

- apaga a chave de assinatura do JWT do volume `identity-keys` no início e ao fim: todo token antigo vira 401. Os serviços ficaram
  parados (`docker stop`), então **suba a stack de novo** (`docker compose -f Projeto/docker-compose.yml up -d --wait`) e **relogue**; o gateway sobe com o
  JWKS em cache vazio (ele guarda a chave por até 24 h);
- dá `FLUSHDB` no Redis e `TRUNCATE ... RESTART IDENTITY` nas tabelas dos schemas do app (**apaga os dados do banco de teste**; no `meu_banco`, os da stack real);
- ao fim move os consumer groups `notification`, `reservation`, `reservation-catalog`, `stock` e `stock-catalog` para o fim dos tópicos (eventos de teste nunca
  viram e-mail nem `eventcap`; um e-mail real pendente antes da rodada é pulado);
- os relatórios Surefire de todos os módulos são copiados para `Backend/target/surefire-reports`.

Suíte da stack inteira (cadastro, evento, reserva, saga, fila, replay): [`../e2e/run-e2e.sh`](https://github.com/endydragonn/GerenciadorEventos/blob/main/Projeto/e2e/run-e2e.sh), num project temporário
isolado da stack real.

## Outros arquivos

- [`CORS_CONFIG.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/Projeto/Backend/CORS_CONFIG.md): configuração de CORS do gateway (`CORS_ALLOWED_ORIGINS`).
- `populate-data.ps1`: popula dados por `POST /bff/seed` (só existe com `SEED_ENABLED=true`, ver o override de carga em [`../README.md`](../README.md)).
- [`DOCKER-COMANDOS.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/Projeto/Backend/DOCKER-COMANDOS.md): guia antigo de comandos Docker, de quando o compose tinha só banco e backend; está desatualizado, prefira o [`../README.md`](../README.md).
- `export-tests.sh`: gera um relatório de testes em arquivo texto (não versionar o relatório).
