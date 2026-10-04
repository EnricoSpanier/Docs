# Docs

Portal central de documentação, publicado em `https://docs.enricospanier.com.br`. Reúne duas
fontes que antes viviam sem relação entre si:

- **Gerenciador de Eventos** — código, backlog e testes manuais, sincronizados de
  `E:\TCC\GerenciadorEventos`.
- **Decisões de Arquitetura** — ADRs e notas, sincronizadas do vault
  `D:\Claude\Brain\01-Projects\Event-Management-System`.

Site estático gerado com [Docusaurus](https://docusaurus.io/) 3.

## Estrutura

```
docusaurus.config.js   # config do site (tema, navbar, plugin de busca)
sidebars.js             # sidebar dos docs
scripts/sync-docs.mjs   # gera docs/gerenciador-eventos/ e docs/decisoes-arquitetura/ do zero
                         # a cada build — nunca editar essas pastas à mão, sempre sobrescritas
src/css/custom.css       # overrides de CSS do tema/plugins
src/interface/          # servidor Express de produção (atrás do gate do Hub)
  server.js
  lib/hubAccess.js       # verifica o cookie hub_session (JWKS/RS256) antes de servir o build
  lib/rebuild.js         # dispara `npm run docs:build` sob demanda via /admin
  admin.html             # painel simples pra admins repetirem o rebuild sem terminal
build/                  # saída estática do Docusaurus (gerada, nunca versionada)
```

Não há repositório git neste projeto nem no diretório pai `E:\Proj` — "publicar" aqui significa
rebuildar e deixar o serviço de produção (abaixo) pegar o resultado, não commit/push.

## Rodando localmente

```
npm run docs:start   # sync-docs + docusaurus start (dev, hot reload)
npm run docs:build   # sync-docs + docusaurus build -> build/
npm test             # testes do servidor Express (node --test)
```

`npm start` roda `src/interface/server.js` diretamente — é o mesmo processo usado em produção,
então localmente ele também exige um cookie `hub_session` válido (variáveis `HUB_URL` /
`HUB_LOGIN_URL` apontam pro Hub).

Portas 3000–3200 são reservadas para os serviços de produção deste host (Jarvis/Hub/Docs) — usar
portas ≥ 4000 para qualquer servidor de teste ad-hoc.

## Busca

Busca local full-text via `@easyops-cn/docusaurus-search-local` (indexa pt/en, sem depender de
serviço externo tipo Algolia). No mobile (≤576px), o input da busca fica sempre expandido em vez
de colapsar para um ícone que só abre ao tocar — override em `src/css/custom.css`, plugado via
`theme.customCss` no `docusaurus.config.js`.

## Deploy / produção

- Serviço Windows **`Docs`** (via NSSM, ver `E:\Proj\setup-jarvis-docs-services.ps1`), porta
  3200, roda `node src/interface/server.js`, que serve `build/` com `express.static` (sem cache
  em memória) atrás do gate do Hub.
- Exposição pública via **Cloudflare Tunnel** nomeado (serviço `CloudflaredTunnel`), roteando
  `docs.enricospanier.com.br` → `localhost:3200`.
- Como o serviço lê `build/` direto do disco a cada requisição, **rodar `npm run docs:build` já
  é o deploy** — não precisa reiniciar o serviço `Docs`. (O `CloudflaredTunnel` só precisa
  reiniciar se uma rota/hostname *nova* for adicionada ao `config.yml` dele — não para mudanças
  de conteúdo em uma rota já existente.)
- Admins logados podem disparar o mesmo rebuild remotamente em `/admin` (`POST /admin/rebuild`),
  sem precisar de acesso ao terminal da máquina.
