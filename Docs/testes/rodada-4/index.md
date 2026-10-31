# Rodada 4: admission acima do X, com e sem autoescala (#179)

**Configuração:** Configuração da etapa 06 mais o `admission` (contador no Redis, fila RabbitMQ, gatilho 80/70, 202) e a autoescala por compose + HAProxy.

Escada sequencial de 20k a 98k RPM, nos dois braços. Sem autoescala, ficou estável até 98k (0 5xx, a fila drenando) e o CAS manteve overselling 0. O braço C (com autoescala) parou em 32k e em 38k, pelos 5xx do health check do `lb` (#207).

## Páginas

- [Etapa 07: Rodada 4, admission acima do X, com e sem autoescala (issue #179)](/testes/rodada-4/rodada4-admission)
