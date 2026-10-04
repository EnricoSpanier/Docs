# hubAccess: adapta versaoAindaValida ao novo contrato de GET /api/verificar

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Bloqueante de deploy, não opcional.** O Hub (repositório irmão `E:\Proj\Hub`) já mudou o
> contrato de `GET /api/verificar` numa branch com PR aberta (`seguranca-correcoes-adversarial`,
> https://github.com/EnricoSpanier/Hub/pull/19) — a rota não aceita mais `?usuario=` livre, exige
> `Authorization: Bearer <token>`. Este projeto (`Docs`) ainda chama a rota do jeito antigo. Sem
> este fix, **todo request autenticado do Docs vira 401 assim que o Hub for redeployado com essa
> PR**, e este middleware não tem fallback nenhum pra esse caso (fail-closed por design — ver
> comentário no topo de `hubAccess.js`). Aplique este plano **antes ou junto** do deploy do Hub.

**Goal:** Fazer `versaoAindaValida` em `src/interface/lib/hubAccess.js` mandar o próprio token do
chamador via `Authorization: Bearer` em vez de `?usuario=` de query, acompanhando a mudança de
contrato do Hub — sem isso, o middleware nega acesso a todo mundo (fail-closed) assim que o Hub
subir com o novo contrato.

**Contexto — por que o Hub mudou isso:** `GET /api/verificar?usuario=<nome>&versao=<n>` era
público, sem autenticação nenhuma, e aceitava qualquer `usuario` — um oráculo de enumeração de
username (qualquer um podia sondar se uma conta existe e sua `permissoes_versao`). A correção do
Hub troca a fonte da identidade: em vez de um parâmetro que o cliente controla, agora vem do
`payload.sub` do próprio token RS256 que o chamador apresenta via `Authorization: Bearer`. O
parâmetro `versao` continua indo por query string (não é dado sensível por si só).

**Precedente — o Jarvis (outro relying app do Hub) já fez exatamente este ajuste.** Commit
`5b06a5f` em `E:\Proj\Jarvis` (`fix: hubAccess envia o proprio token via Authorization ao checar
versao de permissao`), 364/364 testes passando. O diff real desse commit:

```diff
-  async function versaoAindaValida(sub, ver) {
+  async function versaoAindaValida(token, sub, ver) {
     const chave = `${sub}:${ver}`;
     const agora = Date.now();
     const cache = cacheVersao.get(chave);
     if (cache && cache.expiraEm > agora) return cache.valido;

     try {
-      const url = `${hubUrl}/api/verificar?usuario=${encodeURIComponent(sub)}&versao=${ver}`;
-      const resposta = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
+      const url = `${hubUrl}/api/verificar?versao=${ver}`;
+      const resposta = await fetchImpl(url, {
+        headers: { authorization: `Bearer ${token}` },
+        signal: AbortSignal.timeout(TIMEOUT_MS),
+      });
       const corpo = await resposta.json();
       const valido = resposta.ok && corpo?.valido === true;
       cacheVersao.set(chave, { valido, expiraEm: agora + CACHE_VERSAO_MS });
       return valido;
     ...
   }
   ...
-    if (!(await versaoAindaValida(payload.sub, payload.ver))) {
+    if (!(await versaoAindaValida(token, payload.sub, payload.ver))) {
```

Este plano é o mesmo ajuste, adaptado à estrutura atual de `Docs/src/interface/lib/hubAccess.js`
(que já difere um pouco do Jarvis — cache tem um campo extra `confirmadoEm` de um hardening
anterior, ver `security/plans/2026-09-12-hubaccess-availability-hardening.md`, já aplicado).

**Architecture:** Mudança isolada em `versaoAindaValida` (assinatura ganha um parâmetro `token`) e
no único call site dela, dentro de `middlewareHubAccess`. Nenhuma outra função muda. Nenhuma
dependência nova.

**Tech Stack:** Node.js built-ins (`node:crypto`, `node:test`, `node:assert/strict`) — mesmo
padrão do arquivo hoje.

**Spec:** N/A — mesma situação do plano de hardening anterior: não há spec formal, o achado vem de
uma auditoria de segurança adversarial (rodada 2026-09-13, no Hub) que identificou este projeto
como um relying app não atualizado pro novo contrato.

## Global Constraints

- Nenhuma dependência nova — `hubAccess.js` continua só com `node:crypto`, `node:fs`, `node:url`.
- Todo teste existente em `src/interface/test/hubAccess.test.js` deve continuar passando
  inalterado, exceto os que testam `versaoAindaValida`/o corpo da requisição a `/api/verificar`
  diretamente (que precisam ser atualizados pra refletir o novo formato de URL/headers — ver
  Task 1, Step 1).
- Comentários em português, explicando o *porquê* — mesmo padrão do resto do arquivo.
- Não mude o comportamento de fail-closed do middleware (JWKS fora do ar → 503 ambíguo; versão
  inválida → 403; token ausente/inválido → redirect pro login) — só a forma como
  `versaoAindaValida` monta a requisição ao Hub.

---

## Task 1: `versaoAindaValida` manda o token via `Authorization: Bearer`

**Files:**
- Modify: `E:\Proj\Docs\src\interface\lib\hubAccess.js` (função `versaoAindaValida`, e o único call
  site dela dentro de `middlewareHubAccess`)
- Test: `E:\Proj\Docs\src\interface\test\hubAccess.test.js`

**Interfaces:**
- Modifica `versaoAindaValida(sub, ver)` → `versaoAindaValida(token, sub, ver)`. A chave de cache
  (`cacheVersao`, chaveada por `${sub}:${ver}`) não muda — o `token` só é usado pra montar a
  requisição, nunca vira parte da chave de cache (o mesmo `sub`/`ver` de sessões diferentes ainda
  deve reaproveitar o cache normalmente).
- O único call site (dentro do handler do middleware, hoje `if (!(await
  versaoAindaValida(payload.sub, payload.ver)))`) já tem `token` em escopo — é a mesma variável
  local que `lerCookie(req, "hub_session")` devolveu no topo da função, usada pra `decodificarJwt`.
  Não precisa buscar nada novo, só passar a variável que já existe.

- [x] **Step 1: Escrever/ajustar os testes que falham**

Em `E:\Proj\Docs\src\interface\test\hubAccess.test.js`, a suíte de testes fala com o Hub via
`fetchImpl` — qualquer teste cujo `fetchImpl` monte a URL de `/api/verificar` manualmente ou
inspecione o corpo/headers da chamada precisa ser revisado. Adicionar (ou adaptar o teste de cache
já existente, "checagem de versão é cacheada: segunda requisição não repete a chamada de rede",
linha ~198, se ele inspecionar a URL) um teste que prove o novo contrato:

```javascript
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
  await middleware(requisicaoComToken(token), resposta(), () => { chamado = true; });

  assert.equal(chamado, true, "sessão válida deveria passar");
  assert.ok(!urlChamada.includes("usuario="), "a URL não deve mais mandar ?usuario= livre");
  assert.ok(urlChamada.includes("versao=1"), "versao continua indo por query string");
  assert.equal(headersChamados?.authorization, `Bearer ${token}`, "o próprio token deve ir via Authorization: Bearer");
});
```

- [x] **Step 2: Rodar o teste e confirmar que falha**

Run: `node --test src/interface/test/hubAccess.test.js`
Expected: FAIL — hoje a URL ainda inclui `usuario=enrico` e nenhum header `authorization` é
mandado.

- [x] **Step 3: Implementar**

Em `E:\Proj\Docs\src\interface\lib\hubAccess.js`, trocar a assinatura e o corpo de
`versaoAindaValida`:

```javascript
  // antes
  async function versaoAindaValida(sub, ver) {
    const chave = `${sub}:${ver}`;
    const agora = Date.now();
    const cache = cacheVersao.get(chave);
    if (cache && cache.expiraEm > agora) return cache.valido;

    try {
      const url = `${hubUrl}/api/verificar?usuario=${encodeURIComponent(sub)}&versao=${ver}`;
      const resposta = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const corpo = await resposta.json();
      const valido = resposta.ok && corpo?.valido === true;
      cacheVersao.set(chave, { valido, expiraEm: agora + CACHE_VERSAO_MS, confirmadoEm: agora });
      return valido;
    } catch {
      // ... bloco catch sem mudança
    }
  }
```

```javascript
  // depois
  // O Hub fechou um oráculo de enumeração de username em GET /api/verificar: não aceita mais
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
      cacheVersao.set(chave, { valido, expiraEm: agora + CACHE_VERSAO_MS, confirmadoEm: agora });
      return valido;
    } catch {
      // ... bloco catch sem mudança — não toca no teto de reaproveitamento (Task 2 do plano de
      // hardening anterior), só a chamada de rede acima muda
    }
  }
```

(O `catch` inteiro — teto de reaproveitamento de 5min, `confirmadoEm`, fail-closed — fica
idêntico ao que já existe hoje; só o bloco `try` acima do `catch` muda.)

E no call site, dentro de `middlewareHubAccess` (onde `token` já está em escopo desde
`lerCookie`/`decodificarJwt` no topo da função):

```javascript
// antes
    if (!(await versaoAindaValida(payload.sub, payload.ver))) return responderVersaoInvalida(res);

// depois
    if (!(await versaoAindaValida(token, payload.sub, payload.ver))) return responderVersaoInvalida(res);
```

- [x] **Step 4: Rodar os testes de novo e confirmar que passam**

Run: `node --test src/interface/test/hubAccess.test.js`
Expected: PASS em todos — o novo teste e todos os já existentes (incluindo o teste de cache, que
deve continuar reaproveitando dentro dos 60s normalmente — a chave de cache não mudou).

- [x] **Step 5: Rodar a suíte completa do projeto**

Run: `npm test` (a partir de `E:\Proj\Docs`)
Expected: PASS, nenhuma regressão em outros arquivos de teste.

- [x] **Step 6: Commit**

```bash
git add src/interface/lib/hubAccess.js src/interface/test/hubAccess.test.js
git commit -m "fix(hubAccess): envia o proprio token via Authorization ao checar versao de permissao

Acompanha a mudanca de contrato de GET /api/verificar no Hub (fecha um
oraculo de enumeracao de username, PR EnricoSpanier/Hub#19) — o hub nao
aceita mais ?usuario= livre, exige o token do proprio chamador via
Authorization: Bearer. Mesmo ajuste ja aplicado no Jarvis (commit
5b06a5f).

Precisa entrar antes (ou junto) do deploy da correcao no Hub em
producao: a ordem inversa quebra todo acesso autenticado ao Docs ate
este ajuste entrar (o middleware falha fechado, sem fallback)."
```

(Mesma nota do plano de hardening anterior: este projeto não tem `git` configurado hoje — ver
`README.md`. Este passo é aspiracional/documentacional até o projeto ser versionado; se `git`
já estiver configurado quando você chegar aqui, rode o commit de verdade.)

---

## Ordem de deploy

1. Aplicar e testar este fix no Docs.
2. Fazer deploy do serviço Docs com o fix.
3. **Só então** mergear/deployar a PR do Hub (`EnricoSpanier/Hub#19`) — ou deployar os dois juntos
   na mesma janela, nunca o Hub primeiro.

Se o Hub subir antes deste fix: todo request autenticado ao Docs recebe a página estática de
"não foi possível confirmar sua sessão" (503/403, ver `responderFalhaInfraestrutura`/
`responderVersaoInvalida` em `hubAccess.js`) até este ajuste entrar — não é um caso ambíguo pro
middleware, ele já sabe se comportar, só fica indisponível pra todo mundo enquanto isso.

## Self-review (checklist já aplicado ao escrever este plano)

- **Cobertura do achado:** achado único (contrato de `/api/verificar` mudou) → Task 1 única.
- **Placeholder scan:** nenhum "TBD"/"implementar depois" — o diff de referência (Jarvis,
  `5b06a5f`) já está aplicado e testado em produção nesse outro projeto; este plano é a mesma
  mudança adaptada ao arquivo local.
- **Consistência:** assinatura nova de `versaoAindaValida` (`token, sub, ver`) não colide com
  nada existente; chave de cache (`sub:ver`) propositalmente não muda.
