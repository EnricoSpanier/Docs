---
sidebar_position: 3
---

# Matriz CAS × ingênuo: resultados de 2026-10-16

Rodadas oficiais das issues #12 (braço CAS) e #13 (braço ingênuo). Capacidade de 20 vagas, 100% de
confirmação, Postgres com 300 conexões, commit `569d1be`. Fonte:
`Projeto/carga/results/02-hikari/matriz-prepooler-20261016.csv` (50 linhas; versionado em `1fbe12b` como
`matriz.csv`). Nenhuma repetição foi descartada. É a matriz **pré-pooler** (monólito + HikariCP); a repetição com o
pooler, o ponto 1 da série, está em
[Matriz CAS × ingênuo depois do pooler](/testes/ponto-1/resultados-matriz-pospooler-2026-10-16). Máquinas: ver
[Escada de degraus: resultados de 2026-10-16](/testes/pre-serie/resultados-escada-2026-10-16).

## Resumo

- **CAS: overselling 0 nas 10 execuções.** Exatamente 20 confirmadas em todas, nenhuma a mais.
- **Ingênuo: overselling máximo nas 40 execuções**, em todos os lags. Todos os clientes são aceitos: 80 a
  mais com N = 100 e 180 com N = 200.
- **O overselling não cresce com o lag nesta faixa.** A rajada dura ~0,1 a 0,2 s, menos que qualquer ciclo
  de refresh, então o read model nunca mostra a lotação durante a rajada.

## Braço CAS (#12)

| N | Execuções | `confirmed` | `oversell` | p95 da reserva, média (mín–máx) |
|---|---|---|---|---|
| 100 | 5 | 20 em todas | 0 | 53,7 ms (46,9–66,3) |
| 200 | 5 | 20 em todas | 0 | 77,1 ms (64,5–86,2) |

## Braço ingênuo (#13)

| Lag configurado (ms) | N | `oversell` (5 execuções) | Lag observado médio (ms) | p95 da reserva, média |
|---|---|---|---|---|
| 500 | 100 | 80 em todas | 1714 | 102,8 ms |
| 500 | 200 | 180 em todas | 1470 | 118,1 ms |
| 2000 | 100 | 80 em todas | 2408 | 95,2 ms |
| 2000 | 200 | 180 em todas | 2678 | 111,3 ms |
| 5000 | 100 | 80 em todas | 3620 | 92,3 ms |
| 5000 | 200 | 180 em todas | 3344 | 121,3 ms |
| 10000 | 100 | 80 em todas | 5541 | 95,9 ms |
| 10000 | 200 | 180 em todas | 6337 | 115,7 ms |

## Cuidados na leitura

- **Lag observado acima do configurado no lag de 500 ms.** O job de refresh recalcula todos os eventos, e o
  banco do host tinha ~35 mil eventos e ~2 milhões de reservas acumulados dos testes do dia. Cada refresh
  demorou mais, e o ciclo real ficou em lag + duração do refresh. Nos lags maiores, o valor médio fica perto da
  metade do lag, como esperado para um disparo em fase aleatória do ciclo.
- **Para ver a curva subir com o lag**, seria preciso um lag menor que a rajada ou rajadas espalhadas no tempo.
  Não foi testado.
