# identity-client

Lib (jar simples, sem repackage) com o **contrato HTTP** do serviço `identity` (issue #36): os DTOs `User`, `MyWallet`, `LoginResult` e
`RecaptchaResponse`, as interfaces `UserApi`, `EmailVerificationApi`, `MyWalletApi` e `RecaptchaApi`, as exceções
`IdentityUnavailableException` e `IdentityNaoEncontradoException` e o `IdentityClient`.

- **Quem usa:** o gateway (monólito) monta o `IdentityClient` pelo `IdentityClientConfig` e o injeta como
  `UserApi`/`EmailVerificationApi`/`MyWalletApi`/`RecaptchaApi`; o serviço `identity` implementa os mesmos endpoints e NÃO escaneia o
  pacote `identityclient` (só usa os tipos do contrato e o cliente nos testes ponta a ponta).
- **`IdentityClient`:** uma chamada HTTP por método, header `X-Internal-Token` em TODA chamada (sem token a construção falha). Apache
  HttpClient 5 com pool (padrão 400 no total e por rota), keep-alive, conectar 2 s, esperar conexão do pool 5 s, **resposta 5 s**,
  `evict-idle` 20 s e **sem retry automático**. URL: `IDENTITY_SERVICE_URL` (default `http://localhost:8084`; o `IdentityClientConfig` lê).
- **`MyWalletApi.walletExists`** (não `exists`): o `IdentityClient` implementa `UserApi` e `MyWalletApi` na mesma classe e as duas tinham
  `boolean exists(Long)`.

## Contrato `/internal/**` (o que o serviço `identity` implementa)

Tudo exige `X-Internal-Token` (401 sem/errado, SEM o marcador de credenciais), menos `GET /.well-known/jwks.json`. Corpo de
erro = texto puro com a mensagem. JSON dos DTOs como o `/bff` de hoje (`User`: `user_id`, `name`, `email`, `fone`, `password`,
`birthdate`, `isAdmin`, `isHost`, `isActive`, `created_at`, `updatedAt`).

| Método da lib | Requisição | Sucesso | Erros |
|---|---|---|---|
| `UserApi.createUser` | `POST /internal/users` corpo `User` (**`host` NÃO é gravado**; `admin` é gravado como sempre foi: nenhum código autoriza por `admin`) | 201 `User` | 400 regra |
| `UserApi.findById` | `GET /internal/users/{id}` | 200 `User` | 404 + `X-Identity-Nao-Encontrado` |
| `UserApi.findByEmail` | `GET /internal/users/by-email?email=` (query: `@`/`.`/`+` não cabem bem em path) | 200 `User` | 404 + marcador |
| `UserApi.updateUser` | `PUT /internal/users/{id}` corpo `User` (o `id` do path vale; **`host` NÃO é gravado**, `admin` como sempre; **`password` é IGNORADO** (#171: a senha só muda por `/password` e `/password-with-mfa`); a resposta é a linha como ficou no banco, com `password` nulo) | 200 `User` | 400 regra (inclui e-mail que já é de OUTRA conta, sem diferenciar maiúsculas) |
| `UserApi.deactivateUser` | `DELETE /internal/users/{id}` | 204 | |
| `UserApi.getValidationErrors` | `POST /internal/users/validate` corpo `User` | 200 texto (`""` = válido) | |
| `UserApi.login` | `POST /internal/users/login` corpo `{email, password}` | 200 `{user, token}` (RS256, `uid`, `isHost` do banco) | **401 + `X-Identity-Credenciais-Invalidas`** => `null` (senha errada, e-mail inexistente, e-mail ou senha nulos) |
| `UserApi.changePassword` | `PUT /internal/users/{id}/password` corpo `{oldPassword, newPassword}` | 200 JSON boolean | 400 regra (senha atual errada, nova curta, usuário inexistente) |
| `UserApi.requestPasswordResetMfa` | `POST /internal/users/{id}/password-reset-mfa` | 200 `User` (o gateway usa o e-mail) | 404 + marcador |
| `UserApi.verifyPasswordResetMfaCode` | `POST /internal/users/{id}/password-reset-mfa/verify` corpo `{mfaCode}` | 200 (sem corpo) => `true` | **401 + `X-Identity-Credenciais-Invalidas`** => `false` (código errado/expirado/nulo **e usuário inexistente**: nunca 404) |
| `UserApi.changePasswordWithMfa` | `PUT /internal/users/{id}/password-with-mfa` corpo `{newPassword, mfaCode}` | 204 | 400 (código inválido/expirado, senha curta) |
| `UserApi.exists` | `GET /internal/users/{id}/exists` | 200 JSON boolean | |
| `UserApi.findNames` | `POST /internal/users/names` corpo `[1,2,3]` (ids) | 200 `{"1":"Ana"}` (só contas ativas) | |
| `EmailVerificationApi.requestEmailVerification` | `POST /internal/registrations` corpo `{email, fone, userName, password, birthDate}` | 201 | 400 regra |
| `EmailVerificationApi.verifyEmailAndCreateUser` | `POST /internal/registrations/verify` corpo `{email, verificationCode}` | 201 `{user, token}` (token com `isHost`) | 400 (código inválido/expirado/tentativas) |
| `EmailVerificationApi.resendVerificationCode` | `POST /internal/registrations/resend` corpo `{email}` | 200 | 400 regra |
| `MyWalletApi.getByUserId` | `GET /internal/wallets/{userId}` | 200 `MyWallet` | 400 id inválido; 404 + marcador |
| `MyWalletApi.ensureExists` | `PUT /internal/wallets/{userId}` | 200 `MyWallet` | 400 id inválido |
| `MyWalletApi.walletExists` | `GET /internal/wallets/{userId}/exists` | 200 JSON boolean | 400 id inválido |
| `RecaptchaApi.verify` | `POST /internal/recaptcha/verify` corpo `{token, action}` | **sempre 200** com o envelope `{status, body}`: `status` 200 + `body {success, score, action}`, ou `status` 500 + `body {success:false, error}` (sem chave, Google fora, resposta inválida): o mesmo status/corpo que o `/bff/users/verify-recaptcha` dá hoje | 5xx/rede/sem envelope => indisponível |

Mapeamento no cliente: 400 => `IllegalArgumentException(corpo)`; 404 COM `X-Identity-Nao-Encontrado` => `IdentityNaoEncontradoException`
(nas rotas `/exists` é falha, não "não existe"); 401 COM `X-Identity-Credenciais-Invalidas` (só login e verificação MFA) => `null`/`false`;
rede, timeout, 5xx, 404 sem o marcador, 401 sem o marcador (token interno errado: **não** é "senha errada") e qualquer outro status =>
`IdentityUnavailableException` (503 genérico no gateway). `exists`/`walletExists` nunca devolvem `false` por falha.

O `X-Identity-Credenciais-Invalidas` não está na spec original: foi acrescentado porque, sem ele, um `INTERNAL_API_TOKEN` errado (o
`InternalTokenFilter` do identity responde 401) viraria "credenciais inválidas" para todo login em vez de 503.

Teste da lib: `IdentityClientIndisponivelTest` (sem Spring: porta morta, 500 e resposta lenta => `IdentityUnavailableException`, sem
retry; 404 e 401 com/sem marcador; 400; construção sem token; contrato feliz com o token interno e o e-mail codificado como valor).
