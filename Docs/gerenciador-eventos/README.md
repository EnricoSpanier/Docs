# Gerenciador de Eventos

### [Link Video Final de 2025](https://www.youtube.com/watch?v=49sNSOQzUIc)

Sistema web de gerenciamento de eventos (palestras, shows, workshops): cadastro com verificação por e-mail, login, criação e
edição de eventos por hosts, e **reserva de vagas em duas fases** (reserva com prazo, depois confirmação) sem overselling
mesmo sob concorrência alta. O projeto é o objeto de um TCC: o back-end nasceu como um monólito Spring Boot e foi decomposto em
serviços, com CQRS + event sourcing no catálogo e na reserva, para medir o efeito de cada decisão de arquitetura sob carga.

O front-end é um app Flutter Web; o back-end é Java 21 / Spring Boot 3.5 com **JDBC puro** (sem JPA: o schema mora em SQL) sobre
PostgreSQL 17 (`supabase/postgres`, self-hosted), com Redpanda (backbone de eventos), Redis e RabbitMQ (admissão de reservas).

## Arquitetura

```
 navegador ──> frontend (nginx :8088) ──/bff/**──> backend / gateway (:8081)
                                                      │  valida o JWT RS256 (JWKS do identity)
                 ┌────────────┬───────────┬───────────┼────────────┐
                 ▼            ▼           ▼           ▼            ▼
            identity     catalog     reservation  admission   (HTTP interno,
             :8084        :8083        :8082       :8085       X-Internal-Token)

  reservation ──HTTP (saga)──> stock :8086 <──HTTP (capacidade)── catalog
  admission (worker pool da fila) ──HTTP──> reservation
  identity ──evento identity.notification──> Redpanda ──> notification (e-mail SMTP, sem HTTP)
  reservation ──evento reservation.wallet──> Redpanda ──> stock (devolução de vaga)
  catalog ──evento catalog.event──> Redpanda ──> stock (reconciliação do eventcap)
  admission usa Redis (contador de RPM) e RabbitMQ (fila); os demais serviços usam o Postgres
  pelo Supavisor (supabase-pooler), cada um no seu schema.
```

| Serviço (módulo Maven) | Responsabilidade | Porta | Schema | Container |
|---|---|---|---|---|
| `monolito` (gateway/BFF) | única superfície HTTP `/bff/**`, valida o JWT, compõe as respostas | 8081 (host) | nenhum (só health) | `gerenciador-backend` |
| `identity` | usuários, carteira, cadastro em duas fases, MFA, reCAPTCHA, emissão do JWT RS256 e JWKS | 8084 (rede) | `identity` | `gerenciador-identity` |
| `catalog` | eventos e apresentadores (CQRS + event sourcing, stream `catalog.event`) | 8083 (rede) | `catalog` | `gerenciador-catalog` |
| `reservation` | lado wallet da reserva (event sourcing, stream `reservation.wallet`) e orquestrador da saga | 8082 (rede) | `reservation` | `gerenciador-reservation` |
| `stock` | capacidade do evento (`eventcap`, CAS) e ledger de holds da saga | 8086 (rede) | `stock` | `gerenciador-stock` |
| `notification` | consome `identity.notification` e envia o e-mail por SMTP | sem HTTP | `notification` | `gerenciador-notification` |
| `admission` | contador de RPM por evento (Redis), fila de admissão (RabbitMQ) e worker pool | 8085 (rede) | sem banco | `gerenciador-admission` |
| `frontend` | app Flutter Web servido por nginx | 8088 (host) | - | `gerenciador-frontend` |

