# Autoescala em Kubernetes com o banco remoto (#228, #231, #237)

**Configuração:** A branch `K8s` (#197/#205) num cluster kind, com KEDA/HPA, trilhas de balanceamento e o banco no Dell.

Mesma escada da #227. K0 (banco no cluster): 1º degrau degradado em 26k. K1 (banco no Dell, sem autoescala): 1º degrau degradado em 32k, até 98k com 0 5xx. K2 (Istio e autoescala de 1 a 3): parou no 20k, pelo pool do `stock` com Hikari 60 por réplica (diagnóstico e teste A). A #231 voltou o `stock` a 1 réplica fixa com Hikari 245. O K2-repetição (sem a #231) e o K2-pos-231 (#237, com ela) pararam os dois no 32k. O limite provável, não isolado, é o lock da linha quente do `eventcap`. O CAS manteve overselling 0 em todos.

## Páginas

- [Etapa 10: a rodada da #227 no Kubernetes (K0, K1, K2), issue #228](/testes/k8s/k8s-db-remoto)
