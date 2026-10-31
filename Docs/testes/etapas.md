---
sidebar_label: "Índice das etapas"
sidebar_position: 20
---

# Resultados de carga

Uma pasta por etapa da arquitetura. O `README.md` de cada uma diz o que estava implementado.

| Etapa | O que estava implementado | Período |
|---|---|---|
| [`01-sem-pool/`](/testes/pre-serie/sem-pool) | Monólito sem pool: uma conexão nova por operação (`DriverManager`), PG 16 direto. Números invalidados (#96) | 2026-10-04, manhã |
| [`02-hikari/`](/testes/pre-serie/hikari) | Monólito + HikariCP (pool de 1000), PG 16 direto, sem pooler | 2026-10-04 (tarde) a 2026-10-16 |
| [`03-supabase-pooler/`](/testes/ponto-1/supabase-pooler) | `supabase/postgres` 17.6 + Supavisor em transaction mode | a partir de 2026-10-16 |
| [`04-fase6-es/`](/testes/ponto-2/fase6-es) | Monólito modular com `catalog` e `reservation` (lado wallet) em CQRS + Event Sourcing, Redpanda, relay e consumer no processo. Rodada 2, Wi-Fi | 2026-10-19 |
| [`04b-fase6-es-cabo/`](/testes/ponto-2/04b-fase6-es-cabo) | O mesmo código do 04 refeito no cabo, com Docker em SSD (controle da Rodada 3) | 2026-10-24 |
| [`05-distribuido/`](/testes/ponto-3/distribuido) | Fase 7: `reservation` e `notification` como serviços; `gateway` chama o `reservation` por HTTP. Rodada 3, cabo, SSD | 2026-10-24 |
| [`06-batch1-final/`](/testes/ponto-3/batch1-final) | Batch 1 (`b072346`): `notification`, `reservation`, `catalog` e `identity` como serviços, `gateway` só roteia e valida o JWT pelo JWKS; harness da #38 (escada `sequencial` e `intercalado`). Rodada R, cabo, SSD | 2026-10-28 |
| [`07-rodada4-admission/`](/testes/rodada-4/rodada4-admission) | Batch 2 (`35955ef`): `admission` (#41–#43: contador no Redis, fila RabbitMQ, gatilho 80/70, 202) e autoescala (#111/#112: override + HAProxy + scaler), imagens slim (#177), kit da #178. Rodada 4: sem autoescala estável até 98k (0 5xx, fila drenando), braço C parado em 32k/38k pelo health check do `lb` (#207); CAS 0 | 2026-10-29 |
| [`08-rodada5-saga/`](/testes/rodada-5/rodada5-saga) | Batch 2 (`850d38e`): a configuração da 07 mais a saga `stock` + `wallet` (#47: serviço `stock` com hold + CAS, `reservation` orquestrador, compensação inline e reaper) e o kit da #204. Rodada 5: sem autoescala estável até 98k (0 5xx, 0 órfãs, 0 compensações, lag de devolução p95 448 ms), braço C parado em 44k (R4: 38k) pelo health check do `lb` (#207); CAS 0 | 2026-10-29 e 2026-10-30 |

A comparação lado a lado das 3 configurações (tabela e gráficos) está na subseção "Comparação das 3 configurações (issue #39)" de [`docs/artigo/experimento-monolito.md`](/testes/artigo/experimento-monolito).

A análise das rodadas de 2026-10-04 (antes e depois do pool) está em [`02-hikari/ANALISE.md`](/testes/pre-serie/analise).

## Regra

- **A rodada corrente grava aqui na raiz.** Os scripts de `Projeto/carga` usam `results/` fixo: `matriz.csv`,
  `degraus-<id>.csv`, `summary-*.json`, `resultados*.csv`, `verificacoes.log` e `baseline-*.txt`.
- **Ao fechar uma etapa, mova os arquivos dela para a pasta da etapa** com `git mv` e atualize o README da etapa.
  Ajuste também as citações em `docs/` que apontam para o arquivo.
- Mova só resultados (CSV, `summary-*.json`, `perfil-*.json`, logs, `baseline-*.txt`). **Nunca mova
  `users-*.json` nem `events-*.json`**: eles têm credenciais de teste, e mesmo com o `.gitignore` cobrindo `results/**`, não os mova de propósito.
