# Ponto 3: sistema distribuído (Rodada 3, #34)

**Configuração:** `reservation` como serviço próprio atrás do `gateway`; a checagem de disponibilidade cruza a rede.

Mesmo protocolo dos pontos 1 e 2, agora com `reservation` e `notification` extraídos (Fase 7), no cabo e com o banco em SSD. CAS com overselling 0 em 20 de 20; o ingênuo oversella no teto. O limiar X ficou em torno de 58k RPM, contra 56k (Wi-Fi) e pelo menos 60k (cabo) do ponto 2 refeito no cabo (etapa `04b`). O aleatório de 45 min teve 0 erros, com p95 de reserva de 6,6 ms. Ressalvas: o Hikari do monólito, o pool HTTP e o timeout mudaram junto com a arquitetura. O `catalog` virou serviço depois (#35) e não entrou nessa rodada: o custo do salto extra só foi medido num A/B local sequencial (+1,0 ms na reserva com o cache de `exists` frio, +1,5 ms na busca de 10 eventos; a listagem de 1000 caiu 72% por tirar o `image_data` das listas, não pelo salto), sem rodada de carga.

Seção no artigo: [Ponto 3: distribuído](/testes/artigo/experimento-monolito#ponto-3-serviços-separados-rodada-3-2026-10-24).

## Páginas

- [Etapa 05: Fase 7 (serviços separados) — Rodada 3 (#34, ponto 3)](/testes/ponto-3/distribuido)
- [Etapa 06: Batch 1, configuração final distribuída — Rodada R](/testes/ponto-3/batch1-final)
