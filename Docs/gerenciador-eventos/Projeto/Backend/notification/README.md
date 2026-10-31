# notification

Serviço de e-mail do Gerenciador de Eventos. Consome o tópico `identity.notification` do backbone (Redpanda) e envia o e-mail por SMTP. **Sem
HTTP.** Imagem `notification/Dockerfile`, container `gerenciador-notification`, schema `notification`.

- **Entrada:** eventos `VerificationCodeRequested` e `PasswordResetMfaRequested`, publicados pelo serviço [`identity`](../identity/README.md) (event store
  e outbox na mesma transação do cadastro/código; o relay dele leva ao tópico). Contrato em `shared/.../NotificationEvents.java`.
- **Idempotência:** `notification.processed_event` (schema próprio). Reentrega do mesmo evento não manda dois e-mails.
- **Retenção do dado pessoal:** o evento leva e-mail e código e só vive a validade do código + 30 s: o `identity` apaga a linha do event store, o tópico e o
  `.DLT` têm `retention.ms` de 15 min 30 s e o serviço descarta evento com código vencido.
- **Independência:** só depende da lib `shared`, do Postgres e do Redpanda; não lê tabela de outro serviço. Com ele parado, cadastro e login seguem
  normais e os e-mails saem quando ele volta.
- **1º `up`:** o one-shot `notification-seek` move o group `notification` para o fim do tópico só se o group ainda não existe (stack nova não manda
  e-mail de evento antigo); o serviço espera ele terminar.
- **Rodar:** `docker compose -f Projeto/docker-compose.yml up -d --build notification`. Variáveis (só nomes): `SPRING_DATASOURCE_*`, `MAIL_USERNAME`,
  `MAIL_PASSWORD`, `SPRING_KAFKA_BOOTSTRAP_SERVERS`; opcionais `MAIL_HOST`, `MAIL_PORT`, `MAIL_SMTP_AUTH` e `MAIL_STARTTLS` (default Gmail; o e2e aponta
  para um captador). Sem default para `MAIL_USERNAME`/`MAIL_PASSWORD`: para rodar fora do Docker, exporte as duas.
- **Banco:** `Projeto/Backend/db/init-scripts/12-notification.sql` (banco novo) ou a migração `20261024-notification-schema.sql` (ver [`../db/README.md`](../db/README.md)).
- **Testar:** `Projeto/Backend/run-tests.sh` (reactor inteiro; pré-requisitos e `docker stop` dos serviços em [`../README.md`](../README.md)). O
  `NotificationConsumerTest` usa Postgres e Redpanda reais e um `JavaMailSender` falso: nenhum e-mail real sai.

Detalhes (fluxo, política de erro, pool e a conta do Supavisor, pendências): [`../CLAUDE.md`](../CLAUDE.md), seção "Serviço notification".
