---
sidebar_position: 1
sidebar_label: "Visão geral"
---

# Testes

A série do experimento roda o mesmo protocolo (matriz CAS × ingênuo para o overselling e escada de carga para o limiar X) em três configurações da arquitetura. As Rodadas 4 e 5 vêm depois da série e medem, sobre a configuração final, a camada de alta carga (`admission` e autoescala) e a saga `stock` + `wallet`. Cada ponto e cada rodada tem a própria seção, com as etapas de `Projeto/carga/results/` e os relatórios dela.

| Grupo | Configuração | Issue | Situação |
|---|---|---|---|
| [Referência pré-série](/testes/pre-serie) | Monólito CRUD, Postgres direto (sem pooler), read model com lag sintético | #12–#14 | feito (referência) |
| [Ponto 1: monólito CRUD](/testes/ponto-1) | Monólito CRUD, Supabase Postgres + Supavisor (Fase 4), read model com lag sintético | #22 | feito |
| [Ponto 2: monólito CQRS + ES](/testes/ponto-2) | Monólito modular, `catalog` e wallet de `reservation` event-sourced, Redpanda; o ingênuo lê a projeção real | #31 | feito |
| [Ponto 3: distribuído](/testes/ponto-3) | `reservation` como serviço próprio atrás do `gateway`; a checagem de disponibilidade cruza a rede | #34 | feito |
| [Rodada 4: admission](/testes/rodada-4) | Configuração da etapa 06 mais o `admission` (contador no Redis, fila RabbitMQ, gatilho 80/70, 202) e a autoescala por compose + HAProxy | #179 | feito |
| [Rodada 5: saga](/testes/rodada-5) | Configuração da Rodada 4 mais a saga `stock` + `wallet` (serviço `stock` com hold e CAS, `reservation` orquestrador, compensação e reaper) | #180 | feito |

O que vale para todos os pontos fica em [Método e ferramentas](/testes/metodo/setup) (setup do gerador, tipos de teste, harness e testes manuais). A seção do artigo está em [Artigo](/testes/artigo/experimento-monolito), e o índice das etapas em [Índice das etapas](/testes/etapas).
