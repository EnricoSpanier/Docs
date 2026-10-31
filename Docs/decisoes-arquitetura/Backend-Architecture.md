---
sidebar_position: 2
sidebar_label: "Arquitetura de Backend"
tags: [architecture, cqrs, event-sourcing, backend]
---

# Backend Architecture — CQRS + Event Sourcing com Estoque/Capacidade Isolados

## Problema que essa arquitetura resolve

CQRS + Event Sourcing (CQRS+ES) sobre um backbone de eventos (neste projeto: **Kafka-compatível — Kafka ou Redpanda**, ver [Architecture-Decision-Microservices-Split](./Architecture-Decision-Microservices-Split.md)) dá elasticidade e velocidade de escrita, mas a consistência forte só existe **dentro de um agregado/stream**. Controle de estoque/capacidade é o caso que quebra essa premissa: é uma invariante numérica (`quantidade >= 0`) sob contenção real no mesmo item, onde a consistência eventual entre escrita e projeções de leitura vira uma janela real de overselling.

A solução não é abandonar CQRS+ES nem forçar ACID distribuído sobre o sistema todo — é reconhecer que **estoque/capacidade é seu próprio agregado, com sua própria fronteira de consistência**, tratado fora do event sourcing.

## Princípio central

> Isolar o que exige consistência forte imediata (estoque/capacidade) do que se beneficia de elasticidade e auditoria assíncrona (o resto do domínio).

Não é uma exceção ao CAP/PACELC — é reconhecer que agregados diferentes podem ter fronteiras de consistência diferentes dentro do mesmo sistema.

## Estrutura

### 1. Serviço de Estoque/Capacidade (fora do Event Sourcing)
- Persistência relacional simples (Postgres) — **não event-sourced**.
- Reserva via `UPDATE` condicional atômico (CAS a nível de linha):
  ```sql
  UPDATE stock SET qty = qty - 1 WHERE sku = ? AND qty >= 1;
  ```
- Corretude garantida no próprio banco, sem lock aberto, sem retry — `rowcount = 0` já é a resposta definitiva ("sem estoque"/"sem vaga").
- Exposto como chamada síncrona request-response simples (API interna), não como parte do backbone de eventos.

### 2. Restante do domínio (CQRS+ES normal)
- Pedido, pagamento, notificação, histórico, analytics continuam 100% event-sourced.
- Escrita append-only, sem locks entre agregados, throughput alto.
- Múltiplas projeções de leitura otimizadas por caso de uso.
- Auditoria e replay nativos.

### 3. A ponte entre os dois mundos

```
Checkout ──(síncrono)──▶ Serviço de Estoque ──▶ reservado/recusado
                                │
                                ▼ (se reservado)
                        emite StockReserved / OrderPlaced
                                │
                                ▼
                 Backbone de Eventos (Kafka / Redpanda)
                                │
                  ┌─────────────┼─────────────┐
                  ▼             ▼             ▼
            Faturamento    Notificação    Analytics/Views
```

1. Checkout chama o Serviço de Estoque diretamente (síncrono) e recebe `reservado`/`recusado` na hora, sem esperar nenhuma projeção.
2. Só depois da confirmação, o sistema emite os eventos (`StockReserved`, `OrderPlaced`) no backbone.
3. O restante do sistema reage de forma assíncrona a partir daí.

## Por que funciona (e não é atalho)

- Não há ACID cross-agregado forçado — estoque decide sozinho, sem coordenação com o resto do sistema.
- O problema de "ler o próprio dado" desaparece pro estoque, porque a checagem nunca passa pelo read model eventual — vai direto na fonte de verdade.
- O resto do sistema mantém integralmente as vantagens do CQRS+ES: throughput de escrita alto, replay, auditoria, escala independente de leitura e escrita.

## Custo real

- **Persistência poliglota**: dois modelos coexistindo (relacional pro estoque/capacidade, event-sourced pro resto).
- **Acoplamento síncrono pontual**: o checkout depende de uma chamada síncrona ao serviço de estoque.

Custo menor do que impor ACID distribuído sobre todo o backbone, ou reintroduzir coordenação pesada (2PC, transações multi-stream) dentro do event sourcing.

## Generalização

Qualquer outra invariante numérica sob alta contenção (limite de crédito, cotas, assentos) segue o mesmo padrão: agregado isolado, CAS ou single-writer por partição, fora do event sourcing.

## Aplicação real neste sistema

O [Event Management System](./visao-geral.md) hoje é um monólito CRUD (Java/Spring Boot + Postgres, sem event sourcing), **em transição** para a arquitetura desta nota — ver [Architecture-Decision-Microservices-Split](./Architecture-Decision-Microservices-Split.md) e o roadmap em [Roadmap-e-Issues](./Roadmap-e-Issues.md). A **capacidade de ingressos por evento** é exatamente o caso de contenção que esse padrão resolve: `EventCap.quant` precisa da mesma garantia que `stock.qty` no exemplo acima.

### Como as três partes viram serviços concretos

| Parte desta nota | Serviço alvo (Opção B) |
|---|---|
| §1 Serviço de Estoque/Capacidade (relacional/CAS) | lado `eventcap` do serviço `reservation` — **não** event-sourced |
| §2 Restante do domínio (CQRS+ES) | `catalog` (ciclo de vida de evento) + lado wallet/order de `reservation` |
| §3 Ponte síncrona + backbone | `gateway` → API interna de `reservation` (síncrono) → append no stream → Kafka/Redpanda → `notification` e projeções |

`reservation` é portanto **híbrido**: CAS relacional para capacidade + stream event-sourced para o pedido, no mesmo bounded context. O split em `stock` + `wallet` separados (com saga) é rodada futura.

- `EventCap` foi isolado como tabela/agregado próprio (não misturado nos metadados de `Event`) — ver [Database-Schema](./Database-Schema.md).
- Reserva de vaga usa o mesmo `UPDATE` condicional:
  ```sql
  UPDATE EventCap SET quant = quant - 1
    WHERE event_id = ? AND quant >= 1;
  ```
- `WalletEvent` só é inserida **depois** que esse `UPDATE` teve sucesso — espelha o `StockReserved`/`OrderPlaced` do fluxo de checkout, mesmo sem um backbone de eventos de verdade rodando por trás.
- O `UPDATE` condicional isolado já resolve o overselling sem event sourcing — mas **o CQRS+ES completo faz parte da estrutura proposta no TCC e deve estar implementado antes do teste de carga** (revisão de 2026-09-02; ver [Architecture-Decision-Microservices-Split](./Architecture-Decision-Microservices-Split.md)). O ES cobre `catalog` e o lado wallet/order de `reservation`; `eventcap` permanece relacional/CAS — a coexistência dos dois modelos num único bounded context é justamente a tese.

## Relacionado
- [_Event-Management-System](./visao-geral.md)
- [Como isto vira microsserviços + o escopo do ES](./Architecture-Decision-Microservices-Split.md)
- [Roadmap / issues que implementam esta arquitetura](./Roadmap-e-Issues.md)
- [Versão generalizada desta decisão (marketplace)](./Architecture-Decision-Stock-Isolation.md)


---

*Sincronizado automaticamente de `Backend-Architecture.md` em 2026-10-30T19:11:52.866Z.*
