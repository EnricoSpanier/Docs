# Rodada 5: saga stock + wallet sobre a configuração da R4 (#180)

**Configuração:** Configuração da Rodada 4 mais a saga `stock` + `wallet` (serviço `stock` com hold e CAS, `reservation` orquestrador, compensação e reaper).

Mesma escada e mesmos parâmetros da Rodada 4; só a saga muda. Sem autoescala, ficou estável até 98k: 0 5xx, 0 órfãs, 0 compensações, e lag de devolução da vaga com p95 de 448 ms. O braço C parou em 44k (na R4, 38k), de novo pelo health check do `lb` (#207). O CAS manteve overselling 0.

## Páginas

- [Etapa 08: Rodada 5, saga stock + wallet sobre a configuração da R4 (issue #180)](/testes/rodada-5/rodada5-saga)
