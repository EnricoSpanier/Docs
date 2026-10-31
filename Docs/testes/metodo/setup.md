# Setup da máquina de geração de carga (issue #4)

> Os passos 1–4 abaixo estão automatizados em `Projeto/carga/` (`setup-host.ps1`,
> `setup-gerador.ps1`, `rodar-teste.ps1`; ver `Projeto/carga/README.md`). Este guia fica como
> referência manual e como lugar do registro do ambiente (seção 5). O runner oficial do experimento
> (matriz de N × repetições × lag, CSV + gráfico) está descrito em `Projeto/carga/README.md`.

Objetivo: uma máquina separada do host do sistema dispara a carga, para que latência e
throughput absolutos sejam válidos (ver `BACKLOG.md`, "Decisões de arquitetura em vigor").

- **Host-alvo (SUT):** a máquina que roda `docker compose -f Projeto/docker-compose.yml up -d --build`
  (backend `:8081`, Postgres `:5433`, frontend `:8088`).
- **Gerador de carga:** a máquina nova. Não precisa de Docker, banco nem do `Projeto/.env`.

> Nunca copie o `Projeto/.env` para o gerador (contém credenciais reais).

## 1. No host-alvo

1. Subir a stack e validar o baseline: `docker compose -f Projeto/docker-compose.yml up -d --build`.
2. Descobrir o IP do host na rede local (`ipconfig`, adaptador em uso) e anotar: `<IP_HOST>`.
3. Liberar a porta da API no firewall do Windows (somente rede privada):

   ```powershell
   New-NetFirewallRule -DisplayName "TCC backend 8081" -Direction Inbound `
     -Protocol TCP -LocalPort 8081 -Action Allow -Profile Private
   ```

4. Deixar a rede como **Privada** (Configurações > Rede). A `5433` (Postgres) **só** é aberta para a
   matriz do experimento (o gerador consulta `confirmed`/`pending` e o lag por `psql` remoto): regra
   `TCC postgres 5433`, perfil Privado, criada pelo `setup-host.ps1` **só com `-GeradorIp <ip>` e sempre
   restrita a esse IP** (sem o parâmetro a 5433 continua fechada); remova ao fim do experimento com
   `Remove-NetFirewallRule -DisplayName 'TCC postgres 5433'`. A senha do Postgres vai para o gerador só
   pela variável de ambiente `PGPASSWORD` (ver `Projeto/carga/README.md`); nunca expor a `5433` para
   fora da LAN.
5. Do gerador, `http://<IP_HOST>:8081` deve responder (passo 4 abaixo).
6. Para uma medição estável: ligar na tomada, plano de energia "Alto desempenho", fechar apps
   pesados e anotar CPU/RAM/disco do host na seção "Ambiente" abaixo.

## 2. No gerador de carga

1. Conectar na **mesma rede** do host, de preferência por cabo (Wi-Fi adiciona jitter).
2. Instalar **k6** (`winget install k6 --source winget`) ou, se preferir, JMeter/Gatling.
   Confirmar com `k6 version`.
3. Clonar o repositório (para versionar os cenários em `Projeto/carga/`) e entrar na branch
   da issue. Sem `.env`.
4. Mesmo plano de energia/desempenho do passo 1.6.

## 3. Medir a latência base de rede (para descontar depois)

No gerador:

```powershell
ping -n 100 <IP_HOST>
curl.exe -s -o NUL -w "connect=%{time_connect}s ttfb=%{time_starttransfer}s total=%{time_total}s\n" http://<IP_HOST>:8081/
```

Rodar 3 vezes em momentos diferentes e registrar min/média/máx e perda de pacotes. Esses
valores são subtraídos das latências medidas nas rodadas da Fase 2.

## 4. Smoke test do k6

Arquivo `smoke.js` (ajustar a rota para um endpoint GET público do backend):

