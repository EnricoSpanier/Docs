# GerenciadorEventos — Guia de Containers

Guia para subir, parar e inspecionar os containers da stack. Visão geral do sistema e da arquitetura: [`../README.md`](../README.md).

## Pré-requisitos

- Docker (Compose v2, já incluso no Docker Desktop).
- Portas livres no host: **8081** (gateway), **8088** (frontend), **5433** (Postgres) e **8000** (Studio, só em `127.0.0.1`).
- `Projeto/supabase/.env` existente antes do `up` (segredos do Supabase; gerar conforme [`supabase/README.md`](supabase/README.md)).
- `Projeto/.env` com as credenciais do app. Não há `.env.example` nesta pasta: peça o arquivo a quem mantém o projeto e **nunca** o
  cole em issue, PR ou log. Os nomes que o compose lê:
  - banco: `POSTGRES_USER` (precisa continuar `admin`), `POSTGRES_PASSWORD`, `POSTGRES_DB` (`meu_banco`) e `SPRING_DATASOURCE_PASSWORD`;
    para o `Backend/run-tests.sh`, também `SPRING_DATASOURCE_URL` (JDBC **direto** no `db:5432`; os serviços do compose usam a URL do pooler definida no
    próprio compose) e, se o usuário não for o default, `SPRING_DATASOURCE_USERNAME`;
  - `MAIL_USERNAME` e `MAIL_PASSWORD` (SMTP do `notification`; `MAIL_HOST`, `MAIL_PORT`, `MAIL_SMTP_AUTH` e `MAIL_STARTTLS` são
    opcionais, o default é o Gmail);
  - `RECAPTCHA_SITE_KEY` e `RECAPTCHA_SECRET_KEY`;
  - **obrigatórias e sem default** (sem elas qualquer `docker compose` recusa): `INTERNAL_API_TOKEN` (token de serviço
    `X-Internal-Token`), `REDIS_PASSWORD`, `RABBITMQ_USER` e `RABBITMQ_PASSWORD`. Acrescente você mesmo, com valores aleatórios
    (por exemplo `openssl rand -hex 32`).

## Subir tudo

Da raiz do repositório:

```bash
# reconstrói as imagens e espera todos os serviços de longa duração ficarem healthy
docker compose -f Projeto/docker-compose.yml up -d --build --wait

docker compose -f Projeto/docker-compose.yml ps
```

Ou de dentro de `Projeto/`: `cd Projeto && docker compose up -d --build --wait`.

## Containers

| Serviço no compose | Container | Porta | O que é |
|---|---|---|---|
| `db` | `gerenciador-db` | 5433 no host (5432 na rede) | Postgres 17 (`supabase/postgres`), banco `meu_banco` |
| `supabase-pooler` | `supabase-pooler` | só na rede (6543) | Supavisor em transaction mode, na frente do `db` |
| `studio`, `meta`, `kong` | `gerenciador-studio`, `gerenciador-meta`, `gerenciador-kong` | 8000 em `127.0.0.1` (via `kong`) | Supabase Studio para inspecionar o banco |
| `redpanda` | `gerenciador-redpanda` | só na rede (9092) | broker Kafka-compatível (backbone de eventos) |
| `redis` | `gerenciador-redis` | só na rede | contador de RPM e estado da fila do `admission` |
| `rabbitmq` | `gerenciador-rabbitmq` | só na rede | fila de admissão (sem volume: reiniciar perde as mensagens em fila) |
| `backend` | `gerenciador-backend` | 8081 | gateway/BFF (`/bff/**`) |
| `identity` | `gerenciador-identity` | só na rede (8084) | usuários e emissão do JWT; chave no volume `identity-keys` |
| `catalog` | `gerenciador-catalog` | só na rede (8083) | eventos |
| `reservation` | `gerenciador-reservation` | só na rede (8082) | reservas (wallet) e orquestrador da saga |
| `stock` | `gerenciador-stock` | só na rede (8086) | capacidade (CAS) e ledger de holds |
| `notification` | `gerenciador-notification` | sem HTTP | e-mail por SMTP |
| `admission` | `gerenciador-admission` | só na rede (8085) | contador de RPM, fila e worker pool |
| `frontend` | `gerenciador-frontend` | 8088 | Flutter Web servido por nginx |
| `notification-seek`, `stock-seek` | sem nome fixo | - | one-shots do 1º `up`: posicionam os groups `notification` e `stock` no Redpanda (só se o group ainda não existe) e terminam com 0 |

Ordem de dependência (`depends_on` com `service_healthy`): o `frontend` espera o `backend`; o `backend` espera `reservation`,
`catalog` e `identity`; o `reservation` espera o `stock`, que espera o `stock-seek`; o `admission` espera `redis`, `rabbitmq` e
`reservation`; o `notification` espera o `notification-seek`. O `backend` **não** depende do `admission` nem do `notification`: com
eles parados a reserva segue síncrona e o cadastro segue funcionando (o e-mail sai quando o `notification` volta).

- Rede: `gerenciador-net`. Volumes: `supabase-db-data`, `db-config`, `redpanda-data` e `identity-keys`.
- `POST /bff/seed` fica desligado (404) no compose normal; o override de carga liga (`SEED_ENABLED`).
- Subir só um serviço (e o que ele exige): `docker compose -f Projeto/docker-compose.yml up -d --build identity`.

