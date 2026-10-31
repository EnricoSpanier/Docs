import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

import { criarApp } from "../server.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "chave-hub-teste-1";
const JWK = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
const HUB_URL = "http://localhost:3100";
const HUB_LOGIN_URL = "https://hub.enricospanier.com.br/login";
const PUBLIC_ORIGIN = "https://docs.enricospanier.com.br";

function assinarToken(payload, { chavePrivada = privateKey, kid = KID, alg = "RS256" } = {}) {
  const header = { alg, kid, typ: "JWT" };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const dados = `${headerB64}.${payloadB64}`;
  const assinatura = sign("RSA-SHA256", Buffer.from(dados), chavePrivada);
  return `${dados}.${assinatura.toString("base64url")}`;
}

function payloadValido(extra = {}) {
  return {
    sub: "enrico",
    nome: "Enrico",
    role: "admin",
    apps: ["docs"],
    ver: 1,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...extra,
  };
}

function fetchHubPadrao(overrides = {}) {
  return async (url) => {
    if (url.includes("/.well-known/jwks.json")) {
      return { ok: true, status: 200, json: async () => ({ keys: [JWK] }) };
    }
    if (overrides.verificar) return overrides.verificar(url);
    return { ok: true, status: 200, json: async () => ({ valido: true }) };
  };
}

function rebuildFake({
  dispararRebuild = async () => {
    throw new Error("dispararRebuild não deveria ser chamado de verdade neste teste");
  },
  obterUltimaAtualizacao = () => null,
  rebuildEmAndamento = () => false,
} = {}) {
  return { dispararRebuild, obterUltimaAtualizacao, rebuildEmAndamento };
}

async function subirApp(opcoes = {}) {
  const app = criarApp({
    hubUrl: HUB_URL,
    hubLoginUrl: HUB_LOGIN_URL,
    publicOrigin: PUBLIC_ORIGIN,
    fetchImpl: fetchHubPadrao(),
    ...rebuildFake(),
    ...opcoes,
  });
  const servidor = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = servidor.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    fechar: () => new Promise((resolve) => servidor.close(resolve)),
  };
}

function cookieAdmin() {
  return `hub_session=${assinarToken(payloadValido())}`;
}

test("x-powered-by nunca é enviado", async () => {
  const { baseUrl, fechar } = await subirApp();
  try {
    const resposta = await fetch(`${baseUrl}/admin/status`, {
      headers: { cookie: cookieAdmin() },
    });
    assert.equal(resposta.headers.get("x-powered-by"), null);
  } finally {
    await fechar();
  }
});

test("POST /admin/rebuild sem Origin (chamada direta): passa pela checagem de CSRF", async () => {
  const { baseUrl, fechar } = await subirApp();
  try {
    const resposta = await fetch(`${baseUrl}/admin/status`, {
      headers: { cookie: cookieAdmin() },
    });
    assert.equal(resposta.status, 200);
  } finally {
    await fechar();
  }
});

test("POST /admin/rebuild com Origin de terceiro: 403, nunca dispara o rebuild", async () => {
  const { baseUrl, fechar } = await subirApp();
  try {
    const resposta = await fetch(`${baseUrl}/admin/rebuild`, {
      method: "POST",
      headers: { cookie: cookieAdmin(), origin: "https://evil.example.com" },
    });
    assert.equal(resposta.status, 403);
    const corpo = await resposta.json();
    assert.match(corpo.erro, /Origem não permitida/);
  } finally {
    await fechar();
  }
});

test("POST /admin/rebuild com Origin igual ao publicOrigin: passa pela checagem de CSRF e dispara o rebuild (fake)", async () => {
  let chamado = false;
  const { baseUrl, fechar } = await subirApp(
    rebuildFake({
      dispararRebuild: async () => {
        chamado = true;
        return "2026-01-01T00:00:00.000Z";
      },
    })
  );
  try {
    const resposta = await fetch(`${baseUrl}/admin/rebuild`, {
      method: "POST",
      headers: { cookie: cookieAdmin(), origin: PUBLIC_ORIGIN },
    });
    assert.equal(resposta.status, 200);
    assert.equal(chamado, true, "deveria ter chamado dispararRebuild — a checagem de origem não deveria bloquear");
  } finally {
    await fechar();
  }
});

