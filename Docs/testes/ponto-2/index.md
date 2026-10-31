# Ponto 2: monólito CQRS + Event Sourcing (Rodada 2, #31)

**Configuração:** Monólito modular, `catalog` e wallet de `reservation` event-sourced, Redpanda; o ingênuo lê a projeção real.

Mesmo protocolo do ponto 1, agora com a Fase 6. O braço ingênuo lê a projeção alimentada pelo consumer do tópico: o lag é medido, não controlado. O limiar X é medido por camada (append + relay, consumer).

Seção no artigo: [Ponto 2: monólito CQRS + ES](/testes/artigo/experimento-monolito#ponto-2-cqrs--es-no-monólito-rodada-2-2026-10-19).

## Páginas

- [Etapa 04: Fase 6 (CQRS + Event Sourcing) — Rodada 2 (#31)](/testes/ponto-2/fase6-es)
- [Etapa 04b: ponto 2 refeito no cabo (controle da Rodada 3)](/testes/ponto-2/04b-fase6-es-cabo)
