---
sidebar_position: 6
sidebar_label: "ADR: Split em Microsserviços"
tags: [architecture, decision, adr, microservices, backend, strangler, polyglot-persistence]
---

# Decisão de Arquitetura — Decomposição do Back-end em Microsserviços

> **Status: decidido, NÃO implementado.** Registra o mapa de serviços alvo e a
> estratégia de migração. Implementação depende de Docker Desktop e da base verde
> (testes de 2026-09-01 nunca compilaram). Ver [Implementacao-EventCap-e-Reserva-CAS](./Implementacao-EventCap-e-Reserva-CAS.md).

## Contexto

O back-end hoje é um monólito único (Spring Boot + JDBC, sem pool) que concentra
autenticação, catálogo de eventos, capacidade/reserva, envio de e-mail e o BFF do
Flutter. [Backend-Architecture](./Backend-Architecture.md) já prega o isolamento do agregado de capacidade;
[Architecture-Decision-Stock-Isolation](./Architecture-Decision-Stock-Isolation.md) generaliza; [Architecture-Decision-Async-Checkout-Queue](./Architecture-Decision-Async-Checkout-Queue.md)
descreve a camada de alta carga como componente à parte. A diretriz do autor:
**todo o back baseado em microsserviços — tudo que puder ser desacoplado, deve ser.**

## Decisão

Adotar a decomposição **Opção B** (Auth e Catálogo como serviços separados),
migrando por *strangler pattern* a partir do monólito atual.

### Mapa de serviços alvo

| Serviço | Responsabilidade | Persistência | Comunicação |
|---|---|---|---|
| `gateway` | Roteamento + agregação (BFF atual formalizado); contrato externo do Flutter inalterado | — | HTTP para os demais |
| `identity` | Cadastro, login, MFA, reCAPTCHA, verificação de e-mail, troca de senha | schema próprio (hash de senha, segredos MFA) | HTTP síncrono; emite `UserRegistered`, `PasswordChanged` |
| `catalog` | CRUD de `event`, `eventpresenter`, autorização de host | schema próprio | HTTP síncrono; `creator_id` = referência solta (sem FK cross-service) |
| `reservation` | `eventcap` + CAS, `walletevent` (máquina de estados), confirmar/cancelar, job de expiração | schema próprio | API interna síncrona (checkout chama direto); emite `SlotReserved`, `ReservationExpired` |
| `notification` | Envio de e-mail | sem estado durável (ou fila local) | consumidor assíncrono de eventos |
| `admission` | Contador RPM por evento (Redis) + fila RabbitMQ + worker pool — modo de alta carga | Redis | consome fila, chama `reservation` |

Infra de apoio: **Supabase self-hosted enxuto** ([Architecture-Decision-Supabase-Self-Host](./Architecture-Decision-Supabase-Self-Host.md))
para Postgres + pooler (Supavisor) + Studio; **backbone de eventos Kafka-compatível**
(Kafka ou Redpanda) como log de eventos de domínio; **RabbitMQ** para a fila de admissão
([Architecture-Decision-Async-Checkout-Queue](./Architecture-Decision-Async-Checkout-Queue.md)); **Redis** para o sinal de carga.

### CQRS + Event Sourcing — no escopo do TCC, convertido antes de extrair

Revisão de 2026-09-02: a decisão anterior ("só CAS; CQRS+ES fica para outra rodada") foi
**revertida**. CQRS+ES é parte da estrutura que o TCC propõe e o teste de carga precisa
exercitá-la — não um CRUD como stand-in. Notas do vault corrigidas:
[_Event-Management-System](./visao-geral.md) (passo), [Implementacao-EventCap-e-Reserva-CAS](./Implementacao-EventCap-e-Reserva-CAS.md),
[Backend-Architecture](./Backend-Architecture.md).

