import { createPublicKey, verify as verificarAssinatura } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Gate de acesso via hub de identidade central (repositório `Hub`), adaptado de
 * `Jarvis/src/interface/lib/hubAccess.js` — mesma verificação de assinatura RS256 via
 * `node:crypto`, cache de JWKS e `versaoAindaValida` com cache ~60s.
 *
 * A divisão de controle é diferente da do Jarvis: lá toda falha cai em `next()` porque existe um
 * login local para servir de rede de segurança. Aqui não há sessão nem login próprio — cada
 * requisição é verificada do zero contra o cookie `hub_session` — então a régua é "o hub também
 * rejeitaria este cookie?":
 *   - sim (sem cookie, token malformado, `alg` != RS256, `exp` vencido, assinatura inválida) →
 *     302 para o login do hub, igual ao que o hub faria.
 *   - não, mas não dá pra confirmar (JWKS fora do ar, `kid` desconhecido, exceção de verificação)
 *     → nunca redireciona (evitaria um loop: o hub aceitaria o cookie, só esta verificação local
 *     falhou) — 503 com página estática e link manual pro hub.
 *   - não, e o hub confirma que a versão de permissão mudou (ou está inacessível sem cache prévio
 *     para essa sessão) → 403, mesma página estática.
 *   - cookie válido mas app "docs" não está em `apps` → 403 com a página "acesso negado".
 *   - cookie válido e autorizado → popula `req.hubUser` (username/nome/role) e `next()` direto pro
 *     `express.static` — só pra essa requisição, nunca persiste (sem sessão).
 */

const OPENSSL_ALG_POR_JWT_ALG = Object.assign(Object.create(null), { RS256: "RSA-SHA256" });
const TIMEOUT_MS = 10000;
const CACHE_VERSAO_MS = 60000;
const MEU_SLUG = "docs";
// `kid` do JWKS vem de um JWT ainda não validado — qualquer requisição anônima pode mandar um
// valor arbitrário. Sem cooldown, um `kid` aleatório por requisição força um fetch real ao hub
// por requisição (amplificação/DoS). JWKS_MAX_AGE_MS limita por quanto tempo uma chave já
// cacheada fica em uso sem reconfirmar com o hub (defesa em profundidade contra revogação de
// chave comprometida que reaproveita o mesmo `kid`).
const JWKS_COOLDOWN_MS = 5000;
const JWKS_MAX_AGE_MS = 10 * 60 * 1000;
// Teto de quanto tempo o resultado de `versaoAindaValida` pode ser reaproveitado só por causa de
// falhas de rede consecutivas — sem isso, uma sessão revogada continua aceita indefinidamente
// durante toda uma indisponibilidade do hub, contanto que o usuário mantenha tráfego a cada
// menos de CACHE_VERSAO_MS.
const TETO_REAPROVEITAMENTO_MS = 5 * 60 * 1000;

const CAMINHO_ACESSO_NEGADO = fileURLToPath(new URL("../acesso-negado.html", import.meta.url));
let paginaAcessoNegadoCache = null;
function paginaAcessoNegado() {
  if (paginaAcessoNegadoCache === null) {
    paginaAcessoNegadoCache = readFileSync(CAMINHO_ACESSO_NEGADO, "utf8");
  }
  return paginaAcessoNegadoCache;
}

function paginaEntrarNovamente(hubLoginUrl) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <title>Docs — Não foi possível confirmar sua sessão</title>
</head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#16181b;color:#ece7d9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;">
  <div style="max-width:380px;text-align:center;">
    <p style="font-size:.9rem;line-height:1.5;color:#9b9484;">Não foi possível confirmar sua sessão do hub agora. Isso pode ser passageiro — tente entrar de novo.</p>
    <a href="${hubLoginUrl}" style="display:inline-block;margin-top:12px;color:#ff7a45;">Entrar de novo no hub &rarr;</a>
  </div>
