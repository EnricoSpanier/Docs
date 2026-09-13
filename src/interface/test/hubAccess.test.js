import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

import { criarMiddlewareHubAccess } from "../lib/hubAccess.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "chave-hub-teste-1";
const JWK = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
const HUB_URL = "http://localhost:3100";
const HUB_LOGIN_URL = "https://hub.enricospanier.com.br/login";

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
    sobrenome: "Spanier",
    role: "user",
    apps: ["docs"],
    ver: 1,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...extra,
  };
}

function requisicao(cookie) {
  return {
    headers: cookie ? { cookie } : {},
    protocol: "http",
    originalUrl: "/pagina",
    get(nome) {
      return nome === "host" ? "localhost:3200" : undefined;
    },
  };
}

function requisicaoComToken(token) {
  return requisicao(`outro_cookie=xyz; hub_session=${token}; mais_um=abc`);
}

function fetchComChaves(chaves) {
  return async (url) => {
    if (url.includes("/.well-known/jwks.json")) {
      return { ok: true, status: 200, json: async () => ({ keys: chaves }) };
    }
    return { ok: true, status: 200, json: async () => ({ valido: true }) };
  };
}

function resposta() {
  return {
    codigo: undefined,
    corpo: undefined,
    tipo: undefined,
    localizacao: undefined,
    status(codigo) {
      this.codigo = codigo;
      return this;
    },
    type(tipo) {
      this.tipo = tipo;
      return this;
    },
    send(corpo) {
      this.corpo = corpo;
      return this;
    },
    redirect(codigo, destino) {
      this.codigo = codigo;
      this.localizacao = destino;
      return this;
    },
  };
}

function criarMiddleware(extra = {}) {
  return criarMiddlewareHubAccess({ hubUrl: HUB_URL, hubLoginUrl: HUB_LOGIN_URL, ...extra });
}

test("sem cookie hub_session: redireciona 302 pro login do hub", async () => {
  const middleware = criarMiddleware({ fetchImpl: fetchComChaves([JWK]) });
  const req = requisicao();
  let chamado = false;
  const res = resposta();
  await middleware(req, res, () => {
    chamado = true;
  });
  assert.equal(chamado, false);
  assert.equal(res.codigo, 302);
  assert.match(res.localizacao, /^https:\/\/hub\.enricospanier\.com\.br\/login\?redirect=/);
});

test("token válido, app docs autorizado, versão confere: chama next()", async () => {
  const token = assinarToken(payloadValido());
  const middleware = criarMiddleware({ fetchImpl: fetchComChaves([JWK]) });
  const req = requisicaoComToken(token);
  let chamado = false;
  const res = resposta();
  await middleware(req, res, () => {
    chamado = true;
  });
  assert.equal(chamado, true);
  assert.equal(res.codigo, undefined);
});

test("token válido e autorizado: popula req.hubUser com username/nome/role", async () => {
  const token = assinarToken(payloadValido({ role: "admin" }));
  const middleware = criarMiddleware({ fetchImpl: fetchComChaves([JWK]) });
  const req = requisicaoComToken(token);
  await middleware(req, resposta(), () => {});
  assert.deepEqual(req.hubUser, { username: "enrico", nome: "Enrico", role: "admin" });
});

test("assinatura inválida (token adulterado): redireciona pro login, não 500", async () => {
  const token = assinarToken(payloadValido());
  const tokenAdulterado = token.slice(0, -4) + "abcd";
  const middleware = criarMiddleware({ fetchImpl: fetchComChaves([JWK]) });
  const req = requisicaoComToken(tokenAdulterado);
  let chamado = false;
  const res = resposta();
  await middleware(req, res, () => {
    chamado = true;
  });
  assert.equal(chamado, false);
  assert.equal(res.codigo, 302);
});

test("token expirado: redireciona pro login", async () => {
  const token = assinarToken(payloadValido({ exp: Math.floor(Date.now() / 1000) - 10 }));
  const middleware = criarMiddleware({ fetchImpl: fetchComChaves([JWK]) });
  const req = requisicaoComToken(token);
  const res = resposta();
  let chamado = false;
  await middleware(req, res, () => {
    chamado = true;
  });
  assert.equal(chamado, false);
  assert.equal(res.codigo, 302);
});

