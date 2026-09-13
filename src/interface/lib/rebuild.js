import { exec } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const RAIZ = fileURLToPath(new URL("../../..", import.meta.url));
const CAMINHO_MARCADOR = fileURLToPath(new URL("../../../build/index.html", import.meta.url));

let emAndamento = false;

// "Última atualização" nunca é um estado guardado à parte — é só o mtime do build já em disco.
// Sobrevive a reinícios do servidor de graça, e nunca pode ficar dessincronizado do que está
// realmente sendo servido por `express.static`.
export function obterUltimaAtualizacao() {
  if (!existsSync(CAMINHO_MARCADOR)) return null;
  return statSync(CAMINHO_MARCADOR).mtime.toISOString();
}

export function rebuildEmAndamento() {
  return emAndamento;
}

export async function dispararRebuild() {
  if (emAndamento) throw new Error("Já existe uma atualização em andamento.");
  emAndamento = true;
  try {
    await execAsync("npm run docs:build", { cwd: RAIZ, maxBuffer: 20 * 1024 * 1024 });
    return obterUltimaAtualizacao();
  } finally {
    emAndamento = false;
  }
}
