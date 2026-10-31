---
sidebar_position: 4
sidebar_label: "ADR: Estoque Isolado"
tags: [architecture, decision, adr, marketplace, cqrs]
---

# Decisão de Arquitetura — Estoque/Capacidade Isolado num Marketplace

Este documento generaliza [Backend-Architecture](./Backend-Architecture.md) e [Database-Schema](./Database-Schema.md) pra fora do domínio de eventos: a estrutura vale pra qualquer marketplace onde exista um item vendável com quantidade limitada (produto físico, vaga de evento, assento, cota, crédito). O caso de eventos é só a primeira aplicação concreta — a estrutura de dados não deve depender dele.

## O problema, em termos genéricos de marketplace

Todo marketplace tem duas naturezas de dado bem diferentes:

1. **Catálogo e tudo em volta da transação** (listagens, avaliações, histórico, notificações, analytics) — lido com muito mais frequência do que é escrito, tolera alguns segundos de atraso, se beneficia de múltiplas views otimizadas por caso de uso.
2. **A quantidade disponível de um item específico** — uma única invariante numérica (`quantidade >= 0`) sob contenção real, onde dois compradores podem competir pela última unidade no mesmo milissegundo.

Tratar os dois com a mesma estratégia de consistência é o erro mais comum em sistemas desse tipo: forçar tudo pra eventual consistency gera *overselling* (venda além do disponível); forçar tudo pra consistência forte anula os ganhos de escala do resto do sistema.

## Estrutura escolhida

**Isolar o controle de quantidade como seu próprio agregado, com sua própria fronteira de consistência**, fora do event sourcing / fluxo assíncrono do resto do domínio.

```
Comprador ──(síncrono)──▶ Serviço de Estoque ──▶ reservado/recusado
                                │
                                ▼ (se reservado)
                     grava Order/Reservation
                                │
                                ▼
              Resto do sistema (assíncrono): notificação,
              faturamento, analytics, histórico
```

Mapeamento genérico → schema atual ([Database-Schema](./Database-Schema.md)) e serviço alvo ([Architecture-Decision-Microservices-Split](./Architecture-Decision-Microservices-Split.md)):

| Conceito genérico | Neste sistema | Serviço alvo |
|---|---|---|
| Listing (item vendável) | `Event` / `EventPresenter` | `catalog` (CQRS+ES) |
| Stock (quantidade controlada) | `EventCap` | `reservation` — parte relacional/CAS |
| Reserva/Pedido | `WalletEvent` | `reservation` — parte event-sourced |
| Comprador/Vendedor | `User` | `identity` (CRUD, emite eventos) |

O "Serviço de Estoque" genérico não vira um serviço isolado agora: capacidade e pedido ficam
juntos no `reservation` **híbrido** (CAS + ES no mesmo bounded context). O split em serviços
separados com saga é rodada futura — ver [Architecture-Decision-Microservices-Split](./Architecture-Decision-Microservices-Split.md).

A regra que protege a quantidade é um `UPDATE` condicional atômico (CAS a nível de linha), não um `SELECT` seguido de `UPDATE`:

```sql
UPDATE stock SET qty = qty - 1 WHERE item_id = ? AND qty >= 1;
-- rowcount = 0  →  sem estoque, resposta definitiva, sem retry
```

Esse é o mesmo padrão relatado por times de e-commerce que já sofreram com overselling em produção: ler o estoque e só depois decidir se escreve cria uma janela de corrida — dois compradores concorrentes podem ler a mesma quantidade disponível, os dois decidirem que podem prosseguir, e os dois escreverem, gerando uma venda que não deveria existir. A correção converge sempre pro mesmo ponto: transformar o "checar e reservar" numa única operação atômica no banco — via `UPDATE` condicional, `SELECT FOR UPDATE`, ou um script atômico equivalente.

## Vantagens

- **Elimina overselling estruturalmente**, não por sorte de timing — a checagem nunca passa por um read model eventual, vai direto na fonte de verdade no momento da decisão.
- **Cada parte do sistema usa a tecnologia de dado certa pro seu padrão de acesso.** É o princípio de *polyglot persistence*: nenhum banco único é bom em tudo, então cada serviço escolhe o motor que combina com sua carga — relacional pro estoque (transacional, contenção alta), o que for melhor pro catálogo/analytics (leitura pesada, tolera atraso).
- **Falha de um lado não contamina o outro.** Se o pipeline de eventos/analytics cair, a compra continua funcionando — a decisão de "tem ou não tem estoque" nunca dependeu dele.
- **Escala independente**: o catálogo pode escalar horizontalmente pra leitura sem nenhuma implicação na tabela de estoque, e vice-versa.
- **Padrão validado em produção** por empresas que passaram exatamente por esse problema, inclusive times que tentaram resolver estoque só com cache (Redis) e voltaram pro banco relacional como fonte de verdade, justamente pela dificuldade de manter reserva e confirmação atômicas entre dois sistemas diferentes.