test('"alg: none" é rejeitado, redireciona pro login (nunca aceito)', async () => {
  const header = { alg: "none", kid: KID, typ: "JWT" };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payloadValido())).toString("base64url");
  const tokenSemAssinatura = `${headerB64}.${payloadB64}.`;
  const middleware = criarMiddleware({ fetchImpl: fetchComChaves([JWK]) });
  const req = requisicaoComToken(tokenSemAssinatura);
  const res = resposta();
  let chamado = false;
  await middleware(req, res, () => {
    chamado = true;
  });
  assert.equal(chamado, false);
  assert.equal(res.codigo, 302);
});

test('token válido mas "docs" não está em apps: 403 "sem acesso" (nunca redireciona — já está logado)', async () => {
  const token = assinarToken(payloadValido({ apps: ["outro-app"] }));
  const middleware = criarMiddleware({ fetchImpl: fetchComChaves([JWK]) });
  const req = requisicaoComToken(token);
  const res = resposta();
  let chamado = false;
  await middleware(req, res, () => {
    chamado = true;
  });
  assert.equal(chamado, false);
  assert.equal(res.codigo, 403);
  assert.match(res.corpo, /Acesso negado/);
});

test("versão de permissão desatualizada (hub diz inválida): 403 estático, nunca redireciona", async () => {
  const token = assinarToken(payloadValido({ ver: 2 }));
  const fetchImpl = async (url) => {
    if (url.includes("/.well-known/jwks.json")) return { ok: true, status: 200, json: async () => ({ keys: [JWK] }) };
    return { ok: true, status: 200, json: async () => ({ valido: false }) };
  };
  const middleware = criarMiddleware({ fetchImpl });
  const req = requisicaoComToken(token);
  const res = resposta();
  let chamado = false;
  await middleware(req, res, () => {
    chamado = true;
  });
  assert.equal(chamado, false);
  assert.equal(res.codigo, 403);
  assert.match(res.corpo, /Entrar de novo no hub/);
});

test("checagem de versão é cacheada: segunda requisição não repete a chamada de rede", async () => {
  const token = assinarToken(payloadValido());
  let chamadasVerificar = 0;
  const fetchImpl = async (url) => {
    if (url.includes("/.well-known/jwks.json")) return { ok: true, status: 200, json: async () => ({ keys: [JWK] }) };
    chamadasVerificar += 1;
    return { ok: true, status: 200, json: async () => ({ valido: true }) };
  };
  const middleware = criarMiddleware({ fetchImpl });

  await middleware(requisicaoComToken(token), resposta(), () => {});
  await middleware(requisicaoComToken(token), resposta(), () => {});

  assert.equal(chamadasVerificar, 1, "a segunda requisição deveria reaproveitar o cache de ~60s");
});

test("cookie hub_session com percent-encoding malformado: redireciona pro login, nunca 500", async () => {
  const middleware = criarMiddleware({ fetchImpl: fetchComChaves([JWK]) });
  const req = requisicao("hub_session=%");
  const res = resposta();
  let chamado = false;
  await middleware(req, res, () => {
    chamado = true;
  });
  assert.equal(chamado, false);
  assert.equal(res.codigo, 302);
});

test("erro de rede no fetch do JWKS (hub fora do ar): 503 estático, nunca redireciona (evita loop)", async () => {
  const token = assinarToken(payloadValido());
  const middleware = criarMiddleware({
    fetchImpl: async () => {
      throw new Error("rede fora do ar");
    },
  });
  const req = requisicaoComToken(token);
  const res = resposta();
  let chamado = false;
  await middleware(req, res, () => {
    chamado = true;
  });
  assert.equal(chamado, false);
  assert.equal(res.codigo, 503);
  assert.match(res.corpo, /Entrar de novo no hub/);
});

test("kid desconhecido (não está no JWKS retornado): 503 estático, nunca redireciona", async () => {
  const token = assinarToken(payloadValido(), { kid: "kid-que-nao-existe" });
  const middleware = criarMiddleware({ fetchImpl: fetchComChaves([JWK]) });
  const req = requisicaoComToken(token);
  const res = resposta();
  let chamado = false;
  await middleware(req, res, () => {
    chamado = true;
  });
  assert.equal(chamado, false);
  assert.equal(res.codigo, 503);
});