"Rede" quer dizer só dentro da rede Docker `gerenciador-net`, sem porta no host. As libs `shared` (infra de event store, relay e
consumer) e `reservation-client`, `stock-client`, `catalog-client`, `identity-client`, `admission-client` (contrato HTTP de cada
serviço) não são serviços. Infra de apoio no compose: `db` (`supabase/postgres` 17, porta 5433 no host), `supabase-pooler`
(Supavisor), Studio (`127.0.0.1:8000`, via `kong`, mais `meta`), `redpanda`, `redis` e `rabbitmq`. Diagramas e saltos entre serviços:
[`docs/arquitetura/fase7-servicos.md`](/gerenciador-eventos/docs/arquitetura/fase7-servicos); decisões: [`docs/adr/README.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/docs/adr/README.md).

## Pré-requisitos

- Docker com Compose v2. Maven, JDK e Flutter **não** são necessários no host: build e testes rodam em container.
- `Projeto/supabase/.env`: segredos do Supabase, gerados por script (ver [`Projeto/supabase/README.md`](Projeto/supabase/README.md),
  "Gerar os segredos"). Sem ele o `db` não sobe.
- `Projeto/.env`: credenciais do app. Não vai para o git e **nunca** deve ser colado em issue, PR ou log. A lista dos nomes de variável que o
  compose e o `run-tests.sh` exigem (inclusive as **obrigatórias, sem default**: sem elas qualquer `docker compose` recusa) está em
  [`Projeto/README.md`](Projeto/README.md), seção "Pré-requisitos".
- Portas livres no host: 8081, 8088, 5433 e 8000.

## Subir a stack

```bash
# tudo, reconstruindo as imagens e esperando todos os serviços ficarem healthy
docker compose -f Projeto/docker-compose.yml up -d --build --wait

# estado e logs
docker compose -f Projeto/docker-compose.yml ps
docker compose -f Projeto/docker-compose.yml logs -f backend
```

Frontend em `http://localhost:8088`, API em `http://localhost:8081/bff/**`, Studio em `http://localhost:8000`. Overrides opcionais,
combináveis com `-f`:

| Override | Para quê | Detalhes |
|---|---|---|
| `Projeto/docker-compose.autoescala.yml` | réplicas atrás de um HAProxy (`lb`) e scaler no host; **irreversível**: leva `identity.notification` e `reservation.wallet` a 3 partições | [`Projeto/autoescala/README.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/Projeto/autoescala/README.md) |
| `Projeto/docker-compose.slim.yml` | imagens enxutas dos serviços (precisam ser geradas antes) | [`Projeto/slim/README.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/Projeto/slim/README.md) |
| `Projeto/carga/docker-compose.carga.yml` | ambiente de teste de carga e `POST /bff/seed` ligado | [`Projeto/carga/README.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/Projeto/carga/README.md) |

Exemplo: `docker compose -f Projeto/docker-compose.yml -f Projeto/carga/docker-compose.carga.yml up -d --build`. Guia de containers,
volumes e comandos do dia a dia: [`Projeto/README.md`](Projeto/README.md).

## Testes

- **Back-end** (todos os módulos, com Postgres, Redpanda, Redis e RabbitMQ reais): `Projeto/Backend/run-tests.sh`, depois de subir só a
  infra e **parar os serviços** (eles dividiriam banco, broker e Redis com os testes); o passo a passo e o `docker stop` estão em
  [`Projeto/Backend/README.md`](Projeto/Backend/README.md). **Atenção:** a rodada dá `TRUNCATE ... RESTART IDENTITY` nas tabelas do app do
  `meu_banco` (apaga os dados da stack real; para isolar, use `TEST_DB_NAME` com um banco criado antes), apaga a chave do JWT (todo token
  antigo vira 401) e move consumer groups do Redpanda; os efeitos estão no mesmo README.
- **Stack inteira (e2e)**: `Projeto/e2e/run-e2e.sh` sobe tudo num project temporário `gerenciador-e2e`, isolado da stack real e sem
  e-mail de verdade (captador Mailpit), exercita cadastro, evento, reserva, confirmação, a saga e a fila, e derruba só esse project
  no fim. `MANTER=1` mantém o project; `E2E_SLIM=1` usa as imagens enxutas. Precisa de `python` e `openssl` no host, além de `Projeto/.env` e `Projeto/supabase/.env`.
- **Front-end**: lint, teto de tamanho de arquivo e `flutter test` rodam no container do SDK Flutter; o comando está em
  [`Projeto/frontend/README.md`](Projeto/frontend/README.md).

## Onde está cada coisa

| O que | Onde |
|---|---|
| Guia de containers e comandos do compose | [`Projeto/README.md`](Projeto/README.md) |
| Back-end multi-módulo (layout, build, testes) | [`Projeto/Backend/README.md`](Projeto/Backend/README.md) |
| Gateway / BFF | [`Projeto/Backend/monolito/README.md`](Projeto/Backend/monolito/README.md) |
| Serviços | [`identity`](Projeto/Backend/identity/README.md), [`catalog`](Projeto/Backend/catalog/README.md), [`reservation`](Projeto/Backend/reservation/README.md), [`stock`](Projeto/Backend/stock/README.md), [`notification`](Projeto/Backend/notification/README.md), [`admission`](Projeto/Backend/admission/README.md) |
| Banco: init-scripts, schemas, migrações | [`Projeto/Backend/db/README.md`](Projeto/Backend/db/README.md) |
| Front-end Flutter | [`Projeto/frontend/README.md`](Projeto/frontend/README.md) |
| Supabase self-hosted | [`Projeto/supabase/README.md`](Projeto/supabase/README.md) |
| Kit de testes de carga | [`Projeto/carga/README.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/Projeto/carga/README.md) |
| Resultados das rodadas de carga, por etapa | [`Projeto/carga/results/README.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/Projeto/carga/results/README.md) |
| ADRs (decisões de arquitetura) | [`docs/adr/README.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/docs/adr/README.md) |
| Diagramas e mapa dos serviços | [`docs/arquitetura/fase7-servicos.md`](/gerenciador-eventos/docs/arquitetura/fase7-servicos) |
| Specs de design (a mais recente: saga stock + wallet; as demais na mesma pasta) | [`docs/superpowers/specs/2026-10-29-saga-stock-wallet-design.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/docs/superpowers/specs/2026-10-29-saga-stock-wallet-design.md) |
| Roteiros de teste manual | [`docs/testes-manuais/`](https://github.com/endydragonn/GerenciadorEventos/blob/main/docs/testes-manuais/README.md) |
| Roadmap e numeração das issues | [`BACKLOG.md`](BACKLOG.md) |
| Regras do projeto para quem contribui (e para o Claude Code) | [`CLAUDE.md`](CLAUDE.md) e os `CLAUDE.md` de cada área |

## Contribuindo

Idioma de código, comentários, commits e documentação: PT-BR. Nada entra direto em `main`: tudo por PR. Implementação de issue
segue o pipeline descrito no [`CLAUDE.md`](CLAUDE.md) da raiz.
