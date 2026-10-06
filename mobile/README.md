# Fugu Deck — мобильное приложение

React Native + Expo (SDK 57, Expo Router). Пользователь сам указывает сервер: QR-приглашение или адрес вручную.
Вход по ключу устройства (DPoP), подтверждения действий агента подписываются ключом с биометрией,
сервер проверяется по отпечатку своего ключа.

## Что умеет

| Экран | Что делает |
|---|---|
| Серверы | список ваших серверов; у каждого свой закреплённый ключ и свои ключи устройства |
| Новый сервер | QR (`fugudeck://add?url=…&fp=…&name=…`) или адрес; показывает отпечаток, при QR сверяет его сам |
| Вход | пароль (+ код владельца) один раз → телефон создаёт ключи и регистрируется |
| Проекты, чаты | как в веб-клиенте; поток ответа, карточки инструментов |
| Подтверждение | карточка с аргументами; «Разрешить» — биометрия и подпись хэша аргументов ключом подтверждения |
| Сервер и устройства | закреплённый отпечаток, привязанные устройства, отзыв (с подписью), QR-приглашение для владельца, выход |
| Настройки | 10 тем, что защищает ключи на этом телефоне |

## Устройство кода

```
src/core/        протокол, без React Native — проверяется в Node
  canonical.ts   канонический JSON (байт в байт как backend/app/devices.py)
  crypto.ts      ES256, Ed25519, SHA-256, JWK, отпечатки (@noble)
  dpop.ts        DPoP-доказательства (RFC 9449)
  csr.ts         PKCS#10 для сертификата устройства (mTLS), подпись ключом сессии
  invite.ts      разбор QR / ссылки / адреса
  server.ts      /.well-known/fugu-deck, сверка отпечатка, пиннинг
  enroll.ts      регистрация устройства, проверка квитанции ключом сервера
  session.ts     токен 10 мин в памяти, обновление подписью, SSE с переподключением, подпись действий
  api.ts         API сервера: проекты, чаты, подтверждения, устройства
  softkeys.ts    программные ключи (резерв)
  timeline.ts    лента чата
src/platform/    хранилища, выбор ключей (чип / программные), транспорт (fetch+XHR / нативный mTLS)
src/state/       серверы и сессии (React context)
src/ui/          темы и элементы интерфейса
src/app/         экраны (Expo Router)
modules/fd-secure/  нативный модуль: Swift (Secure Enclave, App Attest, URLSession с клиентским сертификатом)
                    и Kotlin (Android Keystore/StrongBox, BiometricPrompt, Key Attestation, OkHttp с mTLS)
```

## Ключи на телефоне

| | Сборка с fd-secure | Expo Go / веб |
|---|---|---|
| ключ сессии | Secure Enclave / StrongBox / TEE | P-256 в Keychain/Keystore через expo-secure-store |
| ключ подтверждения | в чипе, биометрия на **каждую** подпись, сбрасывается при смене биометрии | секрет читается только с биометрией (`requireAuthentication`) |
| аттестация | Android Key Attestation (вызов сервера внутри), iOS App Attest | нет |
| mTLS | да, ключ сессии из чипа участвует в TLS | нет (только DPoP) |

Сервер видит `key_storage` каждого устройства и может ограничить программные.

## Запуск

```bash
npm install
npm test                 # юнит-тесты ядра (+ кросс-проверка с Python-сервером)
npm run typecheck
npx expo lint

npx expo start           # Expo Go: работает на программных ключах, без mTLS
npx expo run:ios         # dev-сборка с модулем fd-secure (нужен Xcode)
npx expo run:android     # dev-сборка с модулем fd-secure (нужен Android SDK)
npx eas-cli@latest build --profile development   # то же в облаке EAS
```

Сквозной тест ядра против настоящего сервера:
```bash
cd ../backend
uvicorn tests.mock_server:app --port 9100 &
SAKANA_API_KEY=x SAKANA_BASE_URL=http://127.0.0.1:9100/v1 GITHUB_TOKEN=x GITHUB_API_URL=http://127.0.0.1:9100/gh \
  APP_PASSWORD=test-pass COOKIE_SECURE=false MTLS_MODE=optional uvicorn app.main:app --port 8000 &
cd ../mobile && npm run itest
```

## Сервер: что настроить

```bash
SERVER_NAME="Домашний Fugu"            # имя в приложении
PUBLIC_URL=https://deck.example.com     # попадает в QR-приглашение
MTLS_MODE=optional                      # off | optional | required
```

QR-приглашение — в приложении владельца: «Сервер и устройства → Показать QR-приглашение»
(или `GET /api/server/invite`).