</body>
</html>`;
}

function decodificarJwt(token) {
  const partes = typeof token === "string" ? token.split(".") : [];
  if (partes.length !== 3) throw new Error("token malformado");
  const [headerB64, payloadB64, assinaturaB64] = partes;
  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  if (typeof header !== "object" || header === null) throw new Error("token malformado");
  if (typeof payload !== "object" || payload === null) throw new Error("token malformado");
  return {
    header,
    payload,
    dadosAssinados: Buffer.from(`${headerB64}.${payloadB64}`, "utf8"),
    assinatura: Buffer.from(assinaturaB64, "base64url"),
  };
}

function lerCookie(req, nome) {
  const cabecalho = req.headers.cookie;
  if (typeof cabecalho !== "string") return null;
  for (const parte of cabecalho.split(";")) {
    const igual = parte.indexOf("=");
    if (igual === -1) continue;
    const chave = parte.slice(0, igual).trim();
    if (chave === nome) {
      try {
        return decodeURIComponent(parte.slice(igual + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function urlAtual(req, publicOrigin) {
  // Sem `publicOrigin` configurado, cai pro Host cru da requisição — mantém o comportamento
  // antigo (e os testes que não passam `publicOrigin`), mas `req.get("host")` é o próprio
  // cabeçalho `Host`, controlável por quem fala direto com o processo Node. `publicOrigin` fixo
  // evita que esse valor apareça sem necessidade no `redirect=` mandado pro hub.
  if (publicOrigin) return `${publicOrigin}${req.originalUrl}`;
  return `${req.protocol}://${req.get("host")}${req.originalUrl}`;
}

