import { readFileSync } from "node:fs";

/**
 * Painel "Tempo restante do Batch 2" do TCC: lê o ledger do batch (só leitura) e estima quanto falta.
 * Serve a rota `/batch2/estado.json` (página `/embed/batch2.html`) e a rotina que atualiza o mesmo
 * painel no claude.ai — as duas usam esta conta, para nunca mostrarem números diferentes.
 *
 * - `BATCH2_LEDGER` — caminho do ledger, padrão `E:/TCC/batch2-ledger.md`.
 */

const CAMINHO_LEDGER_PADRAO = "E:/TCC/batch2-ledger.md";
const H = 3600e3;
const PASSO_HISTORICO = 30 * 60e3;
const EST_EXTRA = [2, 2.5, 3.5];

// Plano do Batch 2 (goal_batch2.md). est = [rápida, central, lenta] em horas, do início ao merge.
const PLANO = [
  { id: "166", item: "#166", titulo: "Dono do token em /bff/users e /bff/my-wallets", est: [1, 1.5, 2.5], deps: [], escopo: /#166\b/ },
  { id: "170", item: "#170", titulo: "UPDATE único no PUT de usuário", est: [1.5, 2, 3], deps: [], escopo: /#170\b/ },
  { id: "171", item: "#171", titulo: "PUT de usuário ignora a senha", est: [1, 1.5, 2.5], deps: ["170"], escopo: /#171\b/ },
  { id: "84", item: "#84", titulo: "flutter_lints e analyze limpo", est: [1.5, 2.5, 3.5], deps: [], escopo: /#84\b/ },
  { id: "15", item: "#15", titulo: "Figuras da Fase 2 no artigo", est: [1.5, 2.5, 3.5], deps: [], escopo: /#15\b/ },
  { id: "41", item: "#41", titulo: "Contador de RPM no Redis", est: [2, 3, 4], deps: [], escopo: /#41\b/ },
  { id: "42", item: "#42", titulo: "Fila de admissão e worker pool", est: [3, 4, 5.5], deps: ["41"], escopo: /#42\b/ },
  { id: "43", item: "#43", titulo: "Modo de alta carga (202)", est: [2, 2.5, 3.5], deps: ["42"], escopo: /#43\b/ },
  { id: "177", item: "#177", titulo: "Imagens enxutas com o Slim", est: [2, 3, 4], deps: [], escopo: /#177\b/ },
  { id: "44", item: "#44", titulo: "Tela de reserva pending", est: [1, 1.25, 2], deps: ["43", "84"], escopo: /#44\b|(^|\/)S1\b/ },
  { id: "111", item: "#111", titulo: "Autoescala do gateway e do reservation", est: [3, 4, 5.5], deps: ["43", "177"], escopo: /#111\b/ },
  { id: "112", item: "#112", titulo: "Autoescala dos outros serviços", est: [2, 2.5, 3], deps: ["111"], escopo: /#112\b/ },
  { id: "178", item: "#178", titulo: "Harness da Rodada 4", est: [2, 2.5, 3.5], deps: ["112"], escopo: /#178\b|(^|\/)S3\b/ },
  { id: "R4", item: "R4 (#179)", titulo: "Rodada 4 no gerador", est: [3, 4, 5], deps: ["178"], escopo: /#179\b|(^|\/)R4\b/, texto: /^R4\b/, espera: /\bR4 em espera\b|segurar até de noite o R4/, rodada: true },
  { id: "47", item: "#47", titulo: "Saga stock + wallet", est: [5, 6.5, 8], deps: ["R4"], escopo: /#47\b|(^|\/)S5\b/ },
  { id: "S6", item: "S6 (#204)", titulo: "Harness da Rodada 5", est: [1, 1.5, 2], deps: ["47"], escopo: /#204\b|(^|\/)S6\b/, opcional: true },
  { id: "R5", item: "R5 (#180)", titulo: "Rodada 5 no gerador", est: [3, 3.5, 4.5], deps: ["S6"], escopo: /#180\b|(^|\/)R5\b/, texto: /^R5\b/, espera: /\bR5 em espera\b|segurar até de noite o R5/, rodada: true },
  { id: "F", item: "F (#46)", titulo: "READMEs e PR final", est: [1, 1.25, 1.5], deps: ["R5", "44"], escopo: /#46\b|(^|\/)F\b/, texto: /^F\b/ },
];
const NUMEROS_PLANO = new Set([166, 170, 171, 84, 15, 41, 42, 43, 177, 44, 111, 112, 178, 179, 47, 204, 180, 46]);

// A última linha que casa decide a fase (a revisão pode devolver o item ao gerador).
const FASES = [
  [/MUDANÇAS NECESSÁRIAS|MUDANCAS NECESSARIAS/, 0.45], [/PR #\d+ ready|-> ready/i, 0.95], [/gate 7\.5/, 0.9], [/PR #\d+ draft/i, 0.85],
  [/CONFORME/, 0.8], [/validador.*despachad/i, 0.72], [/revisor.*APROVADO/, 0.7], [/revisor.*despachad/i, 0.6],
  [/gerador.*(PRONTO|VERDE)/, 0.55], [/gerador.*despachad|despacho code-generator/i, 0.15], [/worktree|início/i, 0.05],
];
const MERGE = /(MERGED|MERGEADO) PR #\d+ na Batch_2|PR #\d+ (MERGED|MERGEADO) na Batch_2/;
const CONCLUI = /CONCLU[IÍ]D[AO]/;
const TRABALHO = /worktree|início|despach|preflight|preparação|bloco/i;

const pad = (n) => String(n).padStart(2, "0");
function iso(d) {
  if (!d) return null;
  const o = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00` +
    `${o >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`;
}
const r2 = (x) => Math.round(x * 100) / 100;
// O painel mostra o último passo do ledger: tira caminhos locais e o que tiver cara de segredo.
const limpar = (t) => t.replace(/\b[A-Za-z]:[\\/][^\s,;)]*/g, "…").replace(/\b(senha|password|token|secret|key)\s*[=:]\s*\S+/gi, "$1=…");
const ehLock = (l) => /^lock (pego|solto)|^(peguei|solto) o lock/.test(l.texto);

export function lerLinhas(texto) {
  // Além de "data hora | escopo | texto", o coordenador também escreve "- data hora texto" (conta como dele).
  return texto.split(/\r?\n/)
    .map((l) => l.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) \| ([^|]+?) \| (.*)$/) ??
      l.match(/^- (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) ()(.*)$/)).filter(Boolean)
    .map(([, d, h, escopo, texto]) => ({ t: new Date(`${d}T${h}:00`), escopo: escopo.trim() || "coordenador", texto: texto.trim() }));
}

function ler(doItem, { opcional, rodada, espera } = {}) {
  let inicio = null, primeira = null, p = 0, passo = null, pendente = false, aguardaOk = false, parada = false;
  const fins = [];
  for (const l of doItem) {
    if (/^re-ancoragem|issue nova/.test(l.texto)) continue;
    if (!ehLock(l)) passo = l;
    const ok = /\bok (do usuário|inicial)\b/i.test(l.texto);
    const okDado = ok && /recebid|concedid|dado|liberad|aprovad/i.test(l.texto);
    if (ok && !okDado && /pedid|aguard|espera|solicit/i.test(l.texto)) { aguardaOk = true; continue; }
    if (okDado) aguardaOk = false;
    if (/PENDENTE DE DECISÃO/.test(l.texto)) pendente = true;
    else if (/DECISÃO/.test(l.texto) || /aceit[ao]s? pela interface/i.test(l.texto)) pendente = false;
    // Rodada abortada ou posta em espera recomeça do zero e espera o usuário destravar.
    // "PARADA no degrau 44k" / "PARADA p95" é o k6 parando pelo threshold, não a rodada parada.
    if (rodada && (/\bPARADA\b(?!\s+(no degrau|p95|por p95))/.test(l.texto) || espera?.test(l.texto))) parada = true;
    else if (parada && /retomad/i.test(l.texto)) { parada = false; inicio = l.t; p = 0; }
    primeira ??= l.t;
    if (!inicio && TRABALHO.test(l.texto)) inicio = l.t;
    // Numa rodada, "bloco 2 ... CONCLUÍDO" não fecha a rodada inteira.
    const concluiu = CONCLUI.test(l.texto) && !(rodada && /bloco|degrau|escada|preflight|preparação/i.test(l.texto));
    if (MERGE.test(l.texto) || concluiu || (opcional && /dispensad/i.test(l.texto))) fins.push(l.t);
    if (!ehLock(l)) { const f = FASES.find(([re]) => re.test(l.texto)); if (f) p = f[1]; }
  }
  return { inicio: inicio ?? primeira, fim: fins[0] ?? null, fins, p, passo, pendente, aguardaOk, parada };
}

const lista = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} e ${xs.at(-1)}`);

/** A conta do painel com o ledger até `agora`: a linha de resumo e uma linha por item. */
export function calcular(linhas, agora) {
  // Linha do coordenador ("coord" ou "coordenador") conta para o item que abre o texto, como em "S5/#47 CONCLUÍDA".
  const doItem = (i, l) => i.escopo.test(l.escopo) ||
    (/^coord(enador)?$/.test(l.escopo) && (i.escopo.test(l.texto.split(/[\s:]/)[0]) || Boolean(i.texto?.test(l.texto)) || Boolean(i.espera?.test(l.texto))));
  const plano = PLANO.map((i) => ({ ...i, ...ler(linhas.filter((l) => doItem(i, l)), i) }));
  // Issues fora do plano que o batch acabou puxando: entram com a estimativa padrão, em paralelo.
  const porNumero = new Map();
  for (const l of linhas) for (const m of l.escopo.matchAll(/#(\d+)/g)) {
    const n = Number(m[1]);
    if (NUMEROS_PLANO.has(n)) continue;
    if (!porNumero.has(n)) porNumero.set(n, []);
    porNumero.get(n).push(l);
  }
  const extras = [...porNumero].map(([n, ls]) => ({ id: `x${n}`, item: `#${n}`, titulo: `Issue #${n}`, est: EST_EXTRA, deps: [], ...ler(ls) }))
    .filter((i) => i.inicio);
  const todos = [...plano, ...extras];
  // Um item não fecha antes das dependências (ex.: um PR parcial do F com a R5 ainda aberta). O plano vem em ordem.
  // Fechadas as dependências, vale o primeiro fechamento depois delas (o PR parcial de antes não conta);
  // se não houver nenhum depois, o último.
  for (const i of plano) {
    if (!i.fim) continue;
    const depFins = i.deps.map((d) => plano.find((x) => x.id === d)?.fim);
    i.fim = depFins.some((f) => !f) ? null : i.fins.find((t) => t >= Math.max(0, ...depFins.map(Number))) ?? i.fins.at(-1);
  }

  // Ritmo: quanto as etapas do plano já fechadas levaram perto do estimado (4 h a 1,0 de peso, para não oscilar).
  const fechadas = plano.filter((i) => i.inicio && i.fim);
  const ritmo = Math.min(1.6, Math.max(0.6,
    (fechadas.reduce((s, i) => s + (i.fim - i.inicio) / H, 0) + 4) / (fechadas.reduce((s, i) => s + i.est[1], 0) + 4)));

  for (const i of todos) {
    if (i.fim || !i.inicio) continue;
    if (i.parada) { i.progresso = 0; i.restante = i.est.map((e) => e * ritmo); continue; }
    const pTempo = Math.min((agora - i.inicio) / H / (i.est[1] * ritmo), i.rodada ? 0.9 : 0.5);
    i.progresso = Math.max(i.p, pTempo);
    i.restante = i.est.map((e) => Math.max(e * ritmo * (1 - i.progresso), 0.1));
  }

  // Caminho crítico nos três cenários: o que não começou espera as dependências.
  const fins = [{}, {}, {}];
  const inicioPrev = {};
  for (const k of [0, 1, 2]) for (const i of todos) {
    if (i.fim) fins[k][i.id] = i.fim;
    else if (i.inicio) fins[k][i.id] = new Date(+agora + i.restante[k] * H);
    else {
      const ini = new Date(Math.max(+agora, ...i.deps.map((d) => +(fins[k][d] ?? agora))));
      if (k === 1) inicioPrev[i.id] = ini;
      fins[k][i.id] = new Date(+ini + i.est[k] * ritmo * H);
    }
  }
  const eta = fins.map((f) => new Date(Math.max(+agora, ...Object.values(f).map(Number))));
  const restante = eta.map((e) => (e - agora) / H);

  const feito = (id) => Boolean(todos.find((x) => x.id === id)?.fim);
  for (const i of todos) {
    i.status = i.fim ? "concluído"
      : i.inicio ? (i.parada ? "aguardando você" : i.pendente ? "aguardando decisão" : i.aguardaOk ? "aguardando seu ok" : "em andamento")
        : i.rodada && i.deps.every(feito) ? "aguardando seu ok" : "na fila";
  }

  const chave = (i) => (i.fim ? [0, +i.fim] : i.inicio ? [1, +i.inicio] : [2, PLANO.findIndex((x) => x.id === i.id)]);
  const ordenados = [...todos].sort((a, b) => chave(a)[0] - chave(b)[0] || chave(a)[1] - chave(b)[1]);
  const itens = ordenados.map((i, n) => ({
    tipo: "item", ordem: n + 1, item: i.item, titulo: i.titulo, status: i.status,
    inicio: iso(i.inicio), inicio_prev: iso(i.inicio ?? inicioPrev[i.id]), termino: iso(fins[1][i.id]),
    fim_max: i.fim ? null : iso(fins[2][i.id]), duracao_h: i.fim && i.inicio ? r2((i.fim - i.inicio) / H) : null,
    restante_h: i.fim ? null : r2(i.restante ? i.restante[1] : i.est[1] * ritmo),
    progresso: i.fim ? 1 : r2(i.progresso ?? 0),
    passo: i.passo ? `${pad(i.passo.t.getHours())}:${pad(i.passo.t.getMinutes())} · ${limpar(i.passo.texto)}`.slice(0, 160) : null,
  }));
  const resumo = {
    tipo: "resumo", sync_at: iso(agora), ledger_at: iso(linhas.at(-1)?.t), eta: iso(eta[1]), eta_min: iso(eta[0]), eta_max: iso(eta[2]),
    restante_h: r2(restante[1]), restante_min_h: r2(restante[0]), restante_max_h: r2(restante[2]),
    concluidos: todos.filter((i) => i.fim).length, total: todos.length, ritmo: r2(ritmo),
    agora_txt: lista(todos.filter((i) => i.inicio && !i.fim).map((i) => `${i.item} (${i.titulo})`)),
    espera_txt: lista([
      ...todos.filter((i) => i.status === "aguardando decisão").map((i) => `a decisão pendente na ${i.item}`),
      ...todos.filter((i) => i.status === "aguardando você").map((i) => `você destravar a ${i.titulo.replace(" no gerador", "")}`),
      ...todos.filter((i) => i.status === "aguardando seu ok").map((i) => `o seu ok para a ${i.titulo.replace(" no gerador", "")}`),
    ]),
  };
  return { resumo, itens };
}

/**
 * O painel inteiro, pronto para o JSON: resumo, itens e o histórico da previsão. O histórico não
 * guarda estado: é a mesma conta refeita a cada 30 min só com o ledger até aquele momento.
 */
export function lerPainelBatch2({ caminhoLedger = process.env.BATCH2_LEDGER ?? CAMINHO_LEDGER_PADRAO, agora = new Date() } = {}) {
  const linhas = lerLinhas(readFileSync(caminhoLedger, "utf8"));
  const { resumo, itens } = calcular(linhas, agora);
  const ponto = (r) => ({ tipo: "historico", at: r.sync_at, restante_h: r.restante_h, restante_min_h: r.restante_min_h, restante_max_h: r.restante_max_h });
  const historico = [];
  if (linhas.length) {
    for (let t = Math.ceil(+linhas[0].t / PASSO_HISTORICO) * PASSO_HISTORICO; t < +agora - 60e3; t += PASSO_HISTORICO) {
      historico.push(ponto(calcular(linhas.filter((l) => +l.t <= t), new Date(t)).resumo));
    }
  }
  historico.push(ponto(resumo));
  return [resumo, ...itens, ...historico];
}
