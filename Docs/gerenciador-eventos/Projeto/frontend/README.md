# Front-end (Flutter Web)

App web em Flutter (3.19.6, Dart `>=3.3.0 <4.0.0`) que consome a API do gateway (`/bff/**`). Em produção é servido como estáticos por
nginx (container `gerenciador-frontend`, porta **8088**), que faz proxy de `/bff/` para o gateway sem reescrever o path. Estrutura,
contrato com o back-end, reserva em duas fases e regras de lint: [`CLAUDE.md`](CLAUDE.md). Visão geral: [`../../README.md`](../../README.md).

## Rodar

```bash
# via Docker: build do Flutter + nginx (o 1º build leva alguns minutos)
docker compose -f Projeto/docker-compose.yml up -d --build frontend
```

Abra `http://localhost:8088`. O frontend espera o `backend` ficar `healthy`, então o compose sobe junto o gateway e os serviços de que ele depende.

`API_BASE_URL` e `RECAPTCHA_SITE_KEY` entram por `--dart-define` em tempo de build (`flutter build web` ou `flutter run` locais). A **imagem
Docker só recebe `API_BASE_URL`** (`ARG` do `Dockerfile`, vazio por padrão): o compose não repassa `RECAPTCHA_SITE_KEY` ao build, então
pô-la no `Projeto/.env` não muda o app da imagem (o widget do reCAPTCHA usa a chave pública fixa de `web/index.html`). O padrão de
`API_BASE_URL` é vazio: o app chama `/bff/...` relativo, atrás do proxy do nginx. Para desenvolver contra o gateway direto, sem nginx
(o gateway precisa estar em `:8081`, e a origem do `flutter run` tem de constar em `CORS_ALLOWED_ORIGINS`, que por padrão inclui `http://localhost:3000`):

```bash
flutter run -d chrome --web-port=3000 --dart-define=API_BASE_URL=http://localhost:8081
```

## Analisar e testar

Não é preciso Flutter no host: lint, teto de tamanho de arquivo e testes rodam no container do SDK (estágio `build` do `Dockerfile`).
A partir da raiz do repositório (no Git Bash do Windows, prefixe `MSYS_NO_PATHCONV=1` e use o caminho absoluto no `-v`):

```bash
docker build --target build -t gerenciador-flutter-sdk Projeto/frontend
docker run --rm -v "$PWD/Projeto/frontend:/app" -w /app gerenciador-flutter-sdk \
  sh -c "flutter pub get && flutter analyze && sh tool/verifica-tamanho.sh && flutter test"
```

Tem que terminar com `No issues found!` e `Tamanho de arquivos OK`. O `pub get` deixa `.dart_tool/`, `pubspec.lock` e `.flutter-plugins*`
na pasta (ignorados pelo git): apague-os antes de um novo `docker build` ou `compose build` do frontend, porque não há `.dockerignore` e eles iriam para o contexto da imagem.

## Observações

- `blocoInteiro.dart` (na raiz desta pasta, fora de `lib/`) é **legado**: referência histórica do app monolítico de 2025, não é compilado
  nem analisado. O app ativo está em `lib/`.
- Estado global com `provider`; textos em PT-BR; feedback ao usuário pelos helpers de `lib/telas/modals.dart`.
