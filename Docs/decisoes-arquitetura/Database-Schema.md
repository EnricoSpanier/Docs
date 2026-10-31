---
sidebar_position: 3
sidebar_label: "Schema do Banco"
tags: [database, dbml, postgresql, schema]
---

# Database Schema — Event Management System

Schema refinado a partir do README original do sistema (back-end Java/Spring Boot) e do princípio de agregado isolado descrito em [Backend-Architecture](./Backend-Architecture.md). Ver seção final para as diferenças em relação ao schema inicial proposto.

> **Nota (2026-09-02):** este DBML é o modelo lógico do **monólito**. O DDL efetivamente
> implementado em 2026-09-01 usa nomes minúsculos (`event`, `eventcap`, `eventpresenter`,
> `walletevent`) e adiciona `CHECK`s + a regra `capacity = -1` (ilimitado) — ver
> [Implementacao-EventCap-e-Reserva-CAS](./Implementacao-EventCap-e-Reserva-CAS.md). Com a decomposição em microsserviços
> ([Architecture-Decision-Microservices-Split](./Architecture-Decision-Microservices-Split.md)) o schema passa a ser **por serviço** e
> ganha tabelas de stream/projeção/snapshot — ver a seção "Impacto de microsserviços + CQRS/ES".

## DBML atual

```dbml
Table User {
  user_id uuid [pk]
  user_name varchar [not null]
  email varchar [not null, unique]
  fone varchar [not null, unique]
  password varchar [not null]
  birthdate date [not null]
  is_admin boolean [not null, default: false]
  is_active boolean [not null, default: true]
  created_at timestamp [not null]
  updated_at timestamp [not null]
}

Table Event {
  event_id uuid [pk]
  creator_id uuid [not null]
  event_name varchar [not null, unique]
  ead boolean [not null, default: false]
  address varchar
  event_date datetime [not null]
  description varchar [not null]
  image_data bytea
  created_at timestamp [not null]
  updated_at timestamp [not null]
}

Table EventPresenter {
  event_id uuid [not null]
  presenter_name varchar [not null]
  indexes {
    (event_id, presenter_name) [pk]
  }
  Note: 'Lista de apresentadores por evento; pode não ter linhas (lista vazia).'
}

// --- Agregado isolado, à parte do resto: fronteira de consistência forte ---
Table EventCap {
  event_id uuid [pk]
  capacity int [not null]
  quant int [not null]
  buy_time_limit datetime
  max_time_in_line int [not null, default: 120]
  Note: '''
    Invariante protegida: 0 <= quant <= capacity.
    Reserva via UPDATE condicional atômico:
    UPDATE EventCap SET quant = quant - 1
      WHERE event_id = ? AND quant >= 1;
    rowcount = 0 => sem vaga. Sem lock aberto, sem retry.

    buy_time_limit: até quando o evento aceita compra (janela de venda).
    max_time_in_line: tempo máximo em segundos que uma reserva pode
    ficar no carrinho (WalletEvent.status = pending) antes de expirar
    automaticamente e a vaga voltar a ficar disponível. Fluxo detalhado
    em Architecture-Decision-Async-Checkout-Queue. (Divergência: aquela
    nota diz "só em modo de alta carga"; o código de 2026-09-01 faz
    TODA reserva em dois passos com expiração — reconciliar.)
  '''
}

Table MyWallet {
  user_id uuid [pk]
}

Table WalletEvent {
  user_id uuid [not null]
  event_id uuid [not null]
  status varchar [not null, default: 'confirmed']
  expires_at timestamp
  created_at timestamp [not null]
  indexes {
    (user_id, event_id) [pk]
  }
  Note: '''
    status: confirmed | pending | expired | cancelled.
    pending + expires_at => reserva feita em modo de alta carga,
    aguardando confirmação antes do prazo. Fora do modo de alta
    carga, nasce direto como confirmed (expires_at nulo).
    Só é inserida DEPOIS que o UPDATE em EventCap teve sucesso.
  '''
}

Ref: WalletEvent.user_id > MyWallet.user_id
Ref: WalletEvent.event_id > Event.event_id
Ref: Event.event_id - EventCap.event_id
Ref: User.user_id - MyWallet.user_id
Ref: User.user_id > Event.creator_id
Ref: Event.event_id > EventPresenter.event_id
```

## Decisões e correções em relação à versão inicial

