---
sidebar_position: 1
---

# Tipos de teste

Catálogo de todos os testes do Gerenciador de Eventos: o que cada um mede, como rodar e como ler
o resultado. Os comandos de carga rodam no **gerador**, em `Projeto/carga` (`make help` lista
tudo). O passo a passo completo, com colunas de CSV e códigos de saída, está em
`Projeto/carga/README.md`.

## Visão geral

| Teste | Pergunta que responde | Comando (gerador) | Saída |
|---|---|---|---|
| [Disputa](#1-disputa-de-vagas) | O sistema vende além da capacidade quando muitos disputam poucas vagas? | `make test-disputa` | `results/resultados.csv` |
| [RPM](#2-taxa-fixa-rpm) | Uma taxa constante de reservas é sustentada sem erro? | `make test-rpm` | `results/resultados-rpm.csv` |
| [Aleatório](#3-carga-aleatória) | O sistema se mantém estável com carga variável e leituras misturadas? | `make test-aleatorio` | `results/resultados-aleatorio.csv` |
| [Matriz](#4-matriz-do-experimento-cas--naive) | Quanto o caminho ingênuo vende a mais, por lag, contra o CAS? | `make test-matriz-cas` / `make test-matriz-naive` | `results/matriz.csv` |
| [Degraus](#5-escada-de-degraus-limiar-x) | Qual é o limite X de RPM que o host aguenta? | `make test-degraus` | `results/degraus-<id>.csv` |
| [Versão realista](#versão-realista-60-de-confirmação) | Como o resultado muda se só parte das reservas é paga? | `*-real` ou `PCT_CONFIRMA=60` | mesmos CSVs |
| [Suíte automatizada](#suíte-automatizada-do-backend) | O código está correto (regras, schema, contrato HTTP)? | `Projeto/Backend/run-tests.sh` | saída do Maven |
| [Manuais](#testes-manuais) | O fluxo funciona de ponta a ponta na stack real? | roteiros em `docs/testes-manuais` | anotações do roteiro |

## Como a carga é gerada

- **Duas máquinas.** O **host** roda a stack (backend `:8081`, Postgres `:5433`); o **gerador**
  roda o [k6](https://k6.io). O k6 nunca roda no host, porque disputaria CPU e rede com o backend e
  distorceria as latências.
- **Uma iteração = reserva + confirmação.** `POST /bff/event-wallets` reserva a vaga (`pending`) e
  `POST /bff/event-wallets/confirm` confirma (`confirmed`). Reservas não confirmadas expiram em
  ~120 s (`eventcap.max_time_in_line`) e o job de expiração devolve a vaga.
- **Pares únicos.** Cada reserva usa um par (usuário, evento) diferente. Poucos usuários (o login
  usa bcrypt, que é caro) geram milhares de reservas sem duplicidade; o seed cria os eventos
  necessários.
- **Caminho de reserva.** O host roda em um de dois modos (`RESERVATION_READPATH`):
  - **`cas`** (padrão): `UPDATE` condicional atômico em `eventcap`. Nunca vende além da
    capacidade.
  - **`naive`**: lê a vaga calculada sobre `event_availability`, uma projeção assíncrona alimentada pelo
    consumer do tópico `reservation.wallet` (o "lag" é o do relay + consumer, medido, não configurado), e grava
    sem tocar em `eventcap`. Vende além da capacidade quando as tentativas caem na mesma janela de lag. É o braço de controle do experimento, não um bug.

## 1. Disputa de vagas

**Objetivo:** corretude sob concorrência. N clientes disputam as vagas de **um** evento, todos ao
mesmo tempo (ex.: 200 clientes para 20 vagas).

```powershell
make test-disputa HOST_IP=<ip> VUS=50,100,200 CAPACIDADE=20
# no host, logo depois:
make verificar-disputa EVENT_ID=<id impresso>
```

**Como ler:** `aceitas <= capacidade` no `cas`. O overselling oficial é o do banco
(`verificar-disputa`): `(pending + confirmed) − capacidade`, que deve ser `<= 0`. No `naive`,
espera-se overselling > 0.

## 2. Taxa fixa (RPM)

**Objetivo:** saturação. `RPM` reservas por minuto, constantes, espalhadas em vários eventos,
durante `DURACAO` segundos.

```powershell
# host: o teto de conexões do Postgres importa (ver "Conexões" abaixo)
make host-rpm MAX_CONN=300
# gerador
make test-rpm HOST_IP=<ip> RPM=2000 DURACAO=60   # aquecimento
make test-rpm HOST_IP=<ip>                       # 10k RPM por 90 s
# host
make verificar-rpm PREFIXO=Rpm-<id impresso>
```

**Como ler:** `erros_5xx` ou `outros` > 0 invalidam a rodada; `descartadas` > 0 indica que o k6
não manteve a taxa (gerador ou host saturou). Mantenha `DURACAO <= 110 s`, abaixo da expiração
das reservas.

## 3. Carga aleatória

**Objetivo:** estabilidade ao longo do tempo, no perfil mais próximo do uso real. A cada `PASSO`
segundos a taxa muda para um alvo sorteado entre `RPM_MIN` e `RPM_MAX`. `PCT_LEITURA` % das
iterações são leituras (evento por id, carteira do usuário, busca) e o resto são reservas. A
latência é medida por endpoint.

```powershell
make test-aleatorio HOST_IP=<ip>                                  # 10 min, 1k–12k RPM, 30% leituras
make test-aleatorio HOST_IP=<ip> TEMPO=30m RPM_MAX=20000 SEMENTE=42
```

**Como ler:** a mesma `SEMENTE` repete o mesmo perfil. Como as reservas `pending` expiram e são
revendidas, `aceitas` pode passar da capacidade sem ser overselling; a invariante que vale é
`ativas <= capacidade`, conferida no host com `verificar-rpm`.

## 4. Matriz do experimento (CAS × naive)

**Objetivo:** o experimento central do TCC. Mede o overselling do caminho ingênuo em função do
lag do read model, contra o CAS como referência.

| Braço | N (clientes) | Repetições | Lags (ms) | Linhas no CSV |
|---|---|---|---|---|
| `cas` | 100, 200 | 10 | 0 (o lag não é mais configurado, #29; o CAS nem lê a projeção) | 20 |
| `naive` | 100, 200 | 10 | 0 (idem; o lag real sai em `lag_obs_*`) | 20 |

```powershell
# braço CAS (host com READPATH=cas)
make test-matriz-cas HOST_IP=<ip>
# braço ingênuo (o lag é o do consumer real, medido)
make host-rpm READPATH=naive MAX_CONN=300                    # no host
make test-matriz-naive HOST_IP=<ip>                          # no gerador
# gráfico
make report-matriz
```

Exige `psql` e `PGPASSWORD` no gerador (o runner lê a verdade do banco). Capacidade de 20 vagas e
100% de confirmação, fixos.

**Como ler:** o overselling primário é `confirmed > capacidade`; o secundário, `pending +
confirmed`. Todas as linhas `cas` devem ter `oversell = 0` (o runner sai com erro 3 se não). No
`naive`, reporte média e dispersão por lag; se o overselling não crescer com o lag, isso é um
achado, não um erro.

## 5. Escada de degraus (limiar X)

**Objetivo:** encontrar o **limite X**, o RPM a partir do qual o host degrada.

**Como funciona:** uma única execução do k6 com degraus de taxa constante (modelo aberto: o k6
dispara no ritmo pedido mesmo se o host demorar). Cada degrau dura `DEG_DURACAO` s (padrão 60),
com 31 s de intervalo entre eles para as requisições em voo terminarem. Os `MAX_VUS` são
pré-alocados: só há descarte quando todos estão ocupados, ou seja, quando uma iteração passa de
`MAX_VUS ÷ (RPM/60)` segundos.

```powershell
make test-degraus HOST_IP=<ip>                                     # 12k→40k, passo 4k, 2000 VUs
make test-degraus HOST_IP=<ip> DEG_INICIO=95000 DEG_PASSO=1000 DEG_MAX=100000 MAX_VUS=3000
make test-degraus HOST_IP=<ip> MAPEAMENTO=intercalado              # carga espalhada pelos eventos
make report-degraus CSV=results\degraus-<id>.csv                   # gráfico + X
```

**Critério de X:** o primeiro degrau com **taxa de 5xx > 1% das reservas** (as confirmações não
entram) **ou** alguma janela de 30 s com **p95 > 1 s**. Se o gerador saturar antes (iterações
descartadas ou RPM efetivo abaixo do alvo sem degradação do host), o X vira **limite inferior**.

**O que o X mede** depende do `MAPEAMENTO`, que decide como a iteração `i` vira o par (usuário,
evento), com `U` usuários e `E` eventos (cada par é único dentro da escada nos dois modos):
- `sequencial` (padrão): usuário `i % U`, evento `floor(i / U)`. As `U` (200) reservas seguidas vão
  para o **mesmo evento**, então o X é o limite de **um evento disputado**: as reservas disputam a
  mesma linha do `eventcap`. Use para medir a disputa por um evento.
- `intercalado`: usuário `floor(i / E)`, evento `i % E`. As `E` reservas seguidas vão para eventos
  **diferentes**, então a carga se espalha e o X é a **capacidade do host** sem a linha quente de um
  evento. Use para medir quanto o host aguenta quando a procura é distribuída.

Capacidade por evento: o padrão do runner é `USUARIOS / 2` no `sequencial` e `USUARIOS` no `intercalado`. No
intercalado o evento recebe a *u*-ésima reserva na "rodada" *u*, então `USUARIOS / 2` lotaria todos os eventos juntos
no meio da escada (segunda metade 100% "lotado", X inflado); com `USUARIOS` cada evento aceita as `U` reservas (uma por
usuário). O runner imprime a capacidade usada.

O CSV registra o modo na coluna `mapeamento` (o report o mostra no subtítulo); CSV antigo, sem a
coluna, aparece como `n/d`. Os dois X só se comparam entre si com o mesmo `MAPEAMENTO`. Resultados
em [Escada de degraus: resultados de 2026-10-16](/testes/pre-serie/resultados-escada-2026-10-16).

**Cuidados:**
- Os parâmetros `MAX_CONN` e `POOL_HIKARI` do gerador só **rotulam** o CSV. Confira no host o
  valor real (`SHOW max_connections;` e `printenv SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE`).
- No Windows, taxas acima de ~60k RPM esgotam as portas efêmeras do gerador ("Only one usage of
  each socket address"). Amplie a faixa como admin:
  `netsh int ipv4 set dynamicport tcp start=10000 num=55535`.
- Cada VU consome RAM no gerador (~1,4 MB medido com 2000 VUs, mais com 4000). Em uma máquina
  com 16 GB, 3000 VUs couberam e 4000 não.

## Versão realista (60% de confirmação)

Nos testes padrão toda reserva aceita é confirmada (`PCT_CONFIRMA=100`). Na versão realista, cada
aceita é confirmada ou não ao acaso (sorteio determinístico); as não confirmadas ficam `pending`
e expiram em ~120 s, segurando a vaga até lá.

```powershell
make test-disputa-real   HOST_IP=<ip>          # PCT_CONFIRMA_REAL=60 por padrão
make test-rpm-real       HOST_IP=<ip>
make test-aleatorio-real HOST_IP=<ip>
make test-degraus        HOST_IP=<ip> PCT_CONFIRMA=60
```

**Como ler:** `confirmadas ≈ aceitas × PCT_CONFIRMA / 100`. A invariante continua
`(pending + confirmed) <= capacidade`. O CSV de degraus não tem coluna de percentual: confira o
`pct_confirma` no `summary-degraus-<id>.json`.

## Métricas comuns

| Etapa | Contadores | Latência |
|---|---|---|
| Reserva (`POST /bff/event-wallets`) | `reservas_aceitas`, `reservas_lotado`, `reservas_5xx`, `reservas_outros` | `reserva_duration` |
| Confirmação (`POST /bff/event-wallets/confirm`) | `confirma_aceitas`, `confirma_4xx_esperado`, `confirma_5xx`, `confirma_outros` | `confirma_duration` |

- `confirma_4xx_esperado` (reserva já confirmada ou expirada) não é erro.
- **Latência base:** o `setup-gerador` mede a latência de rede até o host; desconte-a das
  latências medidas.

### Conexões com o banco

O backend usa o pool **HikariCP** (`SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE`, padrão 1000), mas
quem limita é o `max_connections` do Postgres. O `make setup-host` sobe o Postgres com o padrão de
**100**; só o `make host-rpm MAX_CONN=<n>` aplica outro valor. Registre sempre o valor efetivo,
porque ele muda o X.

## Suíte automatizada do backend

`Projeto/Backend/run-tests.sh` roda `mvn clean test` num container Maven contra um **Postgres
real** (exige o container `db` no ar). Não há mock de banco.

- Testes de integração por serviço (eventos, usuários, carteiras, reservas, máquina de estados da
  reserva, read model, pool de conexões).
- `SchemaValidationTest`: compara o schema real com o esperado.
- `HttpContractTest`: trava caminho, método e formato de cada endpoint `/bff/**` no HTTP real.
- `LayerBoundaryArchTest` (ArchUnit) e Checkstyle: regras de arquitetura e estilo, que quebram o
  build.

## Testes manuais

Roteiros em `docs/testes-manuais/` exercitam o sistema no nível HTTP contra a stack real (ex.:
overselling sob concorrência). Complementam a suíte automatizada, não a substituem.

O harness de `docs/carga/harness/` é só uma checagem local (stack e k6 na mesma máquina); os
números oficiais vêm do kit de `Projeto/carga` com duas máquinas.
