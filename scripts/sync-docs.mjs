// Gera docs/gerenciador-eventos/ e docs/decisoes-arquitetura/ do zero a cada chamada — conteúdo
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

  const testesManuaisDir = path.join(TCC_ROOT, "docs", "testes-manuais");
  if (existsSync(testesManuaisDir)) {
    for (const nome of readdirSync(testesManuaisDir)) {
      if (!nome.endsWith(".md")) continue;
      copiarArquivo(
        path.join(testesManuaisDir, nome),
        path.join(DEST_A, "docs", "testes-manuais", nome),
      );
      contagem += 1;
    }
  }

  contagem += copiarMdRecursivo(
    path.join(TCC_ROOT, "docs", "carga"),
    path.join(DEST_A, "docs", "carga"),
  );

  console.log(`[sync-docs] Fonte A (gerenciador-eventos): ${contagem} arquivo(s) copiado(s).`);
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

function reescreverWikilinks(corpo, mapaSlugs, nomeArquivoOrigem) {
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
    return `[${texto}](./${mapaSlugs.get(alvoLimpo)}.md)`;
  });
}

function sincronizarFonteB() {
  limparDestino(DEST_B);

  const notas = listarNotasVault();
  const mapaSlugs = new Map(notas.map((nome) => [nome, slugDestino(nome)]));

  for (const nome of notas) {
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

sincronizarFonteA();
sincronizarFonteB();