test("falha no rebuild (erro genérico) não vaza mensagem/caminho do exec pro cliente", async () => {
  const { baseUrl, fechar } = await subirApp(
    rebuildFake({
      dispararRebuild: async () => {
        // Mensagem real que `exec()` produziria numa falha de verdade — inclui caminho absoluto.
        throw new Error(
          "Command failed: npm run docs:build\nnpm error path C:\\Proj\\Docs\\package.json\nnpm error code ENOENT"
        );
      },
    })
  );
  try {
    const resposta = await fetch(`${baseUrl}/admin/rebuild`, {
      method: "POST",
      headers: { cookie: cookieAdmin(), origin: PUBLIC_ORIGIN },
    });
    assert.equal(resposta.status, 409);
    const corpo = await resposta.json();
    assert.equal(corpo.erro, "Rebuild falhou. Verifique o log do servidor.");
    assert.doesNotMatch(corpo.erro, /[A-Za-z]:\\|\/[A-Za-z]+\//, "não deveria conter caminho de arquivo");
  } finally {
    await fechar();
  }
});

test('falha conhecida ("já em andamento") continua chegando ao cliente normalmente', async () => {
  const { baseUrl, fechar } = await subirApp(
    rebuildFake({
      dispararRebuild: async () => {
        throw new Error("Já existe uma atualização em andamento.");
      },
    })
  );
  try {
    const resposta = await fetch(`${baseUrl}/admin/rebuild`, {
      method: "POST",
      headers: { cookie: cookieAdmin(), origin: PUBLIC_ORIGIN },
    });
    assert.equal(resposta.status, 409);
    const corpo = await resposta.json();
    assert.equal(corpo.erro, "Já existe uma atualização em andamento.");
  } finally {
    await fechar();
  }
});

test("GET /admin sem admin.html presente: 500 genérico, sem stack trace nem caminho de arquivo", async () => {
  const { baseUrl, fechar } = await subirApp({
    caminhoAdmin: "C:\\caminho\\que\\nao\\existe\\admin.html",
  });
  try {
    const resposta = await fetch(`${baseUrl}/admin`, { headers: { cookie: cookieAdmin() } });
    const corpo = await resposta.text();
    assert.equal(resposta.status, 500);
    assert.equal(corpo, "Erro interno.");
    assert.doesNotMatch(corpo, /ENOENT|[A-Za-z]:\\|at Object|\.js:\d+:\d+/, "não deveria vazar caminho de arquivo nem stack trace");
  } finally {
    await fechar();
  }
});

test("404 em rota inexistente não vaza stack trace (NODE_ENV forçado pra produção)", async () => {
  const { baseUrl, fechar } = await subirApp();
  try {
    // Cookie válido pra passar do gate do hub sem seguir redirect real pro domínio de produção do
    // Hub — o que queremos exercitar aqui é o 404 default do Express, não o fluxo de login.
    const resposta = await fetch(`${baseUrl}/rota-que-nao-existe`, {
      headers: { cookie: cookieAdmin() },
    });
    const corpo = await resposta.text();
    assert.equal(resposta.status, 404);
    assert.doesNotMatch(corpo, /at Object|at Module|\.js:\d+:\d+/, "não deveria vazar stack trace no 404 default do Express");
  } finally {
    await fechar();
  }
});

test("GET /batch2/estado.json devolve as linhas do painel, sem cache", async () => {
  const linhas = [{ tipo: "resumo", restante_h: 21.5 }];
  const { baseUrl, fechar } = await subirApp({ lerPainelBatch2: () => linhas });
  try {
    const resposta = await fetch(`${baseUrl}/batch2/estado.json`, { headers: { cookie: cookieAdmin() } });
    assert.equal(resposta.status, 200);
    assert.equal(resposta.headers.get("cache-control"), "no-store");
    assert.deepEqual(await resposta.json(), linhas);
  } finally {
    await fechar();
  }
});

test("GET /batch2/estado.json sem sessão para no gate do hub, sem ler o ledger", async () => {
  let leu = false;
  const { baseUrl, fechar } = await subirApp({ lerPainelBatch2: () => { leu = true; return []; } });
  try {
    const resposta = await fetch(`${baseUrl}/batch2/estado.json`, { redirect: "manual" });
    assert.notEqual(resposta.status, 200);
    assert.equal(leu, false);
  } finally {
    await fechar();
  }
});

test("GET /batch2/estado.json com o ledger ilegível: 503 sem caminho de arquivo", async () => {
  const { baseUrl, fechar } = await subirApp({
    lerPainelBatch2: () => { throw new Error("ENOENT: no such file, open 'E:\\TCC\\batch2-ledger.md'"); },
  });
  try {
    const resposta = await fetch(`${baseUrl}/batch2/estado.json`, { headers: { cookie: cookieAdmin() } });
    const corpo = await resposta.text();
    assert.equal(resposta.status, 503);
    assert.doesNotMatch(corpo, /ENOENT|[A-Za-z]:\\/, "não deveria vazar o caminho do ledger");
  } finally {
    await fechar();
  }
});
