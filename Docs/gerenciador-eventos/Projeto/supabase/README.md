# supabase/ — Supabase self-hosted (vendorizado)

Origem: repositório `supabase/supabase`, pasta `docker/`, commit
`bc27d2661edd09a5d0b8d76ce33da6d4071a756e` (2026-10-16).
Os arquivos vendorizados são cópia fiel do upstream; não os edite aqui (as exceções locais são
`functions-role.sql` e `pooler-upsert.exs`, abaixo).

Nesse commit o gateway padrão do upstream é o Envoy; o Kong vem do overlay
`docker-compose.kong.yml`, que é a referência de ligação para o `kong.yml` e o
`kong-entrypoint.sh` daqui.

## O que está aqui

- `volumes/db/` — `roles.sql`, `jwt.sql`, `_supabase.sql`, `pooler.sql` (init do Postgres) e
  `functions-role.sql` (adição local, não vem do upstream: cria a role `supabase_functions_admin`
  que o `roles.sql` altera, já que o `webhooks.sql` do upstream que a cria não foi trazido).
  O compose monta `roles.sql`, `functions-role.sql`, `_supabase.sql` e `pooler.sql`.
- `volumes/pooler/pooler.exs` — configuração do Supavisor (upstream, vendorizado, **não montado**) e
  `volumes/pooler/pooler-upsert.exs` (variante local, a que o compose monta; ver "Ligação no compose").
- `docker-compose.pooler.yml` — serviço `supabase-pooler` (adaptado do `supavisor` do upstream).
- `volumes/api/` — `kong.yml` e `kong-entrypoint.sh` (gateway Kong do Studio).
- `docker-compose.studio.yml` — serviços `studio`, `meta` e `kong` (adaptação local do `studio`/`meta` do
  `docker-compose.yml` e do `docker-compose.kong.yml` do upstream; não é cópia fiel). Incluído por
  `Projeto/docker-compose.yml`. Ver "Studio" abaixo.
- `utils/generate-keys.sh` — gera os segredos.
- `.env.example` — versão reduzida do upstream, só com o que db, Supavisor, Studio, meta e kong usam.

## O que ficou de fora

Só sobe a cadeia enxuta: db + Supavisor + Studio/meta/kong. GoTrue, PostgREST, Realtime,
Storage, imgproxy e edge functions não sobem (o backend Spring faz auth e API), então seus
arquivos (`realtime.sql`, `logs.sql`, `webhooks.sql`, `functions/`, `storage/`, `envoy`, o
`docker-compose.yml` do upstream) não foram trazidos.

## Gerar os segredos

Rode SEMPRE a partir de `Projeto/supabase/`: o script edita o `.env` do diretório atual e,
rodado em `Projeto/`, sobrescreveria os segredos do backend.

```
cd Projeto/supabase && git check-ignore -q .env && [ ! -e .env ] && command -v openssl >/dev/null && cp .env.example .env && sh utils/generate-keys.sh --update-env > /dev/null && rm -f .env.old && [ "$(grep -c '<gerado' .env)" = 0 ]
```

- `git check-ignore -q .env` aborta se o `.env` não estiver ignorado (evita criar um arquivo versionável com segredos).
- `[ ! -e .env ]` aborta se já existe um `.env`, para não sobrescrevê-lo.
- `command -v openssl` aborta se o openssl não existe (o script depende dele).
- `> /dev/null` evita imprimir as chaves no terminal.
- `.env.old` é o backup que o `sed -i.old` do script cria; é removido e também é ignorado pelo git.
- O último teste falha se sobrou algum placeholder `<gerado...>` no `.env`.

Atenção: regerar os segredos com um volume do db já inicializado quebra a autenticação (a
senha e os roles ficam gravados no volume). Para regerar, apague o volume do db junto.

O `.env` gerado nunca é commitado. Estes segredos são independentes do `Projeto/.env` do backend.

## Ligação no compose