## Desvantagens / custo real

- **Persistência poliglota tem custo operacional.** Mais de um motor de banco significa backup, monitoramento e expertise duplicados — é o trade-off mais citado contra essa abordagem, mesmo por quem a recomenda.
- **Sem join nativo entre estoque e o resto do domínio.** Uma consulta que numa base única seria um `JOIN` de microssegundos vira uma chamada de rede entre serviços, com latência variável e dependência de disponibilidade.
- **Acoplamento síncrono pontual.** O fluxo de compra depende de uma chamada síncrona ao serviço de estoque — é a única parte do sistema que não pode simplesmente "tentar de novo depois" sem impacto direto na experiência do comprador.
- **Reservas que não se confirmam precisam de expiração/limpeza.** Sem uma janela de TTL ou job de liberação, reservas abandonadas prendem estoque indefinidamente — é o efeito colateral mais citado desse desenho.

## Por que escolhemos seguir assim

A alternativa seria uma das duas pontas extremas, e as duas são piores pro nosso caso:

1. **Tudo em CQRS+ES com consistência eventual** — mais simples de operar (um modelo só), mas reintroduz exatamente o problema que estamos evitando: a checagem de estoque passaria por uma projeção que pode estar desatualizada, e a janela de overselling reaparece.
2. **Tudo em ACID forte / transação distribuída cobrindo o sistema inteiro** — eliminaria o problema de consistência, mas ao custo de coordenação pesada (2PC ou equivalente) sobre partes do domínio que não precisam disso (catálogo, notificação, analytics), anulando o motivo de ter escolhido uma arquitetura orientada a eventos pra começo de conversa.

Isolar só o agregado que realmente exige consistência forte — e deixar o resto livre pra ser assíncrono — é o meio-termo que aparece de forma consistente tanto na literatura de DDD/CQRS (agregados como fronteira natural de consistência) quanto nos relatos de engenharia de e-commerce que passaram por esse problema em produção. Um exemplo direto do mesmo racional aplicado a reserva de pedido: o estado da reserva só transiciona via `UPDATE` condicional guardado pelo próprio estado atual, seguindo a regra de que o primeiro escritor vence — é o mesmo padrão aplicado em `EventCap`, só que descrito por outro time, noutro domínio, chegando à mesma solução.

Esse desenho também não é exclusivo de estoque de produto físico — a literatura de CQRS trata reserva de estoque como um contexto delimitado (*bounded context*) próprio dentro de um domínio maior de pedidos, separado do contexto que lida com criação/cancelamento de pedido em si. É exatamente a divisão que fizemos entre `EventCap` e o resto do domínio.

## Quando isso deixa de valer a pena

Vale reavaliar esse desenho se, no futuro:
- O volume de contenção real for baixo o suficiente pra um simples `SELECT FOR UPDATE` dentro de uma transação convencional resolver sem gargalo perceptível — nesse caso a complexidade extra de manter dois modelos pode não se pagar.
- O domínio de estoque crescer a ponto de precisar de features que só um motor especializado oferece, como estratégias de uma-linha-por-unidade combinadas com `SKIP LOCKED` pra alta concorrência em itens de baixíssima quantidade — abordagem adotada por times que escalaram exatamente esse tipo de problema.

## Referências

Lista completa com tema e qual parte do projeto usa cada uma: [References](./References.md).


## Relacionado
- [_Event-Management-System](./visao-geral.md)
- [Backend-Architecture](./Backend-Architecture.md)
- [Realização concreta: serviços + escopo do ES](./Architecture-Decision-Microservices-Split.md)
- [Roadmap-e-Issues](./Roadmap-e-Issues.md)
- [Database-Schema](./Database-Schema.md)


---

*Sincronizado automaticamente de `Architecture-Decision-Stock-Isolation.md` em 2026-10-30T19:11:52.865Z.*
