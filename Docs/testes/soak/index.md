# Teste longo: 2 h com picos e vales por serviço (#232)

**Configuração:** O cluster Kubernetes (trilha b1, banco no Dell) com os 5 tipos de carga e o Mailpit no lugar do SMTP.

Blocos de 2 h com picos e vales aleatórios de leitura, reserva, login, cadastro e escrita no catálogo. S1 (X = 56k, sem fila): aprovado, com 0 5xx, overselling 0 e 1 e-mail por cadastro (37.253 de 37.253). S2 (X = 4k, com fila): REPROVADO no critério de 5xx por 12 respostas 503 na consulta da fila num minuto de pico (causa provável, não provada: timeout do Redis no `admission`), aceito sem re-teste; o resto passou, e o overselling 0 dele foi conferido, mas não estressado. Antes, o 1º S2 tinha reprovado por e-mails duplicados e pelo `admission` com 1 pod nas rampas; as duas causas foram corrigidas (correção no harness e a #235).

## Páginas

- [11-soak — teste longo (issue #232)](/testes/soak/soak)
