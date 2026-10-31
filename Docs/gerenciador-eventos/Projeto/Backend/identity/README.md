# identity

Serviço de identidade do Gerenciador de Eventos. Dono de `users`, `mywallet` e `pending_verifications` (schema `identity`, CRUD, sem event
sourcing), do login (BCrypt), do cadastro em duas fases, do reset de senha com MFA, da troca de senha, do reCAPTCHA
(`RECAPTCHA_SECRET_KEY` só existe aqui) e da **emissão do JWT** (RS256, `kid` = thumbprint RFC 7638, claims `sub` = e-mail, `uid`, `isHost`,
`iss` = `gerenciador-identity`, `iat`, `exp`). Processo, imagem (`identity/Dockerfile`) e container (`gerenciador-identity`) próprios.
Spec: [`docs/superpowers/specs/2026-10-26-identity-servico-design.md`](https://github.com/endydragonn/GerenciadorEventos/blob/main/docs/superpowers/specs/2026-10-26-identity-servico-design.md).

- **API interna:** porta **8084**, só na rede `gerenciador-net`. `/internal/**` exige `X-Internal-Token` (`INTERNAL_API_TOKEN`, o mesmo dos
  outros serviços; 401 sem ele). Contrato em [`../identity-client/README.md`](../identity-client/README.md). `GET /.well-known/jwks.json`
  (só a chave pública) é isento do token, somente a URI exata com GET. Quem chama é o gateway.
- **Chave de assinatura:** gerada no 1º boot e guardada em `JWT_SIGNING_KEY_PATH` (volume `identity-keys` no compose). Arquivo ilegível ou
  corrompido derruba o boot (nunca regera por cima). Rotação = apagar o arquivo e reiniciar; todo token vira 401.
- **Eventos** (event store e relay próprios, `identity.event_store`): `identity.notification` (pedido de e-mail, consumido pelo
  [`notification`](../notification/README.md)) e `identity.user` (ciclo de vida, payload só com ids; sem consumer).
- **Fora do ar:** login, cadastro, `/bff/users/**` e `/bff/my-wallets/**` respondem 503, mas quem já tem token válido segue reservando (o
  gateway guarda o JWKS em cache). O serviço **não sobe** se `public.users` ainda existir (migração `20261028` pendente).
- **`uid` reciclado:** `TRUNCATE ... RESTART IDENTITY` em `identity.users` exige apagar a chave do volume `identity-keys` e reiniciar este serviço
  e o backend (cache de JWKS do gateway). O `run-tests.sh` e o `Projeto/carga/limpar-banco.sh` fazem isso.
- **Rodar:** `docker compose -f Projeto/docker-compose.yml up -d --build identity`. Variáveis (só nomes): `INTERNAL_API_TOKEN`,
  `RECAPTCHA_SECRET_KEY`, `SPRING_DATASOURCE_*`, `SPRING_KAFKA_BOOTSTRAP_SERVERS`, `JWT_SIGNING_KEY_PATH`, `JWT_EXPIRATION_SECONDS`, `EVENTS_RELAY_*`.
- **Banco:** `Projeto/Backend/db/init-scripts/15-identity.sql` (banco novo) ou a migração `20261028-identity-schema.sql` (ver [`../db/README.md`](../db/README.md)).
- **Testar:** `Projeto/Backend/run-tests.sh` (reactor inteiro; pré-requisitos e `docker stop` dos serviços em [`../README.md`](../README.md)). Os testes
  usam Postgres e Redpanda reais, chave de assinatura temporária por JVM e um reCAPTCHA falso: `IdentityApiE2ETest` (cliente real contra serviço
  real), `JwtSigningKeyTest`, `UserTest`, `MyWalletTest`, `SchemaValidationTest` e os de eventos.

Detalhes (JWT, pool, N réplicas): [`../CLAUDE.md`](../CLAUDE.md), seção "Serviço identity".