test("versaoAindaValida manda o token via Authorization: Bearer, não mais ?usuario= na URL", async () => {
  let urlChamada, headersChamados;
  const fetchImpl = async (url, opcoes) => {
    if (url.includes("/.well-known/jwks.json")) {
      return { ok: true, status: 200, json: async () => ({ keys: [JWK] }) };
    }
    urlChamada = url;
    headersChamados = opcoes?.headers;
    return { ok: true, status: 200, json: async () => ({ valido: true }) };
  };
  const middleware = criarMiddleware({ fetchImpl });
  const token = assinarToken(payloadValido());

  let chamado = false;
  await middleware(requisicaoComToken(token), resposta(), () => {
    chamado = true;
  });

  assert.equal(chamado, true, "sessão válida deveria passar");
  assert.ok(!urlChamada.includes("usuario="), "a URL não deve mais mandar ?usuario= livre");
  assert.ok(urlChamada.includes("versao=1"), "versao continua indo por query string");
  assert.equal(headersChamados?.authorization, `Bearer ${token}`, "o próprio token deve ir via Authorization: Bearer");
});

test("kid desconhecido repetido não refaz fetch do JWKS dentro do cooldown", async () => {
  const token = assinarToken(payloadValido(), { kid: "kid-que-nao-existe" });
  let chamadasJwks = 0;
  const fetchImpl = async (url) => {
    if (url.includes("/.well-known/jwks.json")) {
      chamadasJwks += 1;
      return { ok: true, status: 200, json: async () => ({ keys: [JWK] }) };
    }
    return { ok: true, status: 200, json: async () => ({ valido: true }) };
  };
  const middleware = criarMiddleware({ fetchImpl });

  await middleware(requisicaoComToken(token), resposta(), () => {});
  await middleware(requisicaoComToken(token), resposta(), () => {});
  await middleware(requisicaoComToken(token), resposta(), () => {});

  assert.equal(
    chamadasJwks,
    1,
    "3 requisições com o mesmo kid desconhecido, dentro do cooldown, devem gerar só 1 fetch real"
  );
});

test("kids desconhecidos distintos e concorrentes não disparam mais de 1 fetch simultâneo (single-flight)", async () => {
  let chamadasJwks = 0;
  let emVooAoMesmoTempo = 0;
  let picoConcorrencia = 0;
  const fetchImpl = async (url) => {
    if (url.includes("/.well-known/jwks.json")) {
      emVooAoMesmoTempo += 1;
      picoConcorrencia = Math.max(picoConcorrencia, emVooAoMesmoTempo);
      chamadasJwks += 1;
      await new Promise((r) => setTimeout(r, 20));
      emVooAoMesmoTempo -= 1;
      return { ok: true, status: 200, json: async () => ({ keys: [JWK] }) };
    }
    return { ok: true, status: 200, json: async () => ({ valido: true }) };
  };
  const middleware = criarMiddleware({ fetchImpl });

  const tokens = ["kid-a", "kid-b", "kid-c"].map((kid) =>
    assinarToken(payloadValido(), { kid: `${kid}-desconhecido` })
  );
  await Promise.all(tokens.map((t) => middleware(requisicaoComToken(t), resposta(), () => {})));

  assert.equal(picoConcorrencia, 1, "nunca deve haver mais de 1 fetch de JWKS em voo ao mesmo tempo");
  assert.equal(chamadasJwks, 1, "3 requisições concorrentes com kids diferentes, dentro do cooldown, geram só 1 fetch");
});

