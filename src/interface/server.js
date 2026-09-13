import { fileURLToPath } from "node:url";

import express from "express";

import { criarMiddlewareHubAccess } from "./lib/hubAccess.js";
import {
  dispararRebuild as dispararRebuildPadrao,
  obterUltimaAtualizacao as obterUltimaAtualizacaoPadrao,
  rebuildEmAndamento as rebuildEmAndamentoPadrao,
} from "./lib/rebuild.js";

/**
 * Ponto de entrada (`npm start`): serve `build/` (gerado por `npm run docs:build`) atrás do gate
 * do hub — sem `express-session`, sem estado próprio, cada requisição é verificada do zero.
 *
 * - `PORT` — padrão `3200`.
 * - `HOST` — padrão `127.0.0.1` (local-only), mesmo padrão de Hub/Jarvis.
 * - `HUB_URL` — base do hub para as chamadas servidor-a-servidor (JWKS, verificação de versão),
 *   padrão `http://localhost:3100` (loopback — mais rápido que ir pela internet e voltar).
 * - `HUB_LOGIN_URL` — para onde o navegador é redirecionado, padrão
 *   `https://hub.enricospanier.com.br/login` (precisa ser o hostname público — o navegador do
 *   usuário não alcança o loopback do servidor).
 * - `TRUST_PROXY` — `TRUST_PROXY=1` faz o Express confiar no `X-Forwarded-*` do proxy na frente
 *   (necessário atrás do Cloudflare Tunnel para o `redirect=` do login carregar a URL pública
 *   correta), mesmo padrão de `Jarvis/src/interface/server.js`.
 */

const caminhoBuild = fileURLToPath(new URL("../../build", import.meta.url));
const caminhoAdminPadrao = fileURLToPath(new URL("./admin.html", import.meta.url));

// Só a rota que dispara um `docusaurus build` de verdade precisa de defesa própria contra
// CSRF: é a única mutação de estado do servidor, e autenticação aqui é 100% via cookie. O hub
// hoje seta `hub_session` com `SameSite=Lax` (o que já bloqueia POST cross-site do navegador),
// mas isso vive num repositório separado — essa allowlist não depende de ninguém mais manter
// esse atributo com o valor certo.
function origensPermitidas(publicOrigin) {
  const origens = new Set(["http://localhost:3200", "http://127.0.0.1:3200"]);
  if (publicOrigin) origens.add(publicOrigin);
  return origens;
}

function exigirOrigemConhecida(origens) {
  return (req, res, next) => {
    const origem = req.get("origin");
    // Requisição sem `Origin` (chamada direta servidor-a-servidor, curl, etc.) não é o vetor de
    // CSRF — isso explora o navegador da vítima anexando o cookie automaticamente, o que sempre
    // manda `Origin`. Só bloqueia quando `Origin` está presente e não é uma das nossas.
    if (origem && !origens.has(origem)) {
      return res.status(403).json({ erro: "Origem não permitida." });
    }
    next();
  };
}

/**
 * Fábrica do app — separada do `.listen()` pra poder testar as rotas sem abrir porta de verdade
 * (ver `test/server.test.js`). `criarApp()` nunca tem efeito colateral de rede.
 */
export function criarApp({
  hubUrl = process.env.HUB_URL ?? "http://localhost:3100",
  hubLoginUrl = process.env.HUB_LOGIN_URL ?? "https://hub.enricospanier.com.br/login",
  publicOrigin = process.env.PUBLIC_ORIGIN,
  trustProxy = process.env.TRUST_PROXY === "1",
  fetchImpl,
  // Injetáveis só pra teste (nunca usados em produção, onde os defaults reais sempre valem) —
  // sem isso, testar a rota de rebuild dispara um `npm run docs:build` de verdade contra o
  // projeto real, já que `dispararRebuild()` resolve seu diretório a partir do próprio arquivo,
  // não do cwd do processo que chama.
  dispararRebuild = dispararRebuildPadrao,
  obterUltimaAtualizacao = obterUltimaAtualizacaoPadrao,
  rebuildEmAndamento = rebuildEmAndamentoPadrao,
  caminhoAdmin = caminhoAdminPadrao,
} = {}) {
  const hubAccess = criarMiddlewareHubAccess({ hubUrl, hubLoginUrl, publicOrigin, fetchImpl });

  const app = express();
  app.disable("x-powered-by");
  // Nunca vazar stack trace/caminho de arquivo em erro não tratado, independente de env externa
  // (nada neste repositório define `NODE_ENV` — dependia inteiramente de configuração externa).
  app.set("env", "production");

  if (trustProxy) {
    app.set("trust proxy", 1);
  }

  app.use(hubAccess);

  // Atualização sob demanda: sincronizar TCC/vault e reconstruir o site não é automático (o build
  // é estático, servido de `build/` — não há "tempo real" de verdade sem reconstruir). Restrito a
  // admin porque dispara um `docusaurus build` de verdade (custo de CPU/tempo), não porque o
  // conteúdo em si seja sensível.
  function exigirAdmin(req, res, next) {
    if (req.hubUser?.role !== "admin") {
      return res.status(403).json({ erro: "Só admin pode atualizar o conteúdo." });
    }
    next();
  }

  app.get("/admin", exigirAdmin, (_req, res) => {
    res.sendFile(caminhoAdmin, (erro) => {
      if (erro && !res.headersSent) {
        console.error("Falha ao servir admin.html:", erro);
        res.status(500).send("Erro interno.");
      }
    });
  });

  app.get("/admin/status", exigirAdmin, (_req, res) => {
    res.json({ ultimaAtualizacao: obterUltimaAtualizacao(), emAndamento: rebuildEmAndamento() });
  });

  app.post(
    "/admin/rebuild",
    exigirOrigemConhecida(origensPermitidas(publicOrigin)),
    exigirAdmin,
    async (_req, res) => {
      try {
        const ultimaAtualizacao = await dispararRebuild();
        res.json({ ok: true, ultimaAtualizacao });
      } catch (erro) {
        // Mensagem do guard de concorrência é segura e útil pro admin ver na hora; qualquer outra
        // falha (stderr/stdout do `exec`, ENOENT, etc.) pode conter caminho absoluto do servidor —
        // fica só no log, nunca na resposta.
        const mensagemConhecida = erro.message === "Já existe uma atualização em andamento.";
        if (!mensagemConhecida) console.error("Falha ao rebuildar docs:", erro);
        res.status(409).json({
          erro: mensagemConhecida ? erro.message : "Rebuild falhou. Verifique o log do servidor.",
        });
      }
    }
  );

  app.use(express.static(caminhoBuild));

  return app;
}

const éExecucaoDireta = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (éExecucaoDireta) {
  const app = criarApp();

  const porta = Number(process.env.PORT ?? 3200);
  const host = process.env.HOST ?? "127.0.0.1";

  const servidor = app.listen(porta, host, () => {
    console.log(`Docs — em http://${host}:${porta}`);
    console.log(`  hub: ${process.env.HUB_URL ?? "http://localhost:3100"}`);
  });

  for (const sinal of ["SIGINT", "SIGTERM"]) {
    process.on(sinal, () => {
      servidor.close(() => process.exit(0));
    });
  }
}