**Discriminador resolvido (2026-09-02):** o TCC depende de **throughput + consistência**,
tanto na camada de serviços quanto no banco/infra. Ou seja, a tese argumenta *também*
elasticidade/throughput de um backbone de eventos — não só fronteiras de consistência. Logo o
event store **não** é detalhe de implementação: é **Kafka-compatível** (Kafka ou Redpanda —
Redpanda = binário único, mais leve, mesma API; decidir na ADR de implementação). Papéis:
Kafka = fonte de verdade do log de eventos de domínio + fanout; RabbitMQ = fila de trabalho
da admissão (ack/nack, TTL de mensagem, dead-letter — semântica que o [Architecture-Decision-Async-Checkout-Queue](./Architecture-Decision-Async-Checkout-Queue.md)
escolheu de propósito). Custo aceito: **dois brokers** no compose — justificado porque o TCC
mede throughput de evento (Kafka) e controle de admissão sob pico (RabbitMQ) como coisas
distintas. Snapshots de agregado em tabela Postgres.

Escopo do ES (deliberadamente estreito):

| Alvo | ES? | Motivo |
|---|---|---|
| `catalog` (ciclo de vida de `event`/`eventpresenter`) | **Sim** — command side + projeções de leitura | Ciclo de vida com histórico/auditoria; se beneficia de múltiplas views |
| lado **wallet/order** de `reservation` (`SlotReserved`, `ReservationConfirmed/Expired/Cancelled`) | **Sim** — stream event-sourced | É o "resto do domínio de pedido" do [Backend-Architecture](./Backend-Architecture.md) §2 |
| `eventcap` (capacidade) dentro de `reservation` | **Não** — segue relacional/CAS | A tese: fronteira de consistência forte fora do ES. Serviço `reservation` fica **híbrido** (CAS + ES no mesmo bounded context) — exatamente o [Backend-Architecture](./Backend-Architecture.md) §1–2 |
| `identity` | **Não** — CRUD que *emite* eventos | Log append-only imutável com hash de senha / segredo de MFA = não dá pra apagar credencial; replay de evento de auth não faz sentido |
| `notification` | **Não** — consumidor, sem agregado | Nada a fazer source; só reage |

**Ordem (2026-09-02):** converter para CQRS+ES **primeiro**, dentro dos módulos
pacote-por-serviço do monólito, e só então extrair — os serviços já saem ES-native. Evita
fazer trabalho de schema duas vezes em `catalog` e `reservation`. O monólito continua sendo
um deployable funcional durante a conversão (contrato externo inalterado; read models
projetados internamente).

### `reservation` = Capacity + Wallet no mesmo serviço (por ora)

CAS em `eventcap` e insert `pending` em `walletevent` hoje ocorrem **na mesma transação
local** — a compensação em falha é o próprio `rollback`, sem saga
([Implementacao-EventCap-e-Reserva-CAS](./Implementacao-EventCap-e-Reserva-CAS.md)). Separar em dois serviços com bancos
distintos destrói essa garantia e exige saga (reserva, grava wallet, em falha
chamada de liberação idempotente + reaper de decrementos órfãos), trocando a garantia
de no-overselling por uma mais fraca.

**Decisão:** manter os dois no serviço `reservation`, mas deixar a separação **viável e
mapeada**:
- fronteira de API interna explícita entre "decrementar capacidade" e "gravar reserva";
- **idempotency key** no fluxo de reserva desde já;
- não depender do `@Transactional` local como única prova de corretude (documentar a
  invariante e o ponto de compensação).
- O split `stock` + `wallet` com saga vira rodada futura, condicionado a análise de trade-off.

Divergência registrada: [Backend-Architecture](./Backend-Architecture.md) §3 já desenha a linha
"checkout para Serviço de Estoque (síncrono), grava WalletEvent depois", ou seja, o alvo
documentado **implica** a saga; o código de 2026-09-01 colapsou os dois lados. Ao separar
no futuro, seguir o §3.

## Por quê Opção B (e não A — Auth+Catalog juntos)

O que difere entre A e B é só a fronteira Auth vs Catalog:

