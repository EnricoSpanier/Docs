# CLAUDE.md — Frontend (Flutter Web)

App web em Flutter, servido como estáticos por Nginx em produção. Leia também o CLAUDE.md da
raiz (regras gerais) e o de `Backend/` (contrato da API).

## Estrutura

```
lib/
├── main.dart                app + MyApp + Provider HomePageData; checa token no boot
├── config/
│   ├── app_config.dart      AppConfig.apiBaseUrl (--dart-define API_BASE_URL, default vazio)
│   └── recaptcha_config.dart RECAPTCHA_SITE_KEY (--dart-define) + path de verify-recaptcha
├── telas/
│   ├── auth.dart            ApiAuth: token JWT em memória + SharedPreferences
│   ├── modals.dart          SnackBars padronizados (showError/showSuccess/...)
│   ├── telaHomePage.dart    landing pública (pré-login)
│   ├── telaLogin / telaCadastro / telaVerificacaoEmail
│   ├── telaPrincipal.dart   dashboard pós-login
│   ├── telaCriacaoEvento / telaEdicaoEvento / telaInscricaoEvento
│   ├── telaGerenciarEventos.dart  abas "Inscritos" / "Criados"
│   ├── telaPesquisarEvento.dart
│   └── telaEdicaoPerfil.dart
├── helpers/
│   ├── date_input_formatter.dart
│   └── reserva_logica.dart  lógica pura da reserva (parse do expiresAt, mm:ss, classificação de status)
└── widgets/
    ├── recaptcha_widget.dart
    └── painel_reserva.dart  reserva em duas fases embutida em telaInscricaoEvento (estado, timers, consulta)
test/painel_reserva_test.dart  flutter_test da lógica pura (o container do SDK roda `flutter test`)
```

`blocoInteiro.dart` (na raiz de `frontend/`, fora de `lib/`) é um **monólito legado de
referência** — não é compilado, não edite.

## Rodar

- Via Docker: `docker compose -f Projeto/docker-compose.yml up -d --build frontend`
  — Nginx na porta `8088` (container `:80`), container `gerenciador-frontend`.
- Build local: `flutter build web --release --dart-define=API_BASE_URL=<url> --dart-define=RECAPTCHA_SITE_KEY=<key>`
- Dev: `flutter run -d chrome --web-port=3000 --dart-define=API_BASE_URL=http://localhost:8081` (aponta
  direto pro backend, sem o proxy do Nginx — precisa do `backend` rodando em `:8081` com
  CORS liberado pra origem do `flutter run`, ver `Backend/CLAUDE.md`).
  `--web-port=3000` bate com o default de `CORS_ALLOWED_ORIGINS` (#133); outra origem (`127.0.0.1`, IP da
  LAN) exige acrescentá-la a `CORS_ALLOWED_ORIGINS` no `Projeto/.env`.
- Sem lockfile versionado; `flutter pub get` resolve pelo `pubspec.yaml`.
  Flutter 3.19.6 / Dart SDK `>=3.3.0 <4.0.0` (ver `Dockerfile`).

## Como fala com o backend

