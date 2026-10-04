// Gera docs/gerenciador-eventos/, docs/testes/ e docs/decisoes-arquitetura/ do zero a cada chamada — conteúdo
// gerado, nunca editado à mão, nunca versionado (ver .gitignore). Roda como parte de
// `docs:build`/`docs:start` (nunca precisa ser chamado sozinho em uso normal).

import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const TCC_ROOT = "E:\\TCC\\GerenciadorEventos";
const VAULT_ROOT = "D:\\Claude\\Brain\\01-Projects\\Event-Management-System";

const DEST_A = path.join(RAIZ, "docs", "gerenciador-eventos");
const DEST_B = path.join(RAIZ, "docs", "decisoes-arquitetura");
const DEST_C = path.join(RAIZ, "docs", "testes");

const RESULTADOS_SRC = path.join(TCC_ROOT, "docs", "carga", "harness", "resultados");
const RESULTADOS_STATIC = path.join(RAIZ, "static", "resultados-testes");

// ---- Fonte A: E:\TCC\GerenciadorEventos -> docs/gerenciador-eventos/ ----
// Whitelist explícita, árvore relativa preservada, sem reescrita de link (já são links markdown
// relativos válidos). docs/adr/** é excluído de propósito — é cópia manual desatualizada do vault,
// a Fonte B é a única fonte de verdade para arquitetura.

const WHITELIST_A = [
  "CLAUDE.md",
  "README.md",
  "BACKLOG.md",
  "Projeto/Backend/CLAUDE.md",
  "Projeto/Backend/db/CLAUDE.md",
  "Projeto/frontend/CLAUDE.md",
];

