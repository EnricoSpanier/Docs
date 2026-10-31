---
sidebar_position: 999
tags: [plano, batches, roadmap, testes, prazo]
---

# Plano de 2 batches até 03–04/11

Plano para zerar as pendências de [Validacao-e-Pendencias-2026-10-26](./Validacao-e-Pendencias-2026-10-26.md) até o prazo de **03/11 ou 04/11**.
Substitui o cronograma antigo daquela nota. Estado de partida em [Roadmap-e-Issues](./Roadmap-e-Issues.md).

## O que significa "100%"

- **Backlog:** itens 35–48 (issues #36–#47, #111, #112), mais #45 (artigo), #46 (READMEs) e #15 (revisão da seção da Fase 2).
- **Follow-ups abertos:** #56, #57, #58, #59, #60, #61, #81, #84, #89, #113, #133.
- **Lacunas de teste:** suíte validada no `main`, roteiro manual de overselling com JWT, smokes #33/#35 executados e registrados, testes do Flutter, suíte de integração entre serviços.
- **Fora:** #16 (segredos), pulada pelo usuário em 2026-10-16.

## Regras de execução (do `CLAUDE.md` do repo)

- Toda issue passa pelo fluxo `/implement-issue` (gerador → revisor → validador), branch `Issue-N`, PR draft, gate das reviews do Copilot e do Gemini.
- Branch de integração `Fase_8` a partir do `main`; os PRs das issues entram nela. O merge para o `main` é sempre do usuário.
- Uma issue por vez: os testes compartilham o Postgres (`meu_banco`) e o Redpanda, então não rodam em paralelo.
- **Janela de carga:** as rodadas no gerador usam a stack do host; nenhum teste Maven roda no host durante a janela, e vice-versa.
- Tudo que muda o caminho quente de reserva entra por feature flag, desligada por padrão, para não invalidar números já medidos.

## Gate 0 — antes de tudo (26–27/10)

| Item | Detalhe |
|---|---|
| Docker Desktop | Travado por um `engine.sock` corrompido em `AppData\Local\docker-secrets-engine`. Reiniciar o PC ou apagar o arquivo (decisão do usuário) |
| Baseline | `Projeto/Backend/run-tests.sh` no `main` atual; registrar o resultado real |

## Batch 1 — Sistema distribuído completo e medido (27–31/10)

Objetivo: deixar o sistema final (com `identity` separado) correto, seguro, integrado e **medido**, com X definitivo e o comparativo das 3 configurações. Tudo que muda schema ou caminho quente entra **antes** da janela de carga.

| Ordem | Issue | Entrega | Critério de teste | Esforço |
|---|---|---|---|---|
| 1.1 | #56 | `updatePolicy` ilimitado → limitado não zera inscrições | Transição preserva reservas ativas; sem overselling sob concorrência | S |
| 1.2 | #57 | `userId` vem do JWT em `/bff/event-wallets*`, não do corpo | `HttpContractTest`: 403 ao reservar por outro usuário; front ajustado (3 lados) | S |
| 1.3 | #60 | `updateEvent` em uma transação | Teste de falha parcial: nada é commitado pela metade | S |
| 1.4 | #81, #133, #89 | Erro sem vazar `SQLException`; CORS centralizado sem `*` com credenciais; `/bff/seed` fechado fora de dev/test | Testes de contrato para cada um; `SeedDesligadoTest` mantido | S |
| 1.5 | #58, #59, #61 | Schema endurecido (timestamptz, índices de FK, CHECK); teste da migração `20260901` e `SchemaValidationTest` completo; N+1 do `hydrate` e `findExpiredPending` com LIMIT | Migration idempotente (2×), `verify-*-migration.sh`, suíte verde; sem regressão na carga | M |
| 1.6 | #36 | `identity` como serviço: schema próprio, emissão de JWT, validação stateless nos demais (JWKS ou segredo, decisão em ADR curta) | Login, cadastro, MFA, troca de senha ponta a ponta; JWT validado por cada serviço; smoke dedicado | L |
| 1.7 | #37 | Compose completo (`gateway`, `identity`, `catalog`, `reservation`, `notification`, backbone, Supabase) com healthchecks e `depends_on` | Suíte de integração: cadastro → criar evento → reservar → confirmar → e-mail, com replay; 2 smokes automatizados e registrados; roteiro de overselling com JWT | L |
| 1.8 | #38, #113 | Harness definitivo: leitura via projeção, `pg_stat_statements`, lag write→projeção e de consumer, métricas do pooler; escada com `MAPEAMENTO=intercalado` | Rodada curta de sanidade local antes da janela | M |
| 1.9 | #40, #39 | **Janela de carga 1** (usuário + gerador): matriz CAS × naive, leitura, escada no sistema final. Depois: X definitivo na ADR da fila e relatório das 3 configurações | Overselling 0 no CAS; CSVs versionados; ADR e relatório atualizados | M |

**Saída do Batch 1:** suíte Maven verde, integração ponta a ponta verde, `identity` separado, comparativo das 3 configurações com dados e X definitivo.

**Regra de corte:** se a #36 não estiver CONFORME até a noite de 29/10, descartar (manter `identity` no `gateway`) e seguir. A #37 então integra o que existe.

## Batch 2 — Alta carga, escala e fechamento (01–04/11)

Objetivo: implementar o que depende do X definitivo (`admission` e autoescala), a UI e fechar a documentação. Congelar o código em **03/11 às 18h**; 04/11 só documentação e ajustes.

| Ordem | Issue | Entrega | Critério de teste | Esforço |
|---|---|---|---|---|
| 2.1 | #41 | `admission` + contador RPM por evento em Redis (janela deslizante) | Contagem correta sob concorrência; expõe "RPM atual do evento X" | M |
| 2.2 | #42 | Fila de admissão (RabbitMQ, conforme a ADR) + pool de workers | Concorrência controlada; TTL e dead-letter | L |
| 2.3 | #43 | Modo de alta carga: uso ≥ 80% enfileira, &lt; 70% com fila vazia volta ao síncrono; `pending` + `expires_at` | Testes dos dois regimes e da histerese; flag desligada por padrão | L |
| 2.4 | #44, #84 | UI `pending` no Flutter (contagem regressiva, botão Confirmar, tela de espera); `analysis_options.yaml` com lints | Primeiros testes de widget do front; `flutter analyze` limpo | M |
| 2.5 | ADR + #111 | ADR do mecanismo de escala; `gateway` e `reservation` com N réplicas, sem estado em memória, job de expiração correto com 2+ réplicas | Teste com 2 réplicas: overselling 0, expiração sem duplicidade; conexões cabem no Supavisor | L |
| 2.6 | #112 | Mesma regra para `admission`, `identity`, `catalog`, `notification` (consumer group por lag) | Sem e-mail duplicado; réplicas idempotentes | L |
| 2.7 | — | **Janela de carga 2** (usuário + gerador): escada com `admission` e autoescala ligadas | Overselling 0; registro de réplicas × tempo | M |
| 2.8 | #45, #46, #15 | Material do artigo, READMEs (raiz, `Backend/`, `db/`, um por serviço), seção da Fase 2 revisada com o orientador | Revisão cruzada com os dados reais | M |
| 2.9 | #47 | Split `stock` + `wallet` com saga | **Stretch**: só se sobrar mais de 1 dia | L |

**Corte, na ordem em que eu cortaria:** #47 (declarar como trabalho futuro no artigo), depois #112, depois #111 reduzida a ADR + garantia de réplicas sem estado + um teste com `--scale`, depois a UI (#44).

## Cronograma

| Dia | Foco |
|---|---|
| 27/10 (ter) | Gate 0, 1.1, 1.2, 1.3 |
| 28/10 (qua) | 1.4, 1.5, início da #36 |
| 29/10 (qui) | Fim da #36 (decisão de corte à noite), início da #37 |
| 30/10 (sex) | Fim da #37, 1.8 (harness) |
| 31/10 (sáb) | Janela de carga 1, análise, #40 e #39 |
| 01/11 (dom) | #41, #42 |
| 02/11 (seg) | #43, início da #111 |
| 03/11 (ter) | #44, #84, #111, #112; janela de carga 2 à noite; código congelado às 18h |
| 04/11 (qua) | #45, #46, ajustes finais |

## Riscos

- **Batch 2 é apertado:** são cerca de 8 issues grandes em 4 dias. O ritmo real da Fase 7 foi uma issue grande por dia. 100% em 03/11 só se o Batch 1 fechar em 31/10; em 04/11 a chance é maior.
- **Docker:** sem ele nada é testado. Cada dia parado empurra o cronograma inteiro.
- **Gerador:** as duas janelas de carga dependem da 2ª máquina e do usuário presente (31/10 e 03/11).
- **Orientador:** pedir a revisão da #15 até 29/10 para não cair em cima do prazo.
- **Mudança no caminho quente** depois da janela 1 (admission, autoescala): mitigada por flag desligada por padrão e pela janela 2.

## Relacionado

- [Validacao-e-Pendencias-2026-10-26](./Validacao-e-Pendencias-2026-10-26.md)
- [Roadmap-e-Issues](./Roadmap-e-Issues.md)
- [Architecture-Decision-Async-Checkout-Queue](./Architecture-Decision-Async-Checkout-Queue.md)
- [Architecture-Decision-Microservices-Split](./Architecture-Decision-Microservices-Split.md)
- [_Event-Management-System](./visao-geral.md)

---

*Sincronizado automaticamente de `Plano-2-Batches-ate-04-11.md` em 2026-10-30T19:11:52.868Z.*