```js
import http from 'k6/http';
import { check } from 'k6';

export const options = { vus: 5, duration: '15s' };

export default function () {
  const res = http.get(`${__ENV.BASE_URL}/`);
  check(res, { 'status < 500': (r) => r.status < 500 });
}
```

Rodar: `k6 run -e BASE_URL=http://<IP_HOST>:8081 smoke.js`

Critério: sem erros de conexão e latência p95 coerente com a base medida no passo 3.

## 5. Registro (preencher no dia do teste)

Preenchido com o que as rodadas de 2026-10-04 registraram (`Projeto/carga/results/01-sem-pool/baseline-20261004-122632.txt`);
"n/d" = não foi registrado na época (não reconstruído depois).

| Item | Host-alvo | Gerador |
|---|---|---|
| CPU / RAM / disco | n/d | AMD Ryzen 5 7600 (6 núcleos); RAM/disco n/d |
| SO / versão | n/d | n/d |
| Rede (cabo/Wi-Fi, velocidade) | Ethernet, mesma rede do gerador | link de 1 Gbps |
| IP | ver "Ambiente" na seção 6 | não versionado |
| Ferramenta e versão | Docker Desktop (stack do projeto; versão n/d) | k6 v2.2.0 (go1.26.5, windows/amd64) |
| Ping min/média/máx | n/d | **sem resposta ao ICMP** (100 pacotes sem retorno; ICMP provavelmente bloqueado no host) |
| Perda de pacotes | n/d | n/d (sem ICMP) |
| Latência HTTP base (`GET /actuator/health`, n=30) | n/d | p50 14,9 / p95 19,0 / máx 21,1 ms |
| Commit testado | por rodada: seção 6 (nem toda rodada registrou); a matriz grava `commit` em cada linha | idem |

## Critério de aceite da issue #4 (item 3 do backlog)

Evidência: o baseline `Projeto/carga/results/01-sem-pool/baseline-20261004-122632.txt` (`setup-gerador.ps1`, 2026-10-04) e
as rodadas de carga de 2026-10-04 (seção 6), todas disparadas do gerador contra o host.

- [x] Gerador com acesso de rede ao host-alvo. O `setup-gerador.ps1` conectou na 8081 e o
  `/actuator/health` respondeu; as rodadas de disputa, RPM e aleatório (seção 6) rodaram do gerador sem
  erro de conexão.
- [x] Ferramenta de carga instalada e smoke test passando. k6 v2.2.0 no gerador. O smoke test foi o do
  próprio `setup-gerador.ps1` (conexão TCP + `/actuator/health` + 30 requisições HTTP sem falha) e, em
  seguida, o teste 1 (disputa) do kit; o `smoke.js` da seção 4 não foi usado.
- [x] Latência base entre gerador e alvo medida e registrada neste documento (seção 5). **Só a latência
  HTTP foi medida** (p50 14,9 / p95 19,0 / máx 21,1 ms, n=30, uma medição; a recomendação de repetir 3 vezes em
  horários diferentes não foi cumprida). **O ICMP não respondeu**: não há ping min/média/máx nem perda de
  pacotes.

## 6. Registro das rodadas

Fonte dos números: `Projeto/carga/results/02-hikari/verificacoes.log` (cada `-Verificar` anexa data/hora,
alvo e config ativa). Rodar o verificador **logo após** a rodada: depois do TTL as reservas
expiram e as vagas voltam, então só `eventos_com_overselling` continua valendo como prova.

Ambiente: host `192.168.68.61` (Ethernet, mesma rede do gerador). Latência base de rede medida só por HTTP
(p50 14,9 / p95 19,0 ms; o ICMP não respondeu: seção 5); descontar da latência do gerador.

