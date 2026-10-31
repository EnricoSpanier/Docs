import test from "node:test";
import assert from "node:assert/strict";

import { calcular, lerLinhas } from "../lib/painelBatch2.js";

const item = (itens, nome) => itens.find((i) => i.item === nome);

test("merge na Batch_2 fecha a issue; linhas de lock não mexem na fase", () => {
  const linhas = lerLinhas([
    "2026-10-28 08:00 | T1/#166 | worktree E:/TCC/wt/Issue-166 + branch Issue-166 pushada",
    "2026-10-28 08:40 | T1/#166 | gerador volta 1 PRONTO; revisor despachado",
    "2026-10-28 08:41 | T1/#166-gerador | lock pego (run-tests completo da worktree Issue-166)",
    "2026-10-28 09:00 | T1/#166 | PR #184 MERGED na Batch_2, merge commit 7c6aed7",
  ].join("\n"));
  const { itens } = calcular(linhas, new Date("2026-10-28T09:30:00"));
  const i166 = item(itens, "#166");
  assert.equal(i166.status, "concluído");
  assert.equal(i166.duracao_h, 1);
  assert.match(i166.passo, /^09:00 · PR #184 MERGED/);
});

test("decisão pendente e fase do pipeline; a decisão registrada destrava o item", () => {
  const base = [
    "2026-10-28 15:49 | S2/#111 | início: worktree E:/TCC/wt/Issue-111 pushada",
    "2026-10-28 15:54 | S2/#111 | PENDENTE DE DECISÃO #111: mecanismo da autoescala",
  ];
  const pendente = calcular(lerLinhas(base.join("\n")), new Date("2026-10-28T16:00:00"));
  assert.equal(item(pendente.itens, "#111").status, "aguardando decisão");
  assert.match(pendente.resumo.espera_txt, /decisão pendente na #111/);

  const decidido = calcular(lerLinhas([...base,
    "2026-10-28 16:30 | coord/#111 | DECISÃO (via sessão de interface): opção A",
    "2026-10-28 17:10 | S2/#111 | validador CONFORME; security-review 0 achados",
  ].join("\n")), new Date("2026-10-28T17:15:00"));
  const i111 = item(decidido.itens, "#111");
  assert.equal(i111.status, "em andamento");
  assert.equal(i111.progresso, 0.8);
  assert.equal(decidido.resumo.espera_txt, "");
});

test("rodada PARADA recomeça do zero e espera o usuário; 'ready' solto no texto não é fase", () => {
  const linhas = lerLinhas([
    "2026-10-29 03:06 | R4/#179 | bloco 1: limpar-banco RC 0, seed Deg-28100",
    "2026-10-29 03:18 | R4/#179 | R4 PARADA: pedido-01 abortado no gerador",
    "2026-10-29 03:11 | S5/#47 | início: worktree; o PR vai ficar ready sem merge",
  ].join("\n"));
  const { resumo, itens } = calcular(linhas, new Date("2026-10-29T03:40:00"));
  const r4 = item(itens, "R4 (#179)");
  assert.equal(r4.status, "aguardando você");
  assert.equal(r4.progresso, 0);
  assert.match(resumo.espera_txt, /destravar a Rodada 4/);
  assert.ok(item(itens, "#47").progresso < 0.5, "'ready' no meio do texto não vale como PR ready");
});

test("rodada retomada recomeça a contar do zero; conclusão pelo coordenador fecha o item", () => {
  const linhas = lerLinhas([
    "2026-10-29 03:06 | R4/#179 | bloco 1: limpar-banco RC 0, seed Deg-28100",
    "2026-10-29 03:18 | R4/#179 | R4 PARADA: pedido-01 abortado no gerador",
    "2026-10-29 08:13 | R4/#179 | bloco 1 retomado: limpar-banco RC 0; seed Deg-46496",
    "2026-10-28 08:26 | T1/#166 | worktree E:/TCC/wt/Issue-166",
    "2026-10-28 09:45 | coordenador | T1/#166 CONCLUÍDA: PR #184 conferido",
    "2026-10-29 03:11 | S5/#47 | início: worktree",
    "2026-10-29 08:30 | coordenador | S5/#47 CONCLUÍDA: usuário confirmou D1–D4",
  ].join("\n"));
  const { itens } = calcular(linhas, new Date("2026-10-29T08:40:00"));
  const r4 = item(itens, "R4 (#179)");
  assert.equal(r4.status, "em andamento");
  assert.match(r4.inicio, /T08:13/);
  assert.ok(r4.restante_h > 2, "a rodada recomeçou, não está quase no fim");
  assert.equal(item(itens, "#166").status, "concluído");
  // A #47 depende da R4, ainda aberta: não fecha antes dela.
  assert.equal(item(itens, "#47").status, "em andamento");
});

test("parada do k6 por p95 não para a rodada; linha '- data hora' do coordenador fecha o item", () => {
  const linhas = lerLinhas([
    "2026-10-30 09:40 | R5/#180 | bloco 2 (retomada): braco C no ar",
    "2026-10-30 10:08 | R5/#180 | bloco 2: k6 RC 99, PARADA no degrau 44k (p95 janela 6415 ms)",
    "- 2026-10-30 10:14 R5 CONCLUÍDA: PR #218 mergeado na Batch_2; #180 fechada",
  ].join("\n"));
  const antes = calcular(linhas.slice(0, 2), new Date("2026-10-30T10:10:00"));
  assert.equal(item(antes.itens, "R5 (#180)").status, "em andamento");
  const r5 = item(calcular(linhas, new Date("2026-10-30T10:20:00")).itens, "R5 (#180)");
  assert.equal(linhas[2].escopo, "coordenador");
  assert.match(r5.passo, /^10:14 · R5 CONCLUÍDA/);
});

test("bloco concluído não fecha a rodada; previsão fica entre o cenário rápido e o lento", () => {
  const linhas = lerLinhas([
    "2026-10-29 03:00 | coord | R4 preflight: pg_test_fsync ok",
    "2026-10-29 04:00 | coord | R4 bloco 2 CONCLUÍDO (escada sem autoescala)",
  ].join("\n"));
  const { resumo, itens } = calcular(linhas, new Date("2026-10-29T04:30:00"));
  assert.equal(item(itens, "R4 (#179)").status, "em andamento");
  assert.ok(resumo.eta_min <= resumo.eta && resumo.eta <= resumo.eta_max);
  assert.ok(resumo.restante_min_h <= resumo.restante_h && resumo.restante_h <= resumo.restante_max_h);
});