function limparDestino(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

// Docusaurus compila todo `.md` via MDX (mesmo com extensão .md) — um `{id}` ou `{email}` soltos
// em prosa (fora de code span) viram uma expressão JS de verdade, e quebram o build com
// `ReferenceError: id is not defined` em vez de um erro de sintaxe claro. `{`/`}` dentro de code
// span ou bloco cercado (` `` `/``` ```) nunca são tocados — só o resto do texto.
function escaparChavesForaDeCodigo(texto) {
  return texto.replace(/(`+)[\s\S]*?\1|([{}])/g, (trecho, _crases, chave) => {
    if (!chave) return trecho; // code span/bloco cercado: preservado intacto
    return chave === "{" ? "\\{" : "\\}";
  });
}

function copiarArquivo(origem, destino) {
  mkdirSync(path.dirname(destino), { recursive: true });
  const conteudo = escaparChavesForaDeCodigo(readFileSync(origem, "utf8"));
  writeFileSync(destino, conteudo);
}

function copiarMdRecursivo(origemDir, destinoDir) {
  if (!existsSync(origemDir)) return 0;
  let contagem = 0;
  for (const entrada of readdirSync(origemDir, { withFileTypes: true })) {
    const origemCaminho = path.join(origemDir, entrada.name);
    const destinoCaminho = path.join(destinoDir, entrada.name);
    if (entrada.isDirectory()) {
      contagem += copiarMdRecursivo(origemCaminho, destinoCaminho);
    } else if (entrada.name.endsWith(".md")) {
      copiarArquivo(origemCaminho, destinoCaminho);
      contagem += 1;
    }
  }
  return contagem;
}

function sincronizarFonteA() {
  limparDestino(DEST_A);
  let contagem = 0;

  for (const relativo of WHITELIST_A) {
    const origem = path.join(TCC_ROOT, relativo);
    if (!existsSync(origem)) {
      console.warn(`[sync-docs] Fonte A: arquivo esperado não encontrado, pulando: ${relativo}`);
      continue;
    }
    copiarArquivo(origem, path.join(DEST_A, relativo));
    contagem += 1;
  }

  console.log(`[sync-docs] Fonte A (gerenciador-eventos): ${contagem} arquivo(s) copiado(s).`);
}

// ---- Fonte C: testes (manuais + carga) do mesmo repo -> docs/testes/ (seção dedicada) ----

function sincronizarFonteC() {
  limparDestino(DEST_C);
  const contagem =
    copiarMdRecursivo(path.join(TCC_ROOT, "docs", "testes-manuais"), path.join(DEST_C, "testes-manuais")) +
    copiarMdRecursivo(path.join(TCC_ROOT, "docs", "carga"), path.join(DEST_C, "carga"));
  console.log(`[sync-docs] Fonte C (testes): ${contagem} arquivo(s) copiado(s).`);
}

// ---- Fonte B: vault Obsidian -> docs/decisoes-arquitetura/ (flatten) ----

const RENOMEIOS = new Map([["_Event-Management-System", "visao-geral"]]);
const CAMPOS_FRONTMATTER_DESCARTADOS = new Set(["project", "subproject", "type", "created"]);

// Ordem de leitura sugerida (visão geral -> fundamentos -> cada ADR na ordem em que foi decidida
// -> implementação -> roadmap -> referências por último, como numa seção de bibliografia). Sem
// isso a sidebar autogerada cai em ordem alfabética, que deixa "visao-geral" por último — o
// oposto do que faz sentido como porta de entrada da seção. Chaveado pelo slug de destino (pós
// renomeio); nota nova sem entrada aqui cai no fim (posição 999), sem quebrar a ordem das outras.
const ORDEM_B = new Map([
  ["visao-geral", 1],
  ["Backend-Architecture", 2],
  ["Database-Schema", 3],
  ["Architecture-Decision-Stock-Isolation", 4],
  ["Architecture-Decision-Async-Checkout-Queue", 5],
  ["Architecture-Decision-Microservices-Split", 6],
  ["Architecture-Decision-Supabase-Self-Host", 7],
  ["Implementacao-EventCap-e-Reserva-CAS", 8],
  ["Roadmap-e-Issues", 9],
  ["References", 10],
]);

// Rótulo curto pra sidebar, distinto do `# H1` da página (que fica intacto no corpo). O H1 de
// algumas notas é um subtítulo inteiro ("Decisão de Arquitetura — Fila Assíncrona de Checkout e
// Reserva com Expiração em Alta Carga") — bom como título da página, ruim como item de lista.
const ROTULOS_B = new Map([
  ["visao-geral", "Visão Geral"],
  ["Backend-Architecture", "Arquitetura de Backend"],
  ["Database-Schema", "Schema do Banco"],
  ["Architecture-Decision-Stock-Isolation", "ADR: Estoque Isolado"],
  ["Architecture-Decision-Async-Checkout-Queue", "ADR: Fila Assíncrona de Checkout"],
  ["Architecture-Decision-Microservices-Split", "ADR: Split em Microsserviços"],
  ["Architecture-Decision-Supabase-Self-Host", "ADR: Supabase Self-Hosted"],
  ["Implementacao-EventCap-e-Reserva-CAS", "Implementação: EventCap + CAS"],
  ["Roadmap-e-Issues", "Roadmap e Issues"],
  ["References", "Referências"],
]);

function listarNotasVault() {
  return readdirSync(VAULT_ROOT, { withFileTypes: true })
    .filter((entrada) => entrada.isFile() && entrada.name.endsWith(".md"))
    .map((entrada) => entrada.name.slice(0, -3));
}

function slugDestino(nomeNota) {
  return RENOMEIOS.get(nomeNota) ?? nomeNota;
}

function parseFrontmatter(bruto) {
  const casamento = bruto.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!casamento) return { dados: {}, corpo: bruto };

  const dados = {};
  for (const linha of casamento[1].split(/\r?\n/)) {
    const indice = linha.indexOf(":");
    if (indice === -1) continue;
    const chave = linha.slice(0, indice).trim();
    const valorBruto = linha.slice(indice + 1).trim();
    if (valorBruto === "") continue;
    if (valorBruto.startsWith("[") && valorBruto.endsWith("]")) {
      dados[chave] = valorBruto
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    } else {
      dados[chave] = valorBruto;
    }
  }
  return { dados, corpo: bruto.slice(casamento[0].length) };
}

// Título nunca vai pro frontmatter gerado: toda nota do vault já abre com `# H1`, e o Docusaurus
// infere o título da página a partir dele quando não há `title` no frontmatter — declarar os dois
// ao mesmo tempo duplicaria o cabeçalho visível na página.
function montarFrontmatterNovo(dadosOriginais, sidebarPosition, sidebarLabel) {
  const linhas = [`sidebar_position: ${sidebarPosition}`];
  if (sidebarLabel) linhas.push(`sidebar_label: "${sidebarLabel}"`);
  const tags = Array.isArray(dadosOriginais.tags) ? dadosOriginais.tags : null;
  if (tags && tags.length > 0) linhas.push(`tags: [${tags.join(", ")}]`);
  return `---\n${linhas.join("\n")}\n---\n\n`;
}

// Nota do vault que vira a página Testes > Resultados (e não entra em Decisões de Arquitetura).
const NOTA_RESULTADOS = "Resultados-Testes-de-Carga";

function reescreverWikilinks(corpo, mapaSlugs, nomeArquivoOrigem, prefixo = "./") {
  // Embeds de imagem (`![[...]]`) não têm lógica de cópia de anexo implementada ainda — hoje
  // nenhuma nota do vault tem um, então só avisamos se aparecer, sem tentar tratar.
  const embeds = corpo.match(/!\[\[[^\]]+\]\]/g);
  if (embeds) {
    for (const embed of embeds) {
      console.warn(`[sync-docs] ${nomeArquivoOrigem}: embed não suportado encontrado, ignorado: ${embed}`);
    }
  }

  return corpo.replace(/(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, alvo, textoExibido) => {
    const alvoLimpo = alvo.trim();
    const texto = (textoExibido ?? alvoLimpo).trim();
    if (!mapaSlugs.has(alvoLimpo)) {
      console.warn(`[sync-docs] ${nomeArquivoOrigem}: wikilink fora do escopo sincronizado, degradado pra texto: [[${alvoLimpo}]]`);
      return texto;
    }
    if (alvoLimpo === NOTA_RESULTADOS) return `[${texto}](${prefixo === "./" ? "../testes" : "."}/resultados/index.md)`;
    return `[${texto}](${prefixo}${mapaSlugs.get(alvoLimpo)}.md)`;
  });
}

function sincronizarFonteB() {
  limparDestino(DEST_B);

  const notas = listarNotasVault();
  const mapaSlugs = new Map(notas.map((nome) => [nome, slugDestino(nome)]));

  for (const nome of notas.filter((n) => n !== NOTA_RESULTADOS)) {
    const bruto = readFileSync(path.join(VAULT_ROOT, `${nome}.md`), "utf8");
    const { dados, corpo } = parseFrontmatter(bruto);
    const corpoReescrito = escaparChavesForaDeCodigo(
      reescreverWikilinks(corpo.trimStart(), mapaSlugs, `${nome}.md`),
    );
    const timestamp = new Date().toISOString();
    const rodape = `\n\n---\n\n*Sincronizado automaticamente de \`${nome}.md\` em ${timestamp}.*\n`;

    const slug = slugDestino(nome);
    const sidebarPosition = ORDEM_B.get(slug) ?? 999;
    const sidebarLabel = ROTULOS_B.get(slug);
    const conteudoFinal = `${montarFrontmatterNovo(dados, sidebarPosition, sidebarLabel)}${corpoReescrito}${rodape}`;
    writeFileSync(path.join(DEST_B, `${slug}.md`), conteudoFinal);
  }

  console.log(`[sync-docs] Fonte B (decisoes-arquitetura): ${notas.length} nota(s) sincronizada(s).`);
}

// ---- Fonte C (resultados): resultado.html de cada run -> static/resultados-testes/ + índice MD ----

// Reorganiza a nota do vault: tudo sob "Fase 1", seções nomeadas "Tipo - braço" (cas/naive).
function paginaVaultResultados() {
  const arquivo = path.join(VAULT_ROOT, `${NOTA_RESULTADOS}.md`);
  if (!existsSync(arquivo)) return "";
  const notas = listarNotasVault();
  const mapaSlugs = new Map(notas.map((nome) => [nome, slugDestino(nome)]));
  const { corpo } = parseFrontmatter(readFileSync(arquivo, "utf8"));
  const linhas = reescreverWikilinks(corpo.trim(), mapaSlugs, `${NOTA_RESULTADOS}.md`, "../../decisoes-arquitetura/").split(/\r?\n/);

  // A tabela do braço naive mistura Disputa e RPM: separa por tipo de teste.
  const ini = linhas.findIndex((l) => l.startsWith("| Teste | Rodada"));
  let tabNaive = [];
  if (ini !== -1) {
    let fim = ini;
    while (linhas[fim]?.startsWith("|")) fim++;
    tabNaive = linhas.splice(ini, fim - ini);
  }
  const [cab, sep, ...linhasTab] = tabNaive;
  const tabela = (tipo) => [cab, sep, ...linhasTab.filter((l) => l.startsWith(`| ${tipo}`))];

  const saida = [];
  let fase = false;
  for (const l of linhas) {
    let m;
    if (l.startsWith("# ")) {
      saida.push(l);
      continue;
    }
    if (!fase && l.startsWith("## ")) {
      saida.push(
        ":::info cas × naive",
        "Os dois são **caminhos de reserva** (`RESERVATION_READPATH`) comparados no experimento do TCC, com a mesma carga, o mesmo host e o mesmo pool de conexões:",
        "",
        "- **`cas`** (compare-and-set): a vaga é reservada por um `UPDATE` condicional atômico em `eventcap` (só decrementa se ainda houver vaga). É a implementação correta: **nunca vende além da capacidade** (overselling = 0).",
        "- **`naive`**: braço de controle, de propósito ingênuo. Checa \"tem vaga?\" em `event_availability` (read model recalculado a cada 5 s, logo um número velho) e insere em `walletevent` **sem tocar `eventcap`**. Quando muitas tentativas chegam ao mesmo evento dentro da janela de 5 s (Disputa e RPM), todas passam na checagem e **vende além da capacidade** (overselling > 0). No Aleatório, onde as tentativas se espalham entre 1464 eventos, o overselling foi 0.",
        "",
        "Cada seção abaixo se chama `Tipo de teste - braço`: **Disputa** (N clientes × 1 evento), **RPM** (taxa fixa de reservas/min) ou **Aleatório** (45 min de carga variável).",
        ":::",
        "",
      );
      saida.push("## Fase 1", "");
      fase = true;
    }
    if ((m = l.match(/^## Teste \d+ — (\S+) \((.*)\)$/))) {
      saida.push(`### ${m[1]} - cas`, "", `*${m[2]}*`);
    } else if (l.startsWith("## Braço de controle")) {
      saida.push("### Disputa - naive", "", ...tabela("Disputa"), "", "### RPM - naive", "", ...tabela("RPM"), "", "### Análise do braço `naive`");
    } else if (l.startsWith("### Aleatório 45 min")) {
      saida.push("### Aleatório - naive");
    } else {
      saida.push(l.replace(/^(#{2,3}) /, "#$1 "));
    }
  }
  return saida.join("\n");
}

// ---- Dados brutos de Projeto/carga/results (CSVs, summaries, verificacoes.log) -> tabelas ----

function lerCsv(arquivo) {
  if (!existsSync(arquivo)) return [];
  const [cab, ...linhas] = readFileSync(arquivo, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
  const cols = cab.split(",");
  return linhas.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
}

const num = (v) => (v === undefined || v === "" ? "—" : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 1 }));
const dataBr = (iso) => iso.replace(/^(\d{4})-(\d\d)-(\d\d)T/, "$3/$2 ").slice(0, 11);
const confirma = (r) => (r.pct_confirma ? `${r.pct_confirma}% (${num(r.confirmadas)})` : "—");

function tabelaMd(cabecalho, linhas) {
  return [`| ${cabecalho.join(" | ")} |`, `|${cabecalho.map((_, i) => (i < 2 ? "---" : "--:")).join("|")}|`, ...linhas.map((l) => `| ${l.join(" | ")} |`)];
}

function verificacoesBanco(arquivo) {
  if (!existsSync(arquivo)) return [];
  const bruto = readFileSync(arquivo, "utf8").replace(/^﻿/, "");
  return bruto.split("===== ").slice(1).map((bloco) => {
    const cab = bloco.match(/^(\S+ \S+) \| (?:evento (\d+)|prefixo (\S+)) \| config: (\w+)/);
    const dados = bloco.match(/-\+-[-+]+\r?\n\s*(\d+) \|\s*(\d+) \|\s*(\d+) \|\s*(\d+) \|\s*(\d+)/);
    const status = [...bloco.matchAll(/^\s*(confirmed|pending|expired|cancelled|canceled)\s*\|\s*(\d+)/gm)].map((m) => `${num(m[2])} ${m[1]}`);
    if (!cab) return null;
    const base = { quando: dataBr(cab[1].replace(" ", "T")), alvo: cab[2] ? `evento ${cab[2]}` : cab[3], disputa: Boolean(cab[2]), braco: cab[4], status: status.join(", ") };
    if (dados) return { ...base, eventos: dados[1], ativas: dados[2], cap: dados[3], evOver: dados[4], over: dados[5] };
    // Disputa: eventcap (capacity | vagas_restantes) e, quando existe, ativas | capacity | overselling.
    const cap = bloco.match(/eventcap\s*\|\s*(\d+)\s*\|\s*(-?\d+)/);
    const ativ = bloco.match(/ativas \| capacity \| overselling\s*\r?\n[-+]+\r?\n\s*(\d+) \|\s*(\d+) \|\s*(\d+)/);
    return { ...base, cap: cap?.[1], vagas: cap?.[2], ativas: ativ?.[1], over: ativ?.[3] };
  }).filter(Boolean);
}

// Uma tabela por braço (cas/naive), na ordem em que aparecem no CSV.
function tabelasPorBraco(out, tipo, linhas, cabecalho, mapa) {
  for (const braco of new Set(linhas.map((r) => r.rotulo))) {
    out.push(`#### ${tipo} - ${braco} (todas as rodadas)`, "", ...tabelaMd(cabecalho, linhas.filter((r) => r.rotulo === braco).map(mapa)), "");
  }
}

function dadosBrutosCarga() {
  const dir = path.join(TCC_ROOT, "Projeto", "carga", "results");
  if (!existsSync(dir)) return "";
  const out = ["### Dados completos por rodada", "", "Fonte: `Projeto/carga/results/` (`resultados*.csv`, `verificacoes.log`, `baseline-*.txt`). Datas em dia/mês hora, 04/10/2026.", ""];

  const base = readdirSync(dir).find((f) => f.startsWith("baseline-"));
  if (base) {
    out.push("#### Ambiente (baseline de rede)", "", ...readFileSync(path.join(dir, base), "utf8").replace(/^﻿/, "").trim().split(/\r?\n/).map((l) => `- ${l.replace("<HOST_IP>", "host").replace(/<([^>]*)>/g, "`$1`")}`), "");
  }

  const disputa = lerCsv(path.join(dir, "resultados.csv"));
  tabelasPorBraco(out, "Disputa", disputa,
    ["Data", "Evento", "Clientes", "Vagas", "Aceitas", "Lotado", "Outros", "Overselling", "p50 ms", "p95 ms", "p99 ms", "Máx ms", "Duração s", "Vazão/s", "Confirma", "Confirma p95 ms"],
    (r) => [dataBr(r.data), r.event_id, r.clientes, r.capacidade, r.aceitas, r.lotado, r.outros, r.overselling_cliente, num(r.p50_ms), num(r.p95_ms), num(r.p99_ms), num(r.max_ms), num(r.duracao_s), num(r.reservas_por_s), confirma(r), num(r.confirma_p95_ms)],
  );

  const rpm = lerCsv(path.join(dir, "resultados-rpm.csv"));
  tabelasPorBraco(out, "RPM", rpm,
    ["Rodada", "Data", "max_conn", "RPM alvo", "RPM real", "Duração s", "Eventos", "Aceitas", "Lotado", "5xx", "Descartadas", "p50 ms", "p95 ms", "p99 ms", "Máx ms", "Confirma", "Confirma p95 ms"],
    (r) => [`\`${r.prefixo}\``, dataBr(r.data), r.max_connections, num(r.rpm_alvo), num(r.rpm_real), num(r.duracao_s), r.eventos, num(r.aceitas), num(r.lotado), num(r.erros_5xx), num(r.descartadas), num(r.p50_ms), num(r.p95_ms), num(r.p99_ms), num(r.max_ms), confirma(r), num(r.confirma_p95_ms)],
  );

  const ale = lerCsv(path.join(dir, "resultados-aleatorio.csv"));
  tabelasPorBraco(out, "Aleatório", ale,
    ["Rodada", "Data", "Semente", "RPM mín–máx", "RPM médio", "Duração s", "Eventos", "Aceitas", "Lotado", "5xx", "Leituras ok", "Leituras outras", "Descartadas", "VUs máx", "Reserva p50/p95/p99 ms", "Leitura p50/p95/p99 ms", "Máx ms", "Confirma"],
    (r) => [`\`${r.prefixo}\``, dataBr(r.data), r.semente, `${num(r.rpm_min)}–${num(r.rpm_max)}`, num(r.rpm_medio), num(r.duracao_s), num(r.eventos), num(r.aceitas), num(r.lotado), num(r.erros_5xx), num(r.leituras_ok), num(r.leituras_outros), num(r.descartadas), r.vus_max, `${num(r.reserva_p50_ms)} / ${num(r.reserva_p95_ms)} / ${num(r.reserva_p99_ms)}`, `${num(r.leitura_p50_ms)} / ${num(r.leitura_p95_ms)} / ${num(r.leitura_p99_ms)}`, num(r.max_ms), confirma(r)],
  );

  const ver = verificacoesBanco(path.join(dir, "verificacoes.log"));
  out.push("#### Verificação do banco - Disputa (cas e naive)", "", "Overselling = reservas ativas acima da capacidade, medido direto no Postgres após cada rodada. `eventcap` é o contador oficial de vagas (o `naive` nunca o decrementa).", "", ...tabelaMd(
    ["Data", "Evento", "Braço", "Capacidade", "Vagas restantes (eventcap)", "Reservas ativas", "Overselling", "Status no banco"],
    ver.filter((v) => v.disputa).map((v) => [v.quando, `\`${v.alvo}\``, v.braco, num(v.cap), num(v.vagas), num(v.ativas), num(v.over), v.status]),
  ), "");
  out.push("#### Verificação do banco - RPM e Aleatório (cas e naive)", "", ...tabelaMd(
    ["Data", "Rodada", "Braço", "Eventos", "Reservas ativas", "Capacidade", "Eventos c/ overselling", "Overselling total", "Status no banco"],
    ver.filter((v) => !v.disputa).map((v) => [v.quando, `\`${v.alvo}\``, v.braco, v.eventos, num(v.ativas), num(v.cap), v.evOver, num(v.over), v.status]),
  ), "");
  return out.join("\n");
}

function sincronizarResultados() {
  // Legado: antes os relatórios HTML eram copiados para static/ e abertos em outra guia.
  rmSync(RESULTADOS_STATIC, { recursive: true, force: true });

  if (!existsSync(RESULTADOS_SRC)) {
    console.warn("[sync-docs] Fonte C (resultados): pasta não encontrada, pulando.");
    return;
  }

  // Um run = resultado.csv (metrica,valor,unidade). Agrupa por teste + braço (readpath).
  const grupos = new Map();
  let contagem = 0;
  for (const e of readdirSync(RESULTADOS_SRC, { withFileTypes: true })) {
    const csv = path.join(RESULTADOS_SRC, e.name, "resultado.csv");
    if (!e.isDirectory() || !existsSync(csv)) continue;
    const m = Object.fromEntries(
      readFileSync(csv, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(",")),
    );
    const html = path.join(RESULTADOS_SRC, e.name, "resultado.html");
    const data = (existsSync(html) && readFileSync(html, "utf8").match(/gerado em (\d{4})-(\d\d)-(\d\d)T(\d\d:\d\d)/)) || [];
    const chave = `Disputa - ${m.readpath}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push({ ...m, iso: data.slice(1, 5).join(""), quando: data.length ? `${data[3]}/${data[2]}/${data[1]} ${data[4]}` : "—" });
    contagem++;
  }

  const n = (v) => Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  const linhas = [
    "---",
    'sidebar_label: "Resultados de Carga"',
    "sidebar_position: 10",
    "---",
    "",
    "",
    paginaVaultResultados(),
    "",
    dadosBrutosCarga(),
    "",
  ];
  if (grupos.size) {
    linhas.push(
      "### Harness inicial (issue #11)",
      "",
      "Disputa de N clientes (VUs) por poucas vagas, rodada em 04/09/2026 pelo harness (`docs/carga/harness/`). Lag = atraso do read model (`event_availability`).",
      "",
    );
  }
  for (const [titulo, runs] of [...grupos].sort()) {
    runs.sort((a, b) => a.iso.localeCompare(b.iso));
    linhas.push(
      `#### ${titulo}`,
      "",
      "| Data | VUs | Vagas | Confirmadas | Corretude | p50 (ms) | p95 (ms) | p99 (ms) | Vazão (res/s) | Lag médio (ms) | Lag máx (ms) |",
      "|---|--:|--:|--:|:-:|--:|--:|--:|--:|--:|--:|",
      ...runs.map((r) =>
        `| ${r.quando} | ${r.n_vus} | ${r.capacity} | ${r.confirmadas} | ${r.veredito_corretude === "OK" ? "✅ OK" : "❌ " + r.veredito_corretude} | ${n(r.latencia_p50)} | ${n(r.latencia_p95)} | ${n(r.latencia_p99)} | ${n(r.throughput)} | ${n(r.lag_medio)} | ${n(r.lag_max)} |`,
      ),
      "",
    );
  }

  const resultadosDir = path.join(DEST_C, "resultados");
  mkdirSync(resultadosDir, { recursive: true });
  writeFileSync(
    path.join(resultadosDir, "_category_.json"),
    JSON.stringify({ label: "Resultados", position: 3, collapsible: true, collapsed: false }, null, 2),
  );
  writeFileSync(path.join(resultadosDir, "index.md"), escaparChavesForaDeCodigo(linhas.join("\n")));
  const analise = path.join(TCC_ROOT, "Projeto", "carga", "results", "ANALISE.md");
  if (existsSync(analise)) {
    const corpo = readFileSync(analise, "utf8").replace(/^﻿/, "");
    writeFileSync(path.join(resultadosDir, "analise.md"), escaparChavesForaDeCodigo(`---\nsidebar_label: "Análise dos Resultados"\nsidebar_position: 11\n---\n\n${corpo}`));
  }
  console.log(`[sync-docs] Fonte C (resultados): ${contagem} run(s) consolidado(s).`);
}

sincronizarFonteA();
sincronizarFonteB();
sincronizarFonteC();
sincronizarResultados();