O `db` está ligado (issue #18): o serviço `db` de `Projeto/docker-compose.yml` usa a imagem
`supabase/postgres` com `env_file: ./supabase/.env`, então **`Projeto/supabase/.env` precisa
existir antes do `up`** (gere-o como acima). O banco é `meu_banco` (ver `Projeto/Backend/db/CLAUDE.md`),
montado com `volumes/db/roles.sql` e `volumes/db/functions-role.sql`.

O pooler (Supavisor, issue #19) está ligado:

- `docker-compose.pooler.yml` (aqui) define o serviço `supabase-pooler` (`supabase/supavisor:2.9.13`,
  container `supabase-pooler`, rede `gerenciador-net`, **sem porta no host**) e é trazido pelo
  `include:` de `Projeto/docker-compose.yml`. Cada Supabase compose futuro entra como um item
  próprio desse `include:`.
- **Segredos:** o serviço lê `supabase/.env` pelo próprio `env_file:` e o `command` exporta as variáveis
  derivadas (`DATABASE_URL`, `API_JWT_SECRET`, `METRICS_JWT_SECRET`); os valores não secretos (`POOLER_*`,
  `DB_POOL_SIZE`) são literais no `environment:`. O motivo está em "Segredos nos compose incluídos",
  abaixo (verificado aqui: com `${VAR}` o pooler subiu com a senha do app e falhou a autenticação do
  `supabase_admin`).
- O `db` monta `volumes/db/_supabase.sql` (cria o banco `_supabase`, estado interno do Supavisor)
  e `volumes/db/pooler.sql` (schema `_supavisor`) em `migrations/97-` e `99-pooler.sql`. Como todo
  init, só rodam na **primeira** criação do volume `supabase-db-data`; em um volume já existente
  recrie-o (`down -v` ou `docker volume rm gerenciador-eventos_supabase-db-data gerenciador-eventos_db-config`).
- `volumes/pooler/pooler-upsert.exs` (montado no lugar do `pooler.exs` do upstream, que fica
  intocado) cria o tenant `gerenciador-eventos` no banco `meu_banco`, com `auth_query` em
  `pgbouncer.get_auth` e `require_user=false`: qualquer role do Postgres loga pelo pooler com a
  própria senha, no formato `<role>.<tenant>`. **Exceção local ao upstream:** o `pooler.exs` só
  chama `create_tenant` quando o tenant não existe, e o tenant persiste no banco `_supabase` (volume
  do db), então mudar o tamanho do pool e subir de novo não mudaria nada. O `pooler-upsert.exs`
  acrescenta o ramo "já existe": `Supavisor.Tenants.update_user` (`pool_size` do usuário
  `pgbouncer`) e `update_tenant` (`default_pool_size`, `default_max_clients`), que na v2.9.13 também
  limpa o cache e encerra os pools do tenant. Resultado: o dimensionamento vale a cada partida do
  container, sem apagar volume.
- O backend usa `SPRING_DATASOURCE_URL=jdbc:postgresql://supabase-pooler:6543/meu_banco?prepareThreshold=0`
  e `SPRING_DATASOURCE_USERNAME=${POSTGRES_USER}.gerenciador-eventos` (no `environment:` do
  `backend` em `Projeto/docker-compose.yml`, sobrepondo o `env_file`). O tenant é fixo (não é
  segredo); se mudar `POOLER_TENANT_ID` aqui, mude lá. Os testes (`run-tests.sh`) e o gerador de
  carga (`:5433`) continuam **direto** no `db`.
- Modo `transaction` (`POOLER_POOL_MODE`): a conexão real só é presa durante a transação. O backend
  é compatível (auditoria em `Projeto/Backend/CLAUDE.md`, "Pooler").


## Studio (issue #20)

`Projeto/docker-compose.yml` inclui `supabase/docker-compose.studio.yml`, que sobe **só** `studio`
(`supabase/studio`), `meta` (`supabase/postgres-meta`) e `kong` (gateway do Studio), na rede
`gerenciador-net`. GoTrue, PostgREST, Realtime, Storage, imgproxy e edge functions não sobem: as rotas
`/auth`, `/rest`, `/realtime`, `/storage` e `/functions` do `kong.yml` vendorizado apontam para eles e
respondem erro de gateway se chamadas; o Kong só resolve o DNS na requisição, então isso não impede o start.

- URL: `http://localhost:8000` (porta do Kong; o Studio e o `meta` não publicam porta). A porta é publicada só
  em `127.0.0.1` (atrás dela há um console SQL de superuser). Login (basic auth):
  `DASHBOARD_USERNAME` e `DASHBOARD_PASSWORD` do `Projeto/supabase/.env`.
- Inspeção das tabelas do app (`eventcap`, `walletevent`, ...): Table Editor, schema `public`. Studio e `meta`
  conectam ao banco `meu_banco` como `supabase_admin` (superuser; senha = `POSTGRES_PASSWORD` do Supabase),
  e não como `postgres` (default do upstream): as tabelas do app pertencem à role `admin` e o `postgres`
  não tem grant nelas. Também não usam o próprio `admin`: a senha dele mora no `Projeto/.env` e não deve
  chegar aos serviços do Supabase.
- Não há variável nova no `.env`. `SUPABASE_PUBLIC_URL` (`http://localhost:8000`) e `SUPABASE_PUBLISHABLE_KEY`/
  `SUPABASE_SECRET_KEY` (vazias, mas presentes) já estão no `.env.example`.
- Os snippets SQL do Studio ficam em `volumes/snippets/` (ignorado pelo git).

### Segredos nos compose incluídos (pooler e Studio)

A interpolação `${...}` de um arquivo incluído lê o `.env` da pasta dele (`Projeto/supabase/.env`) e, depois,
o ambiente do compose principal (`Projeto/.env`, do backend), que **vence** em nomes iguais (testado, nos dois
casos; `include.env_file` não muda isso e por isso não é usado). Só `POSTGRES_PASSWORD` e `JWT_SECRET` colidem:
o backend os define com outro sentido, então interpolá-los entregaria os segredos do backend ao Supabase.
Por isso, em todo serviço que usa esses dois, o `./.env` desta pasta entra pelo `env_file:` do **serviço**,
que é literal, e `${...}` só aparece em nomes que não colidem.

- **Pooler:** nenhum `${...}`; o `command` monta as variáveis derivadas a partir do `env_file`.
- **`meta` e `studio`:** carregam o `.env` pelo `env_file` do serviço e um shim no `entrypoint` mapeia só
  esses dois para o nome que a imagem espera (`POSTGRES_PASSWORD` -> `PG_META_DB_PASSWORD` no `meta`;
  `JWT_SECRET` -> `AUTH_JWT_SECRET` no `studio`). O resto (`ANON_KEY`, `SERVICE_ROLE_KEY`, `PG_META_CRYPTO_KEY`,
  `STUDIO_DEFAULT_*`) não colide e interpola com `${...}`.
- **`kong`:** só usa nomes sem colisão (`ANON_KEY`, `SERVICE_ROLE_KEY`, `DASHBOARD_*`) e interpola normalmente;
  assim não recebe `POSTGRES_PASSWORD`/`JWT_SECRET`.

Regras ao mexer nesses arquivos:

- nunca ponha `POSTGRES_PASSWORD`/`JWT_SECRET` em `environment:` nem em `${...}` (sobrescreveria o `env_file`
  com o do backend);
- o shim do Studio/`meta` repete o `entrypoint`/`cmd` originais da imagem (`docker-entrypoint.sh` + `node ...`);
  ao trocar a versão da imagem, confira com `docker image inspect`;
- `studio`, `meta` e o pooler recebem o `.env` inteiro (inclui `SECRET_KEY_BASE`, `VAULT_ENC_KEY`,
  `DASHBOARD_PASSWORD`), já que `env_file` não filtra.

### Dimensionamento

Os valores moram, literais e versionados, no `environment:` de `docker-compose.pooler.yml` (vencem o
`supabase/.env`; um `.env` antigo não os muda e o `.env.example` não os tem):

| Variável | Valor | Por quê |
|---|---|---|
| `POOLER_MAX_CLIENT_CONN` | 1500 | Conexões de cliente aceitas. Tem que ser >= o pool máximo do Hikari (1000, `SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE`), senão o Supavisor recusa clientes; 1500 dá folga. |
| `POOLER_DEFAULT_POOL_SIZE` | 45 | Conexões **reais** ao Postgres (por role/banco). O `db` do compose padrão tem `max_connections=100`, e o Supavisor **não devolve conexão ociosa**: depois de uma rajada o pool inteiro fica preso. Folga de 55: 3 reservadas do superuser (a role `admin` não é superuser), ~9 do próprio Supavisor (`DB_POOL_SIZE` 5 + auth_query + cluster), ~40 da suíte `run-tests.sh` (que vai direto no `db`; pico medido ~36) e `psql`. Com 70 a suíte falhou com `remaining connection slots are reserved`. |
| `DB_POOL_SIZE` | 5 | Conexões do próprio Supavisor ao banco `_supabase`. |
| `POOLER_TENANT_ID` | `gerenciador-eventos` | Tenant fixo; o usuário do JDBC (`Projeto/docker-compose.yml`) é `<role>.gerenciador-eventos`. Mude os dois juntos. |

Com o override de carga (`carga/rpm/docker-compose.rpm.yml`, `make host-rpm MAX_CONN=300`) o
`max_connections` sobe para 300 e o pool do pooler acompanha: `POOLER_DEFAULT_POOL_SIZE` vira
`${PG_POOLER_POOL_SIZE:-245}` (o `subir-host-rpm.ps1` exporta `MaxConnections - 55`, a mesma folga do
padrão 100 → 45). Ao voltar ao compose padrão, o `up -d` reaplica 45 (o `pooler-upsert.exs` atualiza o tenant).