mTLS через Caddy (сервер пишет `device-ca.pem` в `DATA_DIR`, Caddy читает его из общего тома):
```caddyfile
deck.example.com {
  tls {
    client_auth {
      mode verify_if_given        # для MTLS_MODE=required: require_and_verify
      trust_pool file /data/device-ca.pem
    }
  }
  reverse_proxy app:8000 {
    header_up X-Client-Cert-Serial {http.request.tls.client.serial}
  }
}
```
Сервер сверяет серийный номер с реестром устройств (десятичный от Caddy или hex от nginx/Traefik).
Порт приложения наружу не открывать: заголовок должен ставить только прокси.

## Кластер v2

Помимо одиночного сервера приложение входит в кластер (fugu-deck-infra) по QR-приглашению `fugudeck://join?api=…&iss=…&join=…&hpke=…&invite=…`:

| Шаг | Где в коде |
|---|---|
| разбор приглашения: только https, один домен, ключ keyguard на кривой | `src/core/cluster.ts` `parseClusterInvite` |
| вход в Keycloak через системный браузер, PKCE S256, проверка `state` | `browserStartUrl`, `parseRedirect` |
| обмен кода на токен **с DPoP**; непривязанный Bearer — отказ | `exchangeCode`, `refresh` |
| регистрация: токен + DPoP + действие `device_enroll` — JWS (биометрия) + CSR ключом сессии | `buildEnroll` |
| ожидание подтверждения, сертификат mTLS | `fetchStatus`; экран `src/app/cluster/[cid].tsx` |
| ввод ключа API: HPKE для keyguard + подпись + хэш шифротекста | `src/core/hpke.ts`, `src/core/apikeys.ts` |

Экраны: `src/app/join.tsx` (вход), `src/app/cluster/[cid].tsx` (статус, ключи), `src/app/oauth.tsx` (возврат из браузера).
Сервер кластера, к которому обращаются `join/v1/enroll`, `join/v1/enroll/status` и `api/v1/keys`, — control-plane v2:
**его кода пока нет**; он передаёт запросы в keyguard как есть (`/v1/devices`, `/v1/devices/status`, `/v1/keys`).

Тесты кластера (`npm test`):
```bash
KGCHECK=…/fugu-deck-keyguard/kgcheck   # go build -o kgcheck ./cmd/kgcheck — перекрёстные проверки с keyguard
KC_URL=http://127.0.0.1:8081           # Keycloak 26.7 с realm deck (скрипт настройки — docs/keycloak-test-realm.sh)
```
Без переменных тесты с Keycloak и keyguard пропускаются, остальные идут всегда.

Нативный модуль на реальных телефонах — [docs/fd-secure-checklist.md](docs/fd-secure-checklist.md).

## Что проверено и что нет

Проверено здесь:
- `npm test` — 21 тест: ядро; перекрёстно с keyguard — канонический JSON, подписи, HPKE (векторы RFC 9180), `key_put` (JWS)
  через настоящий обработчик; вход на **настоящем Keycloak 26.7.5** (DPoP-привязка, PKCE, повтор кода, украденный
  refresh-токен, password grant) и регистрация → подтверждение → сертификат → ввод ключа на обработчиках keyguard;
- раньше: 11 тестов ядра, включая побайтовое совпадение канонического JSON и хэша аргументов с Python-сервером,
  подпись Ed25519, CSR, который принимает Python `cryptography`;
- `npm run itest` — 13 проверок против живого сервера: подмена отпечатка, неверный пароль, регистрация с квитанцией
  и сертификатом, DPoP и отказ повтора, mTLS по серийному номеру, обновление токена, подтверждение с подписью,
  отказ без подписи и с подменёнными аргументами, переподключение потока, отзыв второго устройства;
- веб-сборка: весь путь в браузере (Playwright) — добавить сервер, сверить отпечаток, войти, чат, подтверждение,
  устройства, QR-приглашение (QR декодируется обратно в ту же ссылку), подмена отпечатка в QR.

**Не проверено:** нативный модуль `fd-secure` (Swift и Kotlin) не компилировался — в этой среде нет Xcode и закрыт доступ
к репозиториям Gradle. Первым делом в dev-сборке проверить:
1. iOS: создание ключей в Secure Enclave, подпись с Face ID, `SecIdentity` для mTLS из ключа SE + сертификата.
2. Android: StrongBox → откат на TEE, BiometricPrompt с `CryptoObject`, `X509ExtendedKeyManager` с ключом из Keystore в OkHttp.
3. Поток SSE через нативный транспорт (события `onStreamChunk`).

Проверка аттестации на сервере (цепочка Key Attestation до корней Google, App Attest до корня Apple) пока не сделана —
сервер сохраняет аттестацию, но не проверяет её.

Вход в кластер через Keycloak (OIDC + PKCE на `fugudeck://oauth`) — следующая итерация; эта версия работает с одиночными серверами.