- Superfície HTTP única sob `/bff/**` (issue #78) — todas as chamadas seguem o mesmo padrão:
  `Uri.parse('${AppConfig.apiBaseUrl}/bff/...')`. Não existe mais divisão entre chamada
  relativa e absoluta: é sempre esse padrão, o que muda é só o valor de `apiBaseUrl`.
- `AppConfig.apiBaseUrl` (`API_BASE_URL`, `--dart-define`, `String.fromEnvironment`) tem
  **default vazio** (`''`). Vazio ⇒ path fica relativo (`/bff/...`), resolvido contra a
  origem da página — em produção (`docker-compose.yml` não passa mais `args.API_BASE_URL`,
  usa o default do `Dockerfile`) isso cai atrás do proxy do Nginx em `:8088`. Setado (ex.:
  `flutter run --dart-define=API_BASE_URL=http://localhost:8081`) ⇒ aponta direto pro
  backend, sem Nginx (uso em dev). **Mudar exige rebuild da imagem** — não é runtime.
- **Nginx faz proxy de `/bff/` → `backend:8081/bff/` SEM rewrite/strip** (`nginx.conf`): o
  path chega igual no backend, ex. `/bff/users/login` → `/bff/users/login`.
  O `nginx.conf` é um **template** da imagem oficial (`/etc/nginx/templates`, `envsubst` só de `BACKEND_*`): o upstream vem de `BACKEND_UPSTREAM` (default
  `backend:8081`, no `Dockerfile`); o override `docker-compose.autoescala.yml` (#111) o troca por `lb:8081` (HAProxy na frente das réplicas do gateway). Contrato do app
  (porta e path) inalterado.
- JWT: `ApiAuth.jsonHeaders()` injeta `Authorization: Bearer <token>`. O token fica em
  memória (`ApiAuth.token`) e, se persistido, em `SharedPreferences` (`jwt_token`).
  `main.dart` tenta `GET ${AppConfig.apiBaseUrl}/bff/users/me` no boot pra restaurar a
  sessão; token inválido é limpo. "Lembrar de mim" também cacheia `email`/`password` em
  `SharedPreferences`.
- **Reserva em duas fases e modo fila (contrato da #43, consumido pela tela da #44):** `POST /bff/event-wallets` só reserva:
  `201` traz a reserva `pending` com `expiresAt`; com o evento acima de 80% de X responde **`202 Accepted`** (headers
  `Idempotency-Key` e `Retry-After: 1`, expostos no CORS; corpo `{"status":"queued","eventId":n,"idempotencyKey":"..."}`; nenhuma reserva ainda).
  `GET /bff/event-wallets/admission?idempotencyKey=<chave>` (autenticado) devolve `200 {"status":"queued"|"pending"|"rejected"|"timed_out",
  "eventId", "idempotencyKey", "expiresAt"?, "reason"?}`; `404` = chave inexistente ou de outro usuário, `400` sem chave, `503` admission fora.
  O `POST` também pode dar `400` (texto: "Evento lotado", "Vínculo já existente"), `422` (chave usada em outro evento) e `429` (limite/fila cheia).
  A confirmação é sempre `POST /bff/event-wallets/confirm` (`200`; `400` com "Reserva expirada..." ou "Nenhuma reserva pendente...").
  O `widgets/painel_reserva.dart` (embutido na `telaInscricaoEvento`, no lugar dos botões) faz tudo isso:
  - **Fluxo:** "Reservar vaga" -> `201` vai à contagem regressiva `mm:ss` + botão "Confirmar inscrição" (o sucesso é o de antes:
    `AppModals.showSuccess` e volta à `MainScreen`); `202` mostra "aguardando confirmação" e consulta o estado até `pending` (mesma
    contagem), `rejected` (mostra o `reason`) ou `timed_out` ("Tentar de novo"). Prazo vencido (contagem a 0, ou `/confirm` com 400 de
    reserva expirada) -> "Reserva expirada" + "Reservar de novo". `/confirm` com 400 "Reserva já confirmada" conta como sucesso. O
    reservation só varre `pending` vencido a cada ~30 s: um "Reservar de novo" que volte 400 "Vínculo já existente" a partir de "expirada" mostra
    "a reserva anterior ainda está sendo liberada" no painel (sem modal). Cliques repetidos em reservar/confirmar são ignorados com um POST em voo.
  - **`expiresAt` é UTC sem offset:** o servidor serializa um `LocalDateTime` do relógio do container (UTC, sem `TZ` no compose), ex.
    `2026-10-28T18:30:00.123456`. `DateTime.parse` direto daria a hora local do navegador (3 h errada em UTC-3), então
    `parseExpiresAtUtc` lê string sem `Z`/offset como UTC. A contagem usa o relógio do navegador: relógio de cliente errado desloca o prazo mostrado
    (o servidor continua sendo quem decide no `/confirm`).
  - **Consulta:** `Timer` cancelável (cancelado no `dispose`, e respostas de rodada antiga são descartadas) no intervalo do `Retry-After`
    (1 a 5 s; padrão 1 s), no máximo `kLimiteConsultas` = 60 (60 s, acima do TTL da fila de 30 s); ao estourar, "Tentar de novo". `404` oferece refazer;
    `503`/erro de rede seguem tentando dentro do limite ("conexão instável"); `401` pede novo login.
  - **Chave de idempotência:** "Tentar de novo" depois de `timed_out` repete o `POST` com a MESMA chave (header `Idempotency-Key` = a do corpo do `202`) e
    pode voltar `201` ou `202`. Refazer depois de `pending` expirado ou de `rejected` é um `POST` novo, SEM chave (a antiga repetiria o resultado guardado).

## Estado e UI

- Estado global via `provider` — `HomePageData` (`ChangeNotifier`) guarda dados do usuário,
  nome do site e listas de evento. Atualize via `notifyListeners()` após login/edição.
- Feedback ao usuário sempre pelos helpers de `telas/modals.dart`, não `ScaffoldMessenger`
  cru — mantém cor/estilo consistentes.
- Material Design (`uses-material-design: true`). Textos em PT-BR.
- Datas: `intl` + `helpers/date_input_formatter.dart` para máscara de input.

## reCAPTCHA v3

`widgets/recaptcha_widget.dart` + `config/recaptcha_config.dart`. A **site key** entra por
`--dart-define=RECAPTCHA_SITE_KEY`; o backend (serviço identity) valida o token contra a Google. Site key é
pública, mas mesmo assim não hardcode — mantenha via dart-define.

## Lint e tamanho de arquivo (issue #84)

`analysis_options.yaml` inclui `package:flutter_lints/flutter.yaml` (`avoid_print` ativo) e exclui
`blocoInteiro.dart` da análise. Não há Flutter local; o lint roda no container do SDK (estágio
`build` do `Dockerfile`, Flutter 3.19.6). A partir da raiz do repo (no Git Bash do Windows, prefixe
`MSYS_NO_PATHCONV=1` e use o caminho absoluto no `-v`):

```
docker build --target build -t gerenciador-flutter-sdk Projeto/frontend
docker run --rm -v "$PWD/Projeto/frontend:/app" -w /app gerenciador-flutter-sdk sh -c "flutter pub get && flutter analyze && sh tool/verifica-tamanho.sh && flutter test"
```

Tem que terminar com `No issues found!` e `Tamanho de arquivos OK`. O `pub get` deixa `.dart_tool/`,
`pubspec.lock` e `.flutter-plugins*` na pasta (ignorados pelo `.gitignore`). Não há `.dockerignore`: apague-os
antes de `docker build`/`compose build` do frontend, senão vão para o contexto da imagem.

- **Sem `print`:** use `debugPrint` (já vem no `material.dart`). Não há logger no app — achado: logs de
  diagnóstico são só `debugPrint` no console do navegador; um logger/telemetria de verdade fica fora do escopo.
- **Regra desligada: `file_names`.** As telas são camelCase (`telaLogin.dart`, `telaHomePage.dart`...), convenção
  já estabelecida. Reavaliada na #44 e mantida desligada: renomear as 11 telas e todos os imports é churn fora do escopo
  do aceite. Arquivos novos fora de `telas/` são snake_case (`painel_reserva.dart`, `reserva_logica.dart`). Nenhuma outra regra está desligada.
- **`// ignore:` (um por linha, justificado):**
  - `lib/widgets/recaptcha_widget.dart`, `import 'dart:js'` — `avoid_web_libraries_in_flutter`: o app é só web
    e o reCAPTCHA v3 precisa chamar o `grecaptcha` do `index.html` por interop JS.
- **Teto de tamanho:** 500 linhas por arquivo `.dart` em `lib/`, checado por `tool/verifica-tamanho.sh` (um `wc -l`
  em shell, sem pacote novo). Acima do teto, na baseline do próprio script (limite = tamanho atual: pode encolher,
  não crescer): `telaEdicaoPerfil` 841, `telaVerificacaoEmail` 840, `telaCadastro` 670, `telaCriacaoEvento` 665,
  `telaEdicaoEvento` 523. As telas não foram refatoradas na #84; ao quebrar uma, baixe o limite dela.
- **Contagem antes das correções** (`flutter_lints` 4.0.0 recém-ligado, 96 issues): `use_build_context_synchronously` 24,
  `unnecessary_null_comparison` 13, `file_names` 11, `avoid_print` 11, `unused_field` 8, `prefer_const_constructors` 7,
  `empty_catches` 4, `unused_import` 3, `unnecessary_to_list_in_spreads` 3, `prefer_final_fields` 3,
  `constant_identifier_names` 3, `use_super_parameters` 2, `avoid_web_libraries_in_flutter` 2,
  `prefer_const_literals_to_create_immutables` 1, `duplicate_import` 1.
- **Como foram resolvidas:** `dart fix --apply` (const, `toList` no spread, imports, null checks, super params);
  `use_build_context_synchronously` com `if (!context.mounted) return;` (context vindo por parâmetro) ou
  `if (!mounted) return;` (State) depois do `await`; campos `unused_field` removidos junto com as atribuições;
  `empty_catches` com comentário; as 3 constantes de config renomeadas para lowerCamelCase
  (`AppConfig.apiBaseUrl`, `recaptchaSiteKey`, `recaptchaVerifyEndpoint`; as chaves de `--dart-define` não mudaram).

## Ao mexer aqui

- Novo endpoint consumido → confira o path real no `Backend/CLAUDE.md` (sempre `/bff/...`) e
  chame como `Uri.parse('${AppConfig.apiBaseUrl}/bff/...')`, igual ao resto do código.
- Mudou `API_BASE_URL`/dart-define → rebuild da imagem (`up -d --build frontend`).
- Não introduza pacote de state management novo (fica com `provider`).
