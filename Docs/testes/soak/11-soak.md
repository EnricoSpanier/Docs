# 11-soak — teste longo (issue #232)

Blocos de 2 h com os 5 tipos de carga (leitura, reserva, login, cadastro com e-mail e escrita de catálogo), sob picos e vales sorteados por semente. Kit em `Projeto/carga/soak/`; passo a passo e critérios no `Projeto/carga/README.md` e na spec `docs/superpowers/specs/2026-11-01-teste-longo-soak-design.md`.

**Configuração (todos os blocos):**

- cluster kind com a trilha b1 (Istio) e o overlay `soak`;
- db no Dell (`192.168.68.50:5433`);
- `stock` com 1 réplica fixa e Hikari 245 (#231);
- e-mail num Mailpit dentro do cluster, sem nenhum e-mail real;
- k6 v2.2.0 no gerador (192.168.68.54).

O S1 usa `ADMISSION_X_RPM` 56000, sem fila. O S2 usa 4000: a fila liga em todo pico, com 1 evento quente.

| Pasta | Data (UTC) | Resultado | Resumo |
|---|---|---|---|
| [`dry-run/`](https://github.com/endydragonn/GerenciadorEventos/tree/main/Projeto/carga/results/11-soak/dry-run/) | 2026-11-02 | dry S1: critérios 1 e 3 ok, critério 2 vácuo (por desenho). dry S2: aprovado na época, mas REPROVA no critério 1 pela guarda atual (79%) | Ensaios de 10 min que trouxeram as correções de firewall, HPA, telefone e `reserva_400{motivo}` |
| [`S1-tentativa1/`](https://github.com/endydragonn/GerenciadorEventos/tree/main/Projeto/carga/results/11-soak/S1-tentativa1/) | 2026-11-02 | inválido para o e-mail | Os 37.253 cadastros deram 400 por causa do telefone (corrigido em 2b3e8e8). Overselling 0 e eventos lotados |
| [`S2/`](https://github.com/endydragonn/GerenciadorEventos/tree/main/Projeto/carga/results/11-soak/S2/) | 2026-11-02 | REPROVADO (critérios 1 e 3) | 262 e-mails duplicados (causa provável: busca linear do Mailpit saturada, timeout do SMTP e retry do consumer) e 464 respostas 503 na consulta da fila (causa provável: `admission` com 1 pod no degrau da rampa) |
| [`dryMailpit/`](https://github.com/endydragonn/GerenciadorEventos/tree/main/Projeto/carga/results/11-soak/dryMailpit/) | 2026-11-02 | APROVADO | 40 min só de cadastro, com a caixa pré-enchida com 55 mil mensagens: p95 do Mailpit de 7 a 13 ms e 0 duplicadas. Portão das correções 02af3d9 e #235 |
| [`S2b/`](https://github.com/endydragonn/GerenciadorEventos/tree/main/Projeto/carga/results/11-soak/S2b/) | 2026-11-03 | REPROVADO só no critério 3 (aceito pelo usuário, sem re-teste) | 12 respostas 503 na consulta da fila às 03:51Z (causa provável, não provada: timeout de 200 ms do Redis no `admission`, com o host e o Dell saturados). 0 duplicadas e overselling 0 (conferido, não estressado no S2) |
| [`S1b/`](https://github.com/endydragonn/GerenciadorEventos/tree/main/Projeto/carga/results/11-soak/S1b/) | 2026-11-03 | APROVADO | 0 respostas 5xx, overselling 0, 36.540 respostas 400 por "lotado", 37.253/37.253 e-mails e o Dell folgado |

Cada pasta tem o perfil (`perfil-<id>.json`), o por-minuto do k6, a telemetria do gerador (menos o `dry-run/`), a coleta do host, os logs do pós-bloco e o README do bloco. A coleta do Dell fica nas refs `K8sDB-dell-soak-*` (sessão DB). Os logs completos dos pods do S2 e do S2b ficaram no host, fora do git, em `E:\TCC\evidencias\`; dos outros blocos não foram guardados.

## Limitação conhecida

**Carga entregue da reserva** (`Projeto/carga/soak/criterios.py`, linhas 358–359):

- o critério soma as *requisições* da reserva, incluindo `confirm`, `cancel` e poll da fila, contra as *iterações* do perfil, então quase sempre passa;
- pela coluna `taxa`, a reserva ficou em 100% no S1b, 91,1% no S2b e 94,5% no S2. Nenhum veredito muda hoje;
- a correção é usar a coluna `taxa`, e fica para depois.

**Mensagem do log do S2** (`criterios.py`, linha 405): o `verificar-soak` diz que a carga do S2 foi entregue, mas isso só vale com o desconto das descartadas (sem ele, o cadastro do S2 ficou em 47%). O código não muda agora.
