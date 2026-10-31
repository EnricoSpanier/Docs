---
sidebar_position: 2
---

# Escada de degraus: resultados de 2026-10-16

Rodada da issue #14 (limiar X), braço `cas`, com o host e o gerador descritos abaixo. É o X **pré-pooler**; a escada pelo
pooler (X ≈ 78k RPM) está em [Isolamento do pooler e escada X pelo pooler](/testes/ponto-1/resultados-isolamento-escada-pospooler-2026-10-17). Os números vêm
dos CSVs em `Projeto/carga/results/02-hikari/` (commit `5caac91` na branch `Fase_2`). O texto do artigo, com as
ameaças à validade, está em `docs/artigo/experimento-monolito.md`, seção "Limiar X".

## Resumo

- **X de um evento disputado ≈ 97.000 RPM** (~1650 reservas/s). O último degrau limpo é 96k.
- **O host nunca respondeu 5xx.** Quando satura, ele fica lento: o p95 por janela de 30 s passa de 1 s.
- **O teto é a linha do `eventcap`, não a máquina.** A escada manda 200 reservas seguidas para o mesmo
  evento, e o `UPDATE` do CAS nessa linha se serializa. Com a carga espalhada entre eventos, o host
  sustentou **140k RPM** limpo.
- **Mais conexões e mais threads não ajudam.** Postgres com 100 → 1000 conexões e Tomcat com 200 → 400
  threads deixaram o teto igual e aumentaram a latência.
- **Com 60% de confirmação** (versão realista), o host passa no X (p95 de ~216 ms em 97k).

## Máquinas

| | Host (alvo) | Gerador (k6) |
|---|---|---|
| CPU | Ryzen 7 7700X, 8 núcleos / 16 threads | Ryzen 5 7600, 6 núcleos / 6 threads |
| RAM | 63 GB (31 GB para o Docker) | 15,2 GB |
| Rede | 1 Gbps, cabo | 1 Gbps, cabo |
| Software | Docker 29.8.2, Java 25, PostgreSQL 16.15, HikariCP 6.3.3 | k6 v2.2.0 |
| Configuração | `cas`, refresh de 5000 ms, Hikari 1000, Tomcat com 200 threads | até 3000 VUs pré-alocados |

## Escadas

| Escada | Faixa (RPM) | VUs | Conexões no Postgres | Resultado |
|---|---|---|---|---|
| `953959` | 12k → 40k (protocolo) | 2000 | 100 | X > 40k, sem nenhuma falha |
| `954833` | 50k → 120k | 2000 | 100 | limitada pelo **gerador** (portas do Windows) a partir de 60k |
| `956799` | 60k → 130k | 3000 | 100 | **X = 100k**; efetivo estaciona em ~97–99,8k |
| `958305` | 95k → 100k, passo 1k | 3000 | 100 | **X = 97k**; 96k limpo |
| `959190` | 96k → 97k, 60% de confirmação | 3000 | 100 | passa: X > 97k |
| `959765` | 60k → 130k | 3000 | 1000 | X = 100k; efetivo de ~94–95k |
| `962591` | 95k (diagnóstico) | 3000 | 1000 | Tomcat com 400 threads: p95 de 582 ms (contra 242 ms) |
| `963487` | 100k → 160k, eventos intercalados | 3000 | 1000 | **120k e 140k limpos**; 160k limitado pelo gerador |

Escadas interrompidas, sem dados: 4000 VUs (faltou memória no gerador), 400 threads de 90k a 160k
(processo encerrado por memória), realista de 100k a 120k e escada com 300 conexões (paradas pelo
usuário).

## Onde o host satura (`956799`)

| RPM alvo | RPM efetivo | p95 (ms) | Pior janela de 30 s (ms) | Descartes |
|---|---|---|---|---|
| 90.000 | 90.001 | 221,6 | 235,5 | 0 |
| 100.000 | 99.033 | 1315,9 | 1339,8 | 967 |
| 110.000 | 99.784 | 1351,8 | 1369,8 | 10.218 |
| 120.000 | 97.156 | 1405,7 | 1406,6 | 22.845 |
| 130.000 | 98.139 | 1396,5 | 1422,1 | 31.862 |

O RPM efetivo para de subir em ~99k. Os descartes vêm da lentidão do host: com os VUs pré-alocados, o
k6 só descarta quando todos estão ocupados esperando resposta.

## Evento disputado × carga espalhada

| RPM | Sequencial, mesmo evento (`959765`) | Intercalado, eventos diferentes (`963487`) |
|---|---|---|
| 100k | 94.533 efetivo, p95 de 1463 ms | 99.569 efetivo, p95 de 887 ms |
| 120k | 95.271 efetivo, p95 de 1460 ms | **120.001 efetivo, p95 de 317 ms** |
| 140k | — | **140.001 efetivo, p95 de 263 ms** |

Esperas no Postgres durante a carga (amostras de `pg_stat_activity`):

| Espera | Sequencial | Intercalado |
|---|---|---|
| Lock de linha (`transactionid`, `tuple`, `LockManager`) | ~370 sessões | 0 |
| Escrita do WAL (`WALWrite`, `WALSync`) | — | 3 a 11 sessões |

A rodada intercalada usou o script do k6 editado só no gerador e revertido depois. A opção oficial é a
issue #113.

## Lições para as próximas rodadas

- O `make setup-host` sobe o Postgres com **100 conexões**. Para outro valor, use
  `make host-rpm MAX_CONN=<n>` e confira com `SHOW max_connections`: a coluna `max_connections` do CSV é
  só um rótulo.
- Acima de ~60k RPM, o gerador Windows esgota as portas efêmeras. Amplie como admin:
  `netsh int ipv4 set dynamicport tcp start=10000 num=55535` (padrão: `start=49152 num=16384`).
- 3000 VUs couberam em 16 GB de RAM; 4000 não.
- Acima de ~140k RPM com a carga espalhada, é preciso um segundo gerador.
