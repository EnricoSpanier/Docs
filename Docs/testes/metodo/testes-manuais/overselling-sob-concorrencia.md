# Teste manual — overselling sob concorrência (EventCap/CAS)

**Issue:** #9 (Fase 1, fechada — PR #73) · **Área:** `backend` · **Depende de:** #5, #6 (código EventCap/CAS já compila e passa na suíte)

> **Atualização (2026-10-02) — leia antes de rodar.** Este roteiro foi escrito em 2026-09-03,
> **antes** da PR #79 (issue #78), que tornou `/bff/**` *deny-by-default*. Hoje só são públicos:
> `POST /bff/users/login`, o cadastro em duas fases, `GET /bff/events/**`, `POST /bff/seed` e
> `GET /actuator/health` (público desde a issue #92 / PR #93). Todo o resto — inclusive
> `POST /bff/users`, `/bff/my-wallets/**`, `POST /bff/events` e `/bff/event-wallets/**` — exige
> `Authorization: Bearer <jwt>`, e criar evento exige usuário `host`.
>
> **O `.sh` ainda não foi adaptado** (pela leitura: ele não envia JWT, então os passos 2–5
> devolveriam 401; não o executei após a #79). O que o roteiro **prova** não mudou (CAS impede
> overselling com `capacity = 1`), só o jeito de montar a fixture: criar usuários e evento por
> `POST /bff/seed` (público), fazer `POST /bff/users/login` para obter o token e usá-lo na
> reserva — o mesmo caminho do kit `Projeto/carga` e do harness `docs/carga/harness/`. Adaptar o
> `.sh` está pendente. Para N clientes e métricas de desempenho, use o harness (issue #11) e o kit
> de carga (`Projeto/carga/README.md`); este roteiro continua sendo o sanity mínimo com 2 usuários.

## Objetivo

Demonstrar, **no nível HTTP e sob concorrência real**, que o caminho de reserva
`EventCap` + reserva por `UPDATE` condicional atômico (CAS) **não permite overselling**:
com um evento de **`capacity = 1`**, duas reservas quase simultâneas de usuários
distintos resultam em **exatamente uma** vaga concedida e **exatamente uma** recusa
com `Evento lotado`.

Este é um **roteiro de sanity manual**. Não altera nenhum código de produção.

### Cobertura automatizada equivalente

A mesma garantia, no nível de serviço e **em processo** (com `CyclicBarrier`), já é
coberta por testes automatizados — este roteiro é a checagem ponta a ponta no
transporte HTTP, complementar, não substituta:

- `EventWalletTest.testEventoLotado` — a segunda inscrição num evento `capacity = 1`
  recebe `Evento lotado` e `eventcap.quant` fica em `0`.
- `EventWalletTest.testRemoveLinkConcorrenteNaoCausaOverselling` — duas remoções
  concorrentes do mesmo vínculo (barreira real) devolvem no máximo 1 vaga.

Arquivo: `Projeto/Backend/monolito/src/test/java/com/gerenciador/eventos/EventWalletTest.java`.

## Pré-requisitos

- Docker Desktop com a stack no ar:
  ```bash
  docker compose -f Projeto/docker-compose.yml up -d --build db backend
  ```
  Backend em `http://localhost:8081`; Postgres no host em `localhost:5433`
  (container `gerenciador-db`).
- `Projeto/.env` presente (credenciais do banco — lido pelo `docker compose`).
  O script **não** lê nem imprime segredos: usa `$POSTGRES_USER` / `$POSTGRES_DB`
  de dentro do container.
- Shell bash. Funciona em Linux/macOS e no **Git Bash** do Windows (mesmo espírito
  de `Projeto/Backend/run-tests.sh`). Não há variante `.ps1`.

## Correções ao texto da issue

| Texto da issue | Valor real usado aqui |
|---|---|
| `POST /api/bff/event-wallets` | **`POST /bff/event-wallets`** — o prefixo `/api/` é removido pelo nginx do frontend; em acesso direto ao backend use o path real. Quando o roteiro foi escrito, `/bff/**` era `permitAll()` (sem JWT); **desde a PR #79 é deny-by-default** (ver a atualização no topo). |
| corpo do POST de reserva | `{"userId": <id>, "eventId": <id>}` |
| status da recusa | **HTTP 400** (o `BffEventWalletController` traduz `IllegalArgumentException` para `badRequest`); corpo = texto puro `Evento lotado`. |

> **Nota:** desde a **issue #57** o `userId` vem do JWT; um `userId` no corpo diferente do dono do
> token dá **403**. Este roteiro já não roda desde a #78/#79 (cria usuário sem JWT).

## Como executar

```bash
docs/testes-manuais/overselling-sob-concorrencia.sh
```

O script executa o roteiro ponta a ponta e **sai com código ≠ 0 se houver
overselling** (ou qualquer assinatura de falha). Ele **É o teste**: as asserções de
resultado esperado são a fonte de verdade.

Variáveis de ambiente (todas opcionais):

| Variável | Default | Para quê |
|---|---|---|
| `BASE_URL` | `http://localhost:8081` | URL do backend |
| `CONTAINER_DB` | `gerenciador-db` | container do Postgres |
| `CAPACIDADE` | `1` | capacidade do lote do evento-fixture |
| `MANTER_DADOS` | `0` | `1` = não remove os dados criados ao final |

### Reprodutibilidade

- E-mails, telefones e `event_name` recebem um **sufixo único por execução**
  (`timestamp-PID`). `users.email`/`users.fone`/`users.user_name` e
  `event.event_name` são `UNIQUE` e o backend rejeita duplicados — sem o sufixo a
  segunda execução falharia em "já existente".
- O script tem **rotina de limpeza** no `trap EXIT`: remove `reservation.walletevent` e
  `stock.eventcap` (do serviço `reservation`, sem FK desde a #33) → `catalog.event` → `identity.users`
  (o `mywallet` cai por `CASCADE`). As queries do roteiro leem `stock.eventcap` e `reservation.walletevent`.
- Roda **duas vezes seguidas** sem falhar (verificado).
- Limpeza manual alternativa:
  ```bash
  docker compose -f Projeto/docker-compose.yml down -v   # zera o volume do banco
  ```

## O roteiro, passo a passo

1. **Espera o backend** responder (`GET /bff/events` → 200; `/actuator/health`
   devolvia 403 quando o roteiro foi escrito; é público desde a issue #92 e também serve de probe).
2. **Cria 2 usuários distintos** (`POST /bff/users`, corpo mínimo
   `{"name","email","fone"}` — o que `UserService.createUser` exige) e **garante a
   carteira** de cada um (`POST /bff/my-wallets/ensure/{userId}`).
   - *Por que 2 usuários:* `addLink` checa `existsActive(userId, eventId)` **antes**
     do CAS. O mesmo usuário duas vezes daria `Vínculo já existente`, não
     `Evento lotado` — não provaria nada.
   - *Sobre a carteira:* o trigger `trigger_create_wallet` já cria a linha em
     `mywallet` no INSERT do usuário, então o `ensure` é **redundante**; é mantido
     porque é idempotente e o roteiro da issue pede explicitamente.
3. **Cria 1 evento** com `lot_quantity = 1` (`POST /bff/events`). Corpo mínimo:
   `creator_id`, `event_name`, `is_EAD`, `event_date` (futuro), `description`,
   `lot_quantity`, e **`presenters: []`** — `null` é rejeitado por
   `validateEventBasic` ("Lista de apresentadores não pode ser nula").
   `lot_quantity: 1` ⇒ `eventcap` com `capacity = 1`, `quant = 1`.
4. **Dispara as 2 reservas concorrentes**: dois `curl` em background (`&`) a partir
   de um ponto comum, coletando os dois status codes e corpos.
5. **Lê o estado do banco** (impresso **antes** da limpeza).
6. **Assere.**

## Resultado esperado

Das duas requisições concorrentes:

- **Exatamente uma** `201 Created` com corpo contendo `"status":"pending"`.
- **Exatamente uma** `400 Bad Request` com corpo `Evento lotado`.

**Invariante de estado** (é isto que realmente prova o no-overselling — dois `curl`
"simultâneos" ainda saem com milissegundos de diferença, e um par serializado
produziria o mesmo par 201/400):

- `SELECT quant FROM stock.eventcap WHERE event_id = <id>` → **`0`** (nunca negativo).
- Exatamente **1** linha em `reservation.walletevent` com `status = 'pending'` para o evento.

> **Qual asserção realmente discrimina:** com um fixture de `capacity = 2` (rode
> `CAPACIDADE=2`), as duas reservas passam e `quant` **ainda assim termina em `0`** —
> ou seja, `quant = 0` sozinho **não** prova ausência de overselling. O que prova é
> **o par de status (1×201 / 1×400)** somado a **exatamente 1 linha `pending`**. Por
> isso o script fixa as asserções no cenário `capacity = 1` da issue.

### Assinatura de falha (o que o roteiro pegaria num caminho quebrado)

| Sintoma | Significado |
|---|---|
| **duas** respostas `201` / `"status":"pending"` | overselling no nível HTTP |
| `walletevent` com **> 1** linha `pending` para o evento | overselling no estado |
| `eventcap.quant` **negativo** | `UPDATE` condicional (CAS) sem o guard `quant >= 1` |
| **HTTP 500** no lugar de `400 Evento lotado` | o `CHECK eventcap_quant_bounds` disparou no banco — gravar `quant = -1` é impossível, então uma falha do CAS aparece como erro 500, não como valor negativo na tabela |

## Aviso — job de expiração

`eventcap.max_time_in_line` tem default **120s** e o `ReservationExpiryService`
roda a cada **~30s** (`reservation.expiry.scan.ms`). Se passar mais de ~2 min entre
a reserva e a conferência do estado, a vaga **volta** (`quant` volta a `1`) e a
linha `pending` vira `expired`. **Rode a verificação logo após o disparo** — o
script já faz isso (lê o banco imediatamente após o `wait` dos dois `curl`).

## Execução de referência (2026-09-03, stack real)

```
--------------------------------------------------
   ESTADO OBSERVADO
--------------------------------------------------
   resposta u1 .....: HTTP 201 | corpo: {"status":"pending",...,"userId":5,"eventId":2}
   resposta u2 .....: HTTP 400 | corpo: Evento lotado
   eventcap.quant ..: 0
   walletevent pending .......: 1
   walletevent ativos (p+c) ..: 1
--------------------------------------------------
   [ok]    exatamente 1 resposta 201 'pending'
   [ok]    exatamente 1 resposta 400 'Evento lotado'
   [ok]    eventcap.quant = 0
   [ok]    exatamente 1 walletevent pending
   RESULTADO: OK -- sem overselling.
```

Validação red→green do próprio roteiro: `CAPACIDADE=2` → 3 asserções falham
(2×201, 0×`Evento lotado`, 2 linhas `pending`), `exit 1`; `CAPACIDADE=1` (default)
→ todas passam, `exit 0`.
