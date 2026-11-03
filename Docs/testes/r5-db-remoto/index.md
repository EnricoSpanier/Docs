# R5 com o Postgres numa máquina dedicada (#227)

**Configuração:** O código e as imagens da Rodada 5, com só o `db` num Dell dedicado (pooler e serviços no host).

Braço base da R5, com o banco fora do host. Ficou estável até 98k: 0 5xx, 0 órfãs, 0 compensações e CAS com overselling 0. O 1º degrau degradou em 32k (na R5, 38k), o p95 de janela de 50k a 98k foi de 0,27 a 0,47 s (na R5, 0,27 a 0,87 s) e o lag de devolução da vaga teve p95 de 640 ms (na R5, 448 ms). O Dell não saturou (CPU média de até 43%); o host ficou no teto de CPU.

## Páginas

- [Etapa 09: R5-db-remoto, braço base da R5 com o Postgres numa máquina dedicada (issue #227)](/testes/r5-db-remoto/r5-db-remoto)