- **A favor de B:** cumpre a diretriz "desacoplar tudo que fizer sentido"; isola o serviço
  que guarda credenciais (endurecível à parte); raio de dano menor (bug de auth não derruba
  navegação de catálogo); reforça a narrativa de *polyglot persistence* do TCC (`identity`
  Postgres puro, `catalog` livre pra ganhar views/busca depois); adoção de microsserviços é
  ponto avaliado no TCC.
- **Custo aceito:** +1 serviço, +1 schema, +1 alvo de CI; `event.creator_id` para
  `user.user_id` deixa de ser FK (integridade referencial vira responsabilidade da
  aplicação); listar evento com nome do criador exige composição no `gateway` ou
  desnormalização de `creator_name` no `catalog`; risco maior de "monólito distribuído" se a
  fronteira for mal desenhada.

## Estratégia de migração (strangler, incremental)

Pré-condições duras (nesta ordem):
1. **Base verde** — a implementação de 2026-09-01 compila e passa nos testes. Sem isso não há
   sinal de que uma extração preservou comportamento.
2. **Segredos fora do git** — `Projeto/.env` está commitado; pré-requisito porque cada
   serviço adiciona segredos.
3. **Supabase + Supavisor** — conexão-por-request sem pool × N serviços é pior que o caso
   atual; o pooler vira pré-condição pra rodar múltiplos serviços.
4. **Harness de teste migrado pra schema-per-service** — `GlobalDbTruncator` trunca
   `public.*` e `SchemaValidationTest` filtra `table_schema='public'`; ambos quebram com
   schema por serviço.

Depois, **dentro do monólito**, nesta ordem:
1. Refatorar em **pacotes-por-serviço** sem chamada cruzada fora de interface; formalizar o
   `gateway`; idempotency key no fluxo de reserva.
2. Subir o backbone Kafka-compatível + a infra de event store (append/read por stream,
   concorrência otimista, projeções idempotentes com catch-up, snapshots).
3. **Converter `catalog` para CQRS+ES** (command side + projeções) — ainda no monólito.
4. **Converter o lado wallet/order de `reservation` para ES** (híbrido: `eventcap`/CAS
   relacional) — ainda no monólito.