- **`Event.creator_id` deixou de ser `unique`** e a ref virou `>` (1:N) — a versão anterior limitava cada usuário a criar um único evento na vida, o que contradiz o README (usuário cria vários eventos).
- **`EventPresenter` criada como tabela filha** — o README fala em `presenters` como lista (pode ser vazia); um `varchar` único (`participant`) não representa isso.
- **`Event` ganhou `image_data` e `updated_at`**, presentes no README e ausentes no schema original.
- **`User` ganhou `is_admin`, `is_active`, `updated_at`**; `email` virou `unique`; `fone` é **obrigatório** (`not null`) e `unique` (README: "obrigatório e único"). (Decisão do usuário em 2026-09-03, issue #7: `fone` não é opcional — o schema real, o `UserService.validateRequired` e o frontend já tratavam como obrigatório; a redação anterior desta ADR e do README, que diziam "opcional", é que estava errada.)
- **`birthdate` mudou de `datetime` pra `date`** — data de nascimento não tem hora.
- **`EventCap` documentada com a invariante `0 <= quant <= capacity`** e o padrão de `UPDATE` condicional (CAS) do [Backend-Architecture](./Backend-Architecture.md), já que DBML não tem `CHECK` nativo.
- **`WalletEvent` ganhou `status` e `created_at`** — sem isso não dava pra distinguir inscrição confirmada de uma reserva cancelada, nem auditar quando aconteceu.

## Decisão em aberto resolvida: `buy_time_limit`

O README trata `buy_time_limit` como campo de `Event` (default = mesma data do evento). Foi mantido em `EventCap` de propósito: junto de `capacity`/`quant`, forma uma única regra de negócio coesa ("posso vender?"), em vez de espalhar a lógica de reserva entre duas tabelas.

## `max_time_in_line` é um campo separado, não uma reutilização de `buy_time_limit`

Os dois parecem parecidos (ambos "tempo relacionado a compra"), mas são conceitos diferentes:

| Campo | O que é |
|---|---|
| `buy_time_limit` | Até quando o evento aceita compra — janela de venda (datetime absoluto). |
| `max_time_in_line` | Quanto tempo (segundos) uma reserva fica no carrinho (`WalletEvent.pending`) antes de expirar automaticamente e devolver a vaga. |

Fluxo completo da fila em [Architecture-Decision-Async-Checkout-Queue](./Architecture-Decision-Async-Checkout-Queue.md).

## Impacto de microsserviços + CQRS/ES no schema

Decidido em 2026-09-02 ([Architecture-Decision-Microservices-Split](./Architecture-Decision-Microservices-Split.md)). O schema deixa de ser
único; cada serviço é dono do seu:

| Serviço | Tabelas relacionais | Streams / projeções (ES) |
|---|---|---|
| `identity` | `user` (+ MFA, verificação) — **CRUD, não ES** | — (só emite eventos `UserRegistered`/`PasswordChanged` no backbone) |
| `catalog` | tabelas de leitura (read model) de `event`/`eventpresenter` | stream do agregado `Event` + tabela de snapshot |
| `reservation` | `eventcap` (+ CAS), `walletevent`, `mywallet` — **relacional/CAS** | stream do agregado pedido (`SlotReserved`/`ReservationConfirmed`/…) + snapshot + read model "minhas reservas" |
| `notification` | — | consumidor; sem agregado |
| `admission` | — (Redis) | — |

Mudanças de referência:
- **`event.creator_id` → `user.user_id` deixa de ser FK** (cross-service). Vira UUID solto;
  `creator_name` é composto no `gateway` ou projetado no `catalog` a partir de eventos do
  `identity`.
- `walletevent.event_id` → `event` também cruza serviço (`reservation` ↔ `catalog`): sem FK.
- Cada schema de serviço tem uma tabela de **event store** (`stream_id`, `version`,
  `event_type`, `payload`, `occurred_at`) com concorrência otimista por `version`, e uma
  tabela de **snapshot**.
- `SchemaValidationTest`/`GlobalDbTruncator` (hoje presos a `public`) passam a receber a
  lista de schemas alvo — issue #21 do [Roadmap-e-Issues](./Roadmap-e-Issues.md).

## Relacionado
- [_Event-Management-System](./visao-geral.md)
- [Backend-Architecture](./Backend-Architecture.md)
- [DDL realmente implementado (2026-09-01)](./Implementacao-EventCap-e-Reserva-CAS.md)
- [Schema-per-service + ES](./Architecture-Decision-Microservices-Split.md)
- [Roadmap-e-Issues](./Roadmap-e-Issues.md)
- [Versão generalizada da decisão de isolamento (marketplace)](./Architecture-Decision-Stock-Isolation.md)


---

*Sincronizado automaticamente de `Database-Schema.md` em 2026-10-30T19:11:52.867Z.*