| Data | Teste | Alvo | Config (read path / refresh) | Resultado do banco | Overselling |
|---|---|---|---|---|---|
| 2026-10-04 | Disputa | eventos 1–5 | cas / 5000 ms | capacity 20, 20 reservas `expired`, vagas 20 (verificado após o TTL) | 0 |
| 2026-10-04 | Disputa | evento 6 | cas / 5000 ms | capacity 20, 20 reservas `pending`, vagas 0 (dentro do TTL) | 0 |
| 2026-10-04 | Taxa fixa (RPM) | `Rpm-903185` | cas / 5000 ms | 11 eventos, capacidade total 1100, 1000 reservas `expired`, 0 ativas (após o TTL) | 0 (`eventos_com_overselling = 0`) |
| 2026-10-04 | Taxa fixa (RPM) | `Rpm-903506` | cas / 5000 ms | 79 eventos, capacidade total 7900, 5379 reservas (2312 `pending` ativas + 3067 `expired`), ocupação ~29% (dentro do TTL) | 0 (`eventos_com_overselling = 0`) |
| 2026-10-04 | Taxa fixa (RPM) | `Rpm-904217` | cas / 5000 ms, `max_connections=300` (CSV do k6) | 79 eventos, capacidade total 7900, ~5375 reservas (3413 `pending` + 1962 `expired`), ocupação ~43% (dentro do TTL) | 0 (`eventos_com_overselling = 0`) |
| 2026-10-04 | Aleatório (teste 3) | `Ale-904991` | cas / 5000 ms, `max_connections=1000`, commit `c9bd024` (PR #95); k6: 45 min, 1k–12k RPM, rpm médio 6150, **112.878 respostas 5xx**, 1735 iterações descartadas, reserva p95/p99 153/879 ms, leitura p95/p99 770/4392 ms, máx 23,2 s | 1464 eventos, capacidade total 146400, 81109 reservas `expired`, 0 ativas (após o TTL) | 0 (`eventos_com_overselling = 0`) |
| 2026-10-04 | Taxa fixa (RPM) | `Rpm-909189` | cas / 5000 ms, `max_connections=1000` | 53 eventos, capacidade total 5300, 2917 reservas `pending` ativas (~55%, dentro do TTL); 39.120 linhas de `BindException` no log; k6: 9644 RPM reais, 2917 aceitas, 2697 lotado, **4387 respostas 5xx**, p50/p95/p99 27,5 / 65,1 / 156,5 ms, máx 431 ms (`summary-rpm10000-909189.json`) | 0 (`eventos_com_overselling = 0`) |
| 2026-10-04 | Taxa fixa (RPM) | `Rpm-909317` | cas / 5000 ms, `max_connections=1000` | 53 eventos, capacidade total 5300, ~2850 reservas (1343 `pending` + 1507 `expired`, parcialmente expiradas); 21.711 linhas de `BindException` no log; k6: 9643 RPM reais, 2850 aceitas, 2587 lotado, **4563 respostas 5xx**, p50/p95/p99 26,6 / 50,1 / 74,2 ms, máx 177 ms (`summary-rpm10000-909317.json`) | 0 (`eventos_com_overselling = 0`) |

Parâmetros das rodadas RPM acima (fonte: `Projeto/carga/results/02-hikari/resultados-rpm.csv`; todas com 200 usuários e 100 vagas por evento):

| Rodada | RPM alvo (real) | Duração | Eventos |
|---|---|---|---|
| `Rpm-903185` | 2000 (1930) | 62,2 s | 11 |
| `Rpm-903506` | 10.000 (9761) | 92,2 s | 79 |
| `Rpm-904217` | 10.000 (9764) | 92,2 s | 79 |
| `Rpm-909189` | 10.000 (9644) | 62,2 s | 53 |
| `Rpm-909317` | 10.000 (9643) | 62,2 s | 53 |

Commit testado: **não foi registrado** nas rodadas de 2026-10-04 (as exceções estão citadas nas linhas e
seções abaixo: `c9bd024`, `275d587`, `af01483`); não será reconstruído. A matriz do experimento grava
`commit` em cada linha de `results/matriz.csv`.

### Observações das rodadas RPM (2026-10-04)

- **Erros no backend durante a carga** (`docker logs gerenciador-backend`, ~15:53Z): os jobs
  `@Scheduled` (atualização de `event_availability` e listagem de reservas expiradas) falharam com
  `PSQLException: The connection attempt failed` causada por
  `java.net.BindException: Cannot assign requested address`. Isso indica esgotamento de portas
  efêmeras (ou limite de conexões) na rota backend → Postgres, e não falha de lógica do CAS.
  O overselling continuou 0, mas os jobs de expiração/read model ficaram atrasados, o que
  explica reservas `pending` ainda ativas no verificador.
- **Ajuste:** `max_connections` do Postgres elevado para 1000 (informado pelo operador; confirmar com
  `SHOW max_connections` e registrar as rodadas seguintes com esse valor). Atenção: `BindException`
  é falha **do lado do cliente** (portas efêmeras do backend), então subir `max_connections` pode não
  bastar; conferir também o pool do backend (tamanho máximo) e, se persistir, o range de portas do
  Docker/WSL. Comparar a próxima rodada RPM com a anterior (`Rpm-903506`, 300).
- Rodadas com esse erro devem ser tratadas como **saturação do ambiente**, não como resultado
  de capacidade do sistema, até a causa ser isolada.
- **`Rpm-904217` (`max_connections=300` conforme o CSV do k6; o 1000 só foi aplicado depois):** o backend ainda registrou 42 linhas
  de `BindException`/`connection attempt failed` nos últimos 30 min. Ou seja, subir `max_connections`
  **não eliminou** o erro, o que reforça a hipótese de portas efêmeras / pool do backend. Mantém-se
  como saturação do ambiente. (`reservas_ativas` 3414 vs `pending` 3413: as duas consultas do
  verificador não são atômicas e a carga ainda corria.)
- **Causa identificada (2026-10-04):** o backend **não tem pool de conexões**.
  `DatabaseConnection.getConnection()` usa `DriverManager.getConnection(...)`, ou seja, abre uma
  conexão TCP nova no Postgres a cada operação de repositório. Sob carga isso gera milhares de
  sockets em `TIME_WAIT` (medido no container do backend: `tw 3363` logo após a rodada;
  faixa de portas efêmeras `32768–60999`, ~28 mil) até esgotar as portas →
  `BindException: Cannot assign requested address`. Por isso subir `max_connections` não ajudou
  (o Postgres tinha só ~16 conexões ativas/ociosas). `tcp_tw_reuse=2` já é o padrão do kernel (só loopback).
  As latências e a taxa sustentável medidas hoje refletem esse gargalo, não o CAS.
- **Correção possível (decisão do usuário, mudança de código de backend):** introduzir um pool
  (HikariCP, via `DataSource`) mantendo JDBC puro, sem JPA. Alternativa só de ambiente: ampliar a
  faixa de portas efêmeras no container (`sysctl net.ipv4.ip_local_port_range`), que apenas adia o problema.
- **`Ale-904991` (teste aleatório, PR #95):** 110407 linhas de `BindException`/`connection attempt failed`
  no log do backend em 30 min (contra 42 na `Rpm-904217`), sem pool de conexões. Overselling 0, mas
  a rodada é de saturação do ambiente; comparar com a rodada pós-pool.

#### Evidência de esgotamento de portas (série de `sockstat`, backend, 2026-10-04 14:26–14:30)

Série de `sockstat` (amostragem a cada 2 s de `TCP: ... tw`; **não versionada**: o `results/02-hikari/sockstat.log` só tem 5 amostras pós-pool, das 15:42):

- Repouso: `tw` ≈ 14. Durante a carga: **pico de 34.199 sockets em `TIME_WAIT`** às 14:30:20.
- A faixa de portas efêmeras do container é `32768–60999` = **28.232 portas**. Como o destino é
  sempre o mesmo `db:5432`, o pico (> 28.232) confirma o esgotamento: sem porta livre, o `connect()`
  falha com `Cannot assign requested address`.
- O `tw` só cai ~1.800 a cada 2 s depois do fim da carga (sockets expiram em ~60 s), então o backend
  fica sem conexões por minutos após cada rodada.
- Conclusão: o gargalo medido nas rodadas de 10k RPM (4718 erros 5xx, ~31%) e na `Ale-904991`
  (112.878 erros 5xx) é a falta de pool (#96), não o CAS nem o `max_connections` (1000 foi inútil: não
  mudou o 5xx). Overselling 0 em todas.

#### Rodadas pós-pool (2026-10-04, tarde) — issue #96

Backend `275d587`: `DatabaseConnection` usa o `DataSource` do Spring (HikariCP), pool
`maximum-pool-size` 1000 (default; `minimum-idle` 5, cresce sob demanda), host com
`max_connections=1000`. Resumos do k6 e CSVs: `Projeto/carga/results/02-hikari/` (PR #98). Overselling
conferido no banco do host com `make verificar-disputa` / `make verificar-rpm`.

**Ressalva de comparação:** a stack foi recriada antes dessas rodadas (banco zerado: `event_id` e
`user_id` voltaram a 1). A única mudança de código de backend entre manhã e tarde é o pool; a carga
(RPM, semente `617706`, mesmos 1464 eventos de 100 vagas, mesmos 200 usuários) é a mesma.

##### Teste 1 — disputa (CAS, capacidade 20; eventos 1, 2, 3)

| Clientes | Aceitas | Lotado | Erros | p50 / p95 | Vazão | p95 da manhã (sem pool) |
|---|---|---|---|---|---|---|
| 50 | 20 | 30 | 0 | 95,8 / 103,0 ms | 79,9/s | 260 ms |
| 100 | 20 | 80 | 0 | 41,4 / 63,5 ms | 89,6/s | 414 ms |
| 200 | 20 | 180 | 0 | 74,4 / 89,8 ms | 95,4/s | 695 ms |

Overselling 0 (banco: 20 reservas por evento, ativas ≤ capacidade). Na primeira bateria da manhã
ainda houve 13 e 105 respostas "outras" (100 e 200 clientes); agora 0. **Motivo da melhora:** cada
operação de repositório deixou de abrir uma conexão TCP + autenticação nova no Postgres.

##### Teste 2 — 10k RPM por 90 s (`Rpm-913181` e `Rpm-913395`)

| Rodada | RPM real | Aceitas | Lotado | 5xx | Descartadas | p50 / p95 / p99 | Overselling | `BindException` |
|---|---|---|---|---|---|---|---|---|
| `Rpm-913181` | 9786 | 7501 | 7500 | **0** | 0 | 2,7 / 4,7 / 13,2 ms | **0** | **0** |
| `Rpm-913395` | 9792 | 7500 | 7500 | **0** | 0 | 2,5 / 4,2 / 11,9 ms | **0** | **0** |

Antes do pool (`Rpm-903506`, `Rpm-904217`): 4718 respostas 5xx em ~15 mil (~31%), idênticas nas duas
rodadas, e 39.120 linhas de `BindException` na `Rpm-909189`. Agora 0 e 0. Critério da #96 atendido.

- **7501 aceitas não é overselling:** o k6 fez 15001 iterações (7501 + 7500), uma além das 15000
  planejadas. Com os pares em sequência (usuário `i % 200`, evento `i / 200`), a iteração 15000 cai
  no 76º evento, ainda com 100 vagas livres, e é aceita. Os 75 primeiros eventos somam 7500 = 75 × 100.
  O banco confirma: `eventos_com_overselling` 0.
- As duas rodadas deram praticamente o mesmo resultado: sem a saturação de portas o comportamento
  voltou a ser determinístico e limitado pelo CAS, não pelo ambiente.

##### Teste 3 — aleatório, 45 min (`Ale-913561`, semente 617706, a mesma da `Ale-904991`)

| Mesmo perfil (1k–12k RPM) | Manhã `Ale-904991` (sem pool) | Tarde `Ale-913561` (pool) |
|---|---|---|
| RPM médio (pico alvo) | 6150 (11926) | 6189 (11926) |
| Reservas aceitas | 81.109 | 195.005 |
| Reservas 5xx | 112.878 | **0** |
| Leituras ok / inesperadas | 28.693 / 54.306 | 83.716 / **0** |
| Iterações descartadas / VUs máx. | 1735 / 500 | **0** / 100 |
| Reserva p50 / p95 / p99 | 6,2 / 153 / 880 ms | 3,1 / 4,4 / 8,9 ms |
| Leitura p50 / p95 / p99 | 6,4 / 770 / 4393 ms | 1,9 / 456 / 492 ms |
| Latência máxima | 23,2 s | 563 ms |
| `BindException` no log | 110.407 | **0** |

Overselling 0 (`make verificar-rpm PREFIXO=Ale-913561`: 1464 eventos, 0 com overselling, 195.005
reservas todas `expired` ao fim). Critério da #96 atendido (0 5xx, 0 descartadas).

- **195.005 aceitas > 146.400 vagas (1464 × 100) não é overselling:** em 45 min as reservas
  `pending` expiram (~120 s) e a vaga é revendida. A invariante é ativas ≤ capacidade.
- **Mais aceitas do que de manhã (81 mil → 195 mil)** porque antes ~31% das tentativas morriam em
  5xx e 1735 iterações eram descartadas por falta de VU.

##### Achados e motivos

1. **Causa raiz confirmada: o gargalo era a falta de pool, não o CAS nem o `max_connections`.**
   `DriverManager` abria uma conexão TCP por operação → milhares de sockets em `TIME_WAIT` (pico
   34.199 > 28.232 portas efêmeras) → `BindException`. Com o pool: 0 5xx e 0 `BindException` nas
   três rodadas; subir `max_connections` não tinha efeito antes, o que já apontava para a conexão
   por operação.
2. **Overselling 0 em todas as rodadas**, antes e depois: o CAS é correto e o problema era de
   disponibilidade. Os números "a mais" (7501, 195.005) têm as explicações acima.
3. **Leitura bimodal (aberto):** leitura p50 1,9 ms mas p95 456 ms e p99 492 ms. Suspeita, *não
   medida por endpoint*: `GET /bff/events/search` varre todos os eventos em memória. Não é efeito do
   pool. Follow-up fora do escopo da #96 (o N+1 do `hydrate` e o `LIMIT`/`SKIP LOCKED` são da #61).
4. **`tw` do `sockstat` pós-pool não foi medido durante a carga:** o `results/02-hikari/sockstat.log` desta
   tarde tem só 5 linhas (15:42, `tw` máx. 6, em repouso) e não cobre as rodadas. O critério "`tw` de
   poucos milhares" não tem série própria; o proxy é `BindException` = 0 e 0 5xx.
5. **Default do pool 1000 só é seguro com `max_connections` alto:** o `db` do `docker-compose.yml`
   padrão usa `max_connections=100`; fora do host de carga, reduzir por
   `SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE`. O `minimum-idle` 5 evita que cada contexto Spring
   (inclusive os de teste) segure 1000 conexões ociosas. O tamanho ideal do pool não foi explorado:
   com 100 VUs e latências de poucos ms, o pool nunca precisou chegar perto de 1000.
6. **Manhã e tarde não são perfeitamente comparáveis** (banco zerado entre as baterias); a diferença
   é grande demais (5xx 112.878 → 0) para ser explicada por isso, então a comparação de latência é
   indicativa, não exata.
7. **Nenhum dos 3 testes finaliza vendas:** todas as reservas ficam `pending` e depois `expired`;
   nenhuma chega a `confirmed`. Isso mede só o caminho de reserva (CAS), não a confirmação. Registrado
   para o próximo trabalho (testes com vendas efetivamente finalizadas).

#### Rodadas com vendas finalizadas (2026-10-04, noite) — PRs #99 e #100

Mesmo host das rodadas pós-pool (pool Hikari, `max_connections=1000`). A partir do #100, os 3 testes
chamam `POST /bff/event-wallets/confirm` em cada reserva aceita; antes as reservas ficavam `pending` e
expiravam, e a carga só media o CAS da reserva (achado 7 acima). Resumos do k6 e CSVs: `Projeto/carga/results/02-hikari/`.

Duas variantes: **100%** confirmadas (`PCT_CONFIRMA=100`, default) e **realista** (`make test-*-real`,
`PCT_CONFIRMA_REAL=60`): cada aceita é confirmada ou não ao acaso (sorteio determinístico por hash);
as não confirmadas expiram e devolvem a vaga.

##### 100% confirmadas

| Teste | Rodada | Aceitas | Confirmadas | 5xx (reserva / confirma) | Descartadas | Reserva p95 | Confirma p95 |
|---|---|---|---|---|---|---|---|
| Disputa 50 / 100 / 200 clientes | eventos 1626 / 1627 / 1628 | 20 em cada | 20/20 em cada | 0 / 0 | n/a | 45 / 53 / 63 ms | 26 / 34 / 50 ms |
| 10k RPM, 90 s | `Rpm-917602` | 7501 | 7501 | 0 / 0 | 0 | 4,1 ms | 3,9 ms |

Banco: disputa com 20 `confirmed`, 0 vagas restantes e overselling 0 por evento; `Rpm-917602` com
7501 `confirmed`, 0 eventos com overselling, 0 `BindException`. A 7501ª aceita é a iteração extra do k6
(15.001), que cai no 76º evento, ainda com vagas. **Provável motivo de a confirmação custar pouco (hipótese, não medida):** é um
`UPDATE` por chave sobre a linha já reservada, sem disputa pela vaga.

##### Realista (60% de confirmação)

| Teste | Rodada | Aceitas | Confirmadas | 5xx | Descartadas | Reserva p95 | Confirma p95 |
|---|---|---|---|---|---|---|---|
| Disputa 50 / 100 / 200 | eventos 1708 / 1709 / 1710 | 20 em cada | 9 / 9 / 8 (45 / 45 / 40%) | 0 | n/a | 42 / 44 / 48 ms | 28 / 19 / 34 ms |
| 10k RPM, 90 s | `Rpm-918245` | 7500 | 4450 (59,3%) | 0 | 0 | 4,1 ms | 4,2 ms |
| Aleatório 45 min | `Ale-919068` | 194.989 | 116.744 (59,9%) | 0 | 0 | 4,6 ms | 3,7 ms |

Banco: `Rpm-918245` com 4450 `confirmed` + 1798 `pending` + 1252 `expired` (a verificação rodou antes dos
~120 s de expiração; os `pending` viram `expired`), overselling 0. `Ale-919068`: 116.744 `confirmed` e
78.245 `expired`, 0 `pending`, 1464 eventos, overselling 0, 0 `BindException`. Disputa 1710: 8
`confirmed` + 12 `expired`, vagas restantes 12.

Aleatório lado a lado com a `Ale-913561` (mesma semente, antes da etapa de confirmação): reserva
p50/p95/p99 3,1 / 4,4 / 8,9 ms → 3,1 / 4,6 / 10,3 ms; leitura p95 456 → 464 ms; 0 5xx e 0 descartadas
nas duas. **Confirmar 60% das reservas não mudou latência nem vazão.**

##### Achados e motivos (vendas finalizadas)

1. **Overselling 0 com vendas finalizadas.** `pending + confirmed` ≤ capacidade em todas as rodadas.
   No aleatório as aceitas passam da capacidade (194.989 > 146.400) porque `expired` devolve a vaga e ela
   é revendida; as 116.744 `confirmed` (definitivas) ficam abaixo de 146.400.
2. **14 respostas `lotado` na `Ale-919068`** (contra 0 na `Ale-913561`): as `confirmed` não expiram e
   esgotam alguns eventos, o que antes nunca acontecia porque toda reserva expirava.
3. **A disputa realista confirma abaixo de `PCT_CONFIRMA` (40–45% em vez de 60%).** O sorteio usa
   semente fixa 0 sobre os índices `0..N-1`; nos primeiros 50/100/200 índices a fração `< 60` é
   38% / 52% / 53% (59,8% nos 15.000 do teste 2), e a amostra da disputa é pequena e idêntica em toda
   rodada. Não afeta corretude (0 overselling).
4. **CSVs:** ganharam colunas de confirmação no cabeçalho; linhas antigas ficam com menos colunas, e o
   `resultados.csv` recebeu `pct_confirma` (valor 100) nas 3 linhas das rodadas do `af01483`.
5. **Leitura bimodal (p95 ~460 ms) segue em aberto** (achado 3 da seção anterior): não mudou com a
   confirmação, o que reforça que vem da busca em memória e não da escrita.
6. **`tw` do `sockstat` continua sem série durante a carga** (achado 4 da seção anterior); o proxy é 0
   `BindException` e 0 5xx.

##### Busca filtrando no banco (issue #109, PR #110) — aleatório de 45 min pelo pooler (`Ale-29057`, 2026-10-17)

Mesmo perfil da `Ale-913561` (semente 617706, 1k–12k RPM, passo 30 s, 30% de leitura, 200 usuários,
`PCT_CONFIRMA=100`), com o host no código da branch `Issue-109` (`15eddaa` = `main` com a Fase 4 + busca
com `LIKE` no banco e hidratação em lote). Host com pooler (Supavisor, pool 245), `max_connections` 300,
`cas`, banco limpo. Arquivos em `Projeto/carga/results/03-supabase-pooler/` (`resultados-aleatorio-109.csv`,
`summary-ale-29057.json`, `perfil-ale-29057.json`).

| Leitura (p50 / p95 / p99, ms) | `Ale-913561` (pool, sem pooler, busca em memória) | **`Ale-29057` (#109, pelo pooler)** |
|---|---|---|
| Busca | — (o summary não separava por endpoint) | **11,4 / 15,0 / 21,8** (16.820 leituras) |
| Evento | — | 1,9 / 3,4 / 6,2 (41.820) |
| Carteira | — | 3,2 / 12,6 / 25,0 (25.069) |
| Leitura agregada | 1,9 / 456 / 492 | **2,6 / 12,9 / 19,9** |
| Reserva | 3,1 / 4,4 / 8,9 | 3,9 / 5,7 / 10,7 |
| 5xx / descartadas | 0 / 0 | 0 / 0 |

- **Aceite da #109 atendido:** p95 da busca **15,0 ms ≤ 50 ms**. A leitura agregada perdeu o segundo
  "montinho" (p95 456 → 12,9 ms): a leitura bimodal (achado 5 acima) vinha da busca em memória.
- **Evento e carteira não pioraram por causa da #109**; a comparação direta com a `Ale-913561` mistura a
  troca de infraestrutura (pooler + PG17, Fase 4), que encarece um pouco a reserva (p95 4,4 → 5,7 ms).
- 146.400 aceitas = 1464 × 100 vagas, todas `confirmed` (`PCT_CONFIRMA=100`), e 48.612 `lotado`: com
  100% de confirmação nenhuma reserva expira, então os eventos esgotam. Overselling 0.