Só então **extração, um serviço por vez, gateway mantendo o contrato externo, testes verdes a
cada passo** ("verde" numa extração = o gateway/BFF ainda serve o mesmo contrato, não só que
a suíte compila):
1. `notification` — o mais fácil, valida o consumo do backbone.
2. `reservation` — híbrido CAS + ES, API interna síncrona, schema + streams próprios.
3. `catalog` — ES, schema próprio. **Feito na #35 (2026-10-24):** `creator_id` segue `integer`, sem FK
   (referência solta); `creator_name` é composto no `gateway` (lote ao `identity` + cache), sem projeção.
   O `gateway` valida JWT e host e amarra `creator_id` ao token; o `catalog` autentica só por token de
   serviço (JWT assimétrico + JWKS é a #36).
4. `identity` — CRUD emitindo eventos; validação de JWT stateless nos demais.

Depois da extração: **teste de carga** sobre a estrutura completa — mede throughput
sustentado (reservas/s e leituras/s), lag write→projeção e lag de consumer do backbone, e
mostra que o overselling não ocorre apesar do lag (a checagem de capacidade nunca toca o read
model), com um braço de controle onde a checagem passa pela projeção e *oversella*.

`admission` entra por último, junto da camada de alta carga, após o teste de carga definir o
limiar X.

### De-risking do experimento (feedback do orientador, 2026-09-02)

O braço de controle "checar disponibilidade via read model defasado → oversella" é o
diferencial do TCC, mas na ordem acima ele só roda no fim, atrás de ~toda a fila. Risco: chegar
à banca sem dado. Mitigação — **o experimento roda primeiro contra o monólito atual** (logo
após a base verde da Fase 1), usando um read model defasado *sintético* (tabela desnormalizada
+ refresh em timer + caminho de leitura com feature flag). Isso trava um resultado defensável
cedo. Depois ele **re-roda a cada marco de arquitetura**, virando uma série de 3 pontos que é
a contribuição rica:

1. monólito CRUD + read model sintético (Fase 2 do backlog);
2. monólito com CQRS+ES, contra a projeção real (lag de consumer de verdade);
3. distribuído, com `reservation` extraído — a checagem cruza a rede.

Geração de carga roda de **máquina/VM separada** (o autor tem ambas), então os números
absolutos de latência/throughput são válidos, não só a contagem de corretude do braço de
controle.

Consequência para pré-condições: **Supabase + Supavisor deixa de ser pré-condição do
experimento** — só destrava os números absolutos comparáveis. A 1ª rodada não espera por ele.

## Critério de iteração válida

Uma issue só é fronteira de iteração legítima se, após o merge, `docker compose up` +
suíte de testes continuam verdes **e** o contrato servido ao Flutter não muda. Isso implica
que cada extração de serviço é *uma* issue (compose + schema + roteamento no gateway juntos —
estados intermediários deixam o sistema quebrado).

## Impacto — o que muda

- `Projeto/docker-compose.yml`: de 2 serviços (`db`, `backend`) para ~12 (`gateway`,
  `identity`, `catalog`, `reservation`, `notification`, `admission`, `supabase-*`,
  `kafka`/`redpanda`, `rabbitmq`, `redis`).
- `Projeto/Backend/` deixa de ser um módulo Maven único — vira multi-módulo ou repositórios
  por serviço (decidir na implementação).
- Init-scripts do banco passam a ser por schema/serviço; cada serviço com stream de eventos
  + tabelas de projeção + tabela de snapshot.
- Testes: suíte de unidade por serviço + integração ponta-a-ponta no `gateway` + teste de
  replay (reconstruir projeção do log) por agregado event-sourced.
- Autorização: cada serviço valida JWT localmente; `identity` é a única fonte de credencial.
- Observabilidade vira necessidade real (trace entre serviços + lag de consumer) — candidata
  a issue/nota própria.

## Questões em aberto (resolver na implementação)

- Multi-módulo Maven num repo vs. repositório por serviço.
- Um banco Postgres com schema por serviço vs. um banco por serviço (Supavisor suporta os
  dois; schema por serviço é mais leve pro TCC).
- **Kafka vs. Redpanda** para o backbone (mesma API; Redpanda é single-binary).
- **Event store: Kafka como log de verdade** (com projeções materializadas em Postgres) **vs.
  tabela de streams no Postgres + publish no Kafka**. O primeiro casa melhor com o argumento
  de throughput/elasticidade do TCC.
- Formato do evento de domínio (JSON schema? Avro? + schema registry?) e versionamento.
- JWT: segredo compartilhado simétrico vs. JWKS assimétrico servido pelo `identity`.
- Admissão: fila no RabbitMQ (do [Architecture-Decision-Async-Checkout-Queue](./Architecture-Decision-Async-Checkout-Queue.md)) vs. tópico
  particionado no Kafka — reavaliar agora que o Kafka já está no stack.
- ~~Onde compor `creator_name`~~ — resolvido na #35: no `gateway` (chamada em lote ao `identity` + cache
  Caffeine), não por projeção no `catalog`.

## Relacionado

- [_Event-Management-System](./visao-geral.md)
- [Roadmap-e-Issues](./Roadmap-e-Issues.md) — esta decisão virou as issues #23–#37 (decomposição) e #26–#31 (CQRS/ES)
- [Backend-Architecture](./Backend-Architecture.md)
- [Architecture-Decision-Stock-Isolation](./Architecture-Decision-Stock-Isolation.md)
- [Architecture-Decision-Async-Checkout-Queue](./Architecture-Decision-Async-Checkout-Queue.md)
- [Architecture-Decision-Supabase-Self-Host](./Architecture-Decision-Supabase-Self-Host.md)
- [Implementacao-EventCap-e-Reserva-CAS](./Implementacao-EventCap-e-Reserva-CAS.md)
- [Database-Schema](./Database-Schema.md)


---

*Sincronizado automaticamente de `Architecture-Decision-Microservices-Split.md` em 2026-10-30T19:11:52.865Z.*