## Overrides opcionais

Combinam com o compose base por `-f`, na ordem `base`, depois `slim`, depois `autoescala`:

```bash
# ambiente de teste de carga (liga o POST /bff/seed, SQL em INFO)
docker compose -f Projeto/docker-compose.yml -f Projeto/carga/docker-compose.carga.yml up -d --build

# imagens enxutas (geradas antes por Projeto/slim/gerar-imagens-slim.sh)
docker compose -f Projeto/docker-compose.yml -f Projeto/docker-compose.slim.yml up -d --wait

# autoescala: réplicas atrás de HAProxy (lb publica a 8081); o scaler roda no host
# IRREVERSÍVEL: leva identity.notification e reservation.wallet a 3 partições (ver o aviso abaixo)
docker compose -f Projeto/docker-compose.yml -f Projeto/docker-compose.autoescala.yml up -d --build --wait
```

O de autoescala aumenta para 3 as partições de `identity.notification` e `reservation.wallet`, **de forma irreversível**; leia o
aviso em [`autoescala/README.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/Projeto/autoescala/README.md) antes de usá-lo na stack real. Detalhes do slim em [`slim/README.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/Projeto/slim/README.md)
e da carga em [`carga/README.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/Projeto/carga/README.md).

## Comandos do dia a dia

```bash
docker compose -f Projeto/docker-compose.yml stop                      # para, mantendo rede e volumes
docker compose -f Projeto/docker-compose.yml down                      # remove containers e rede, mantém volumes
docker compose -f Projeto/docker-compose.yml down -v                   # também apaga os volumes (banco novo na próxima subida)
docker compose -f Projeto/docker-compose.yml down --remove-orphans    # remove containers de serviços renomeados/removidos

docker compose -f Projeto/docker-compose.yml logs -f backend           # logs de um serviço
docker compose -f Projeto/docker-compose.yml logs --tail=100           # últimas linhas de todos
docker compose -f Projeto/docker-compose.yml restart backend           # reinicia sem rebuild
docker compose -f Projeto/docker-compose.yml up -d --build backend     # rebuild de um serviço
docker compose -f Projeto/docker-compose.yml build --no-cache backend  # rebuild sem cache
```

`down -v` apaga também a chave de assinatura do JWT (volume `identity-keys`): todo token vira 401 e o login recomeça.

### Banco

```bash
# psql dentro do container (o usuário do app é admin; a senha vem de POSTGRES_PASSWORD no Projeto/.env)
docker exec -it gerenciador-db psql -h localhost -U admin -d meu_banco

# backup de UM schema do app (o dump traz e-mails e hashes de senha: grave FORA do repositório, nunca versione)
docker exec gerenciador-db pg_dump -h localhost -U admin --clean --if-exists -n <schema> meu_banco > <fora do repo>/backup-<schema>.sql
```

Use `-n <schema>` com um dos schemas do app (`identity`, `catalog`, `reservation`, `stock`, `notification` ou `public`), como nos cabeçalhos das
[migrações](Backend/db/README.md); um dump do banco inteiro esbarra nos schemas do Supabase. Para restaurar, passe o arquivo ao
`psql` do mesmo banco (`docker exec -i gerenciador-db psql -h localhost -U admin -d meu_banco < <arquivo>`), com os serviços do schema parados.

Os scripts de init só rodam na **primeira** criação do volume `supabase-db-data`. Para banco já existente use as migrações em
[`Backend/db/README.md`](Backend/db/README.md) (seção "Banco existente: migrações"). Streams e tópicos do Redpanda: `docker exec gerenciador-redpanda rpk topic list`.

### Troubleshooting

- `port is already allocated`: 8081, 8088, 5433 ou 8000 em uso; libere a porta ou mude o mapeamento no `docker-compose.yml`.
- O compose recusa subir pedindo para definir uma variável no `Projeto/.env`: falta uma das obrigatórias acima.
- Login devolve 401 depois de testes ou de `down -v`: a chave do JWT foi apagada; relogue (e reinicie `backend` se o JWKS estiver em cache).
- Antes de `Backend/run-tests.sh` é preciso parar os serviços com `docker stop`: ver [`Backend/README.md`](Backend/README.md).

### Limpeza (opcional, apaga cache e dados)

```bash
docker builder prune --all --force   # cache de build
docker image prune -a -f             # imagens não usadas
# não use `docker volume prune`: no Docker 23+ só poda volume anônimo (e com `--all`, também os nomeados sem container, como o banco)
```

## Estrutura

- Compose: `Projeto/docker-compose.yml` (mais os includes de `supabase/`) e os overrides acima.
- Back-end multi-módulo: [`Backend/`](Backend/README.md). Banco: [`Backend/db/`](Backend/db/README.md). Front-end: [`frontend/`](frontend/README.md).
- Suíte e2e da stack inteira: `Projeto/e2e/run-e2e.sh` (project temporário `gerenciador-e2e`, e-mail em Mailpit; `MANTER=1` mantém, `E2E_SLIM=1` usa as imagens slim;
  precisa de `python` e `openssl` no host).