export function criarMiddlewareHubAccess({
  hubUrl = "http://localhost:3100",
  hubLoginUrl = "https://hub.enricospanier.com.br/login",
  fetchImpl = fetch,
  publicOrigin,
} = {}) {
  const jwksUrl = `${hubUrl}/.well-known/jwks.json`;
  let chaves = new Map();
  const cacheVersao = new Map();
  let fetchJwksEmVoo = null;
  let ultimoFetchJwksEm = 0;

  function redirecionarLogin(req, res) {
    const destino = `${hubLoginUrl}?redirect=${encodeURIComponent(urlAtual(req, publicOrigin))}`;
    res.redirect(302, destino);
  }

  function responderFalhaInfraestrutura(res) {
    res.status(503).type("html").send(paginaEntrarNovamente(hubLoginUrl));
  }

  function responderVersaoInvalida(res) {
    res.status(403).type("html").send(paginaEntrarNovamente(hubLoginUrl));
  }

  function responderSemAcesso(res) {
    res.status(403).type("html").send(paginaAcessoNegado());
  }

  async function buscarJwks() {
    if (fetchJwksEmVoo) return fetchJwksEmVoo; // single-flight: reaproveita o fetch já em andamento
    fetchJwksEmVoo = (async () => {
      const resposta = await fetchImpl(jwksUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!resposta.ok) throw new Error(`JWKS do hub indisponível: HTTP ${resposta.status}`);
      const corpo = await resposta.json();
      chaves = new Map((corpo.keys ?? []).map((jwk) => [jwk.kid, jwk]));
      ultimoFetchJwksEm = Date.now();
    })();
    try {
      await fetchJwksEmVoo;
    } finally {
      fetchJwksEmVoo = null;
    }
  }

  async function obterChave(kid) {
    const agora = Date.now();
    const cacheEnvelhecido = agora - ultimoFetchJwksEm >= JWKS_MAX_AGE_MS;
    if (!chaves.has(kid) || cacheEnvelhecido) {
      const dentroDoCooldown = agora - ultimoFetchJwksEm < JWKS_COOLDOWN_MS;
      if (!dentroDoCooldown) await buscarJwks();
    }
    return chaves.get(kid) ?? null;
  }

  /**
   * Confirma que a versão de permissão embutida no token ainda é a atual — permite revogar acesso
   * sem esperar os 7 dias de validade do cookie. Cacheado por ~60s por (usuário, versão). Erro de
   * rede sem cache prévio = inválido; com cache prévio, reaproveita o último resultado conhecido
   * (mantém uma sessão já confirmada de pé durante uma indisponibilidade passageira do hub).
   */
  // O hub fechou um oráculo de enumeração de username em GET /api/verificar: não aceita mais
  // ?usuario= livre, exige o próprio token do chamador via Authorization. `versao` continua
  // indo por query string (não é dado sensível por si só) — só a identidade do usuário passou
  // a vir do token, nunca mais de um parâmetro que o cliente controla.
  async function versaoAindaValida(token, sub, ver) {
    const chave = `${sub}:${ver}`;
    const agora = Date.now();
    const cache = cacheVersao.get(chave);
    if (cache && cache.expiraEm > agora) return cache.valido;

    try {
      const url = `${hubUrl}/api/verificar?versao=${ver}`;
      const resposta = await fetchImpl(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const corpo = await resposta.json();
      const valido = resposta.ok && corpo?.valido === true;
      // `confirmadoEm` marca a última resposta REAL do hub (nunca avança só por reaproveitamento)
      // — é o que limita por quanto tempo total uma indisponibilidade pode mascarar uma revogação.
      cacheVersao.set(chave, { valido, expiraEm: agora + CACHE_VERSAO_MS, confirmadoEm: agora });
      return valido;
    } catch {
      if (cache && agora - cache.confirmadoEm < TETO_REAPROVEITAMENTO_MS) {
        cacheVersao.set(chave, {
          valido: cache.valido,
          expiraEm: agora + CACHE_VERSAO_MS,
          confirmadoEm: cache.confirmadoEm,
        });
        return cache.valido;
      }
      // Sem cache prévio, ou teto de reaproveitamento estourado numa indisponibilidade contínua:
      // falha fechado em vez de confiar num valor conhecido havia tempo demais.
      return false;
    }
  }

  return async function middlewareHubAccess(req, res, next) {
    const token = lerCookie(req, "hub_session");
    if (!token) return redirecionarLogin(req, res);

    let header, payload, dadosAssinados, assinatura;
    try {
      ({ header, payload, dadosAssinados, assinatura } = decodificarJwt(token));
    } catch {
      return redirecionarLogin(req, res);
    }

    const opensslAlg = OPENSSL_ALG_POR_JWT_ALG[header.alg];
    if (!opensslAlg) return redirecionarLogin(req, res); // nunca aceita "alg: none"

    let jwk;
    try {
      jwk = await obterChave(header.kid);
    } catch {
      return responderFalhaInfraestrutura(res); // JWKS fora do ar: ambíguo, não redireciona
    }
    if (!jwk) return responderFalhaInfraestrutura(res); // kid desconhecido: ambíguo

    let assinaturaValida;
    try {
      const chavePublica = createPublicKey({ key: jwk, format: "jwk" });
      assinaturaValida = verificarAssinatura(opensslAlg, dadosAssinados, chavePublica, assinatura);
    } catch {
      return responderFalhaInfraestrutura(res); // exceção de verificação: ambíguo
    }
    if (!assinaturaValida) return redirecionarLogin(req, res); // token adulterado: hub também rejeitaria

    const agora = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp <= agora) return redirecionarLogin(req, res);
    if (typeof payload.sub !== "string" || !payload.sub) return redirecionarLogin(req, res);
    if (typeof payload.ver !== "number") return redirecionarLogin(req, res);

    const apps = Array.isArray(payload.apps) ? payload.apps : [];
    if (!apps.includes(MEU_SLUG)) return responderSemAcesso(res);

    if (!(await versaoAindaValida(token, payload.sub, payload.ver))) return responderVersaoInvalida(res);

    req.hubUser = { username: payload.sub, nome: payload.nome, role: payload.role };
    next();
  };
}