test("chave JWKS já conhecida é reconsultada depois do teto de idade máxima (defesa contra chave revogada)", async () => {
  const token = assinarToken(payloadValido());
  let chamadasJwks = 0;
  const agoraSimulado = { valor: Date.now() };
  const relogioOriginal = Date.now;
  Date.now = () => agoraSimulado.valor;
  const fetchImpl = async (url) => {
    if (url.includes("/.well-known/jwks.json")) {
      chamadasJwks += 1;
      return { ok: true, status: 200, json: async () => ({ keys: [JWK] }) };
    }
    return { ok: true, status: 200, json: async () => ({ valido: true }) };
  };
  const middleware = criarMiddleware({ fetchImpl });

  try {
    await middleware(requisicaoComToken(token), resposta(), () => {});
    assert.equal(chamadasJwks, 1, "primeira requisição sempre busca o JWKS");

    agoraSimulado.valor += 60_000; // bem dentro do teto de 10min, kid já conhecido
    await middleware(requisicaoComToken(token), resposta(), () => {});
    assert.equal(chamadasJwks, 1, "kid já conhecido e cache fresco: não deveria refazer fetch");

    agoraSimulado.valor += 11 * 60 * 1000; // passa dos 10min de idade máxima
    await middleware(requisicaoComToken(token), resposta(), () => {});
    assert.equal(chamadasJwks, 2, "cache de JWKS envelhecido: deveria reconsultar mesmo com kid já conhecido");
  } finally {
    Date.now = relogioOriginal;
  }
});

test("publicOrigin configurado: redirect pro login usa a origem fixa, não o Host da requisição", async () => {
  const middleware = criarMiddleware({
    fetchImpl: fetchComChaves([JWK]),
    publicOrigin: "https://docs.enricospanier.com.br",
  });
  const req = {
    headers: {},
    protocol: "http",
    originalUrl: "/pagina?x=1",
    get(nome) {
      return nome === "host" ? "algum-host-arbitrario.com" : undefined;
    },
  };
  const res = resposta();
  await middleware(req, res, () => {});
  assert.equal(res.codigo, 302);
  assert.match(
    res.localizacao,
    /redirect=https%3A%2F%2Fdocs\.enricospanier\.com\.br%2Fpagina/,
    "deveria usar publicOrigin, não o Host arbitrário da requisição"
  );
});

test("indisponibilidade prolongada do hub: cache de revogação para de ser reaproveitado após o teto máximo", async () => {
  const token = assinarToken(payloadValido());
  let hubDisponivel = true;
  let agoraSimulado = Date.now();
  const relogioOriginal = Date.now;
  Date.now = () => agoraSimulado;

  const fetchImpl = async (url) => {
    if (url.includes("/.well-known/jwks.json")) return { ok: true, status: 200, json: async () => ({ keys: [JWK] }) };
    if (!hubDisponivel) throw new Error("rede fora do ar");
    return { ok: true, status: 200, json: async () => ({ valido: true }) };
  };
  const middleware = criarMiddleware({ fetchImpl });

  try {
    let chamado = false;
    await middleware(requisicaoComToken(token), resposta(), () => {
      chamado = true;
    });
    assert.equal(chamado, true, "primeira requisição, hub saudável, deveria passar");

    hubDisponivel = false;
    for (let i = 0; i < 120; i += 1) {
      agoraSimulado += 2000;
      chamado = false;
      await middleware(requisicaoComToken(token), resposta(), () => {
        chamado = true;
      });
      assert.equal(chamado, true, `iteração ${i}: dentro do teto, deveria continuar válido`);
    }

    for (let i = 0; i < 60; i += 1) {
      agoraSimulado += 2000;
      chamado = false;
      await middleware(requisicaoComToken(token), resposta(), () => {
        chamado = true;
      });
    }
    assert.equal(chamado, false, "depois do teto máximo de reaproveitamento, deve falhar fechado");
  } finally {
    Date.now = relogioOriginal;
  }
});

test("versão inválida numa indisponibilidade sem cache prévio: 403, não trava nem 500", async () => {
  const token = assinarToken(payloadValido());
  const fetchImpl = async (url) => {
    if (url.includes("/.well-known/jwks.json")) return { ok: true, status: 200, json: async () => ({ keys: [JWK] }) };
    throw new Error("rede fora do ar");
  };
  const middleware = criarMiddleware({ fetchImpl });
  const req = requisicaoComToken(token);
  const res = resposta();
  let chamado = false;
  await middleware(req, res, () => {
    chamado = true;
  });
  assert.equal(chamado, false);
  assert.equal(res.codigo, 403);
});
