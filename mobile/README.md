# Fugu Deck — мобильное приложение

React Native + Expo (SDK 57, Expo Router) — единственный клиент Fugu Deck. Работает с двумя видами серверов:

- **кластер v2** (`fugu-deck-infra`): вход по QR-приглашению через Keycloak, ключи устройства в чипе, аттестация,
  подписанные действия для keyguard, ввод ключей API — раздел «Кластер v2»;
- **одиночный сервер** (`../backend` в режиме `standalone`): QR или адрес, сервер проверяется по отпечатку своего
  ключа. На нём приложение работает сейчас целиком — control-plane кластера ещё не написан.

Вход — по ключу устройства (DPoP), важные действия подписываются ключом с биометрией.

## Что умеет

| Экран | Что делает |
|---|---|
| Серверы | список ваших серверов; у каждого свой закреплённый ключ и свои ключи устройства |
| Новый сервер | QR (`fugudeck://add?url=…&fp=…&name=…`) или адрес; показывает отпечаток, при QR сверяет его сам |
| Вход | пароль (+ код владельца) один раз → телефон создаёт ключи и регистрируется |
| Проекты, чаты | проекты, чаты с агентом, поток ответа, карточки инструментов |
| Кластер | вход по приглашению, статус устройства и аттестации, ввод ключей API |
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
  cluster.ts     кластер v2: приглашение, PKCE + DPoP, вызов для аттестации, регистрация, статус, подпись действий (JWS)
  actions.ts     схема подписанных действий: точный набор полей, текст для биометрии (её же проверяет keyguard)
  hpke.ts        HPKE (RFC 9180) — шифрование ключа API для keyguard
  apikeys.ts     ввод ключа API: шифротекст + подписанное действие key_put
src/platform/    хранилища, выбор ключей (чип / программные), транспорт (fetch+XHR / нативный mTLS)
src/state/       серверы и сессии (React context)
src/ui/          темы и элементы интерфейса
src/app/         экраны (Expo Router)
modules/fd-secure/  нативный модуль: Swift (Secure Enclave, App Attest, URLSession с клиентским сертификатом)
                    и Kotlin (Android Keystore/StrongBox, BiometricPrompt, Key Attestation, OkHttp с mTLS)
```

## Ключи на телефоне

| | Сборка с fd-secure | Expo Go |
|---|---|---|
| ключ сессии | Secure Enclave / StrongBox / TEE | P-256 в Keychain/Keystore через expo-secure-store |
| ключ подтверждения | в чипе, биометрия на **каждую** подпись, сбрасывается при смене биометрии | секрет читается только с биометрией (`requireAuthentication`) |
| аттестация | Android Key Attestation (вызов сервера внутри), iOS App Attest | нет |
| mTLS | да, ключ сессии из чипа участвует в TLS | нет (только DPoP) |

keyguard кластера проверяет аттестацию при регистрации: в режиме `required` устройство с программными ключами
(Expo Go, эмулятор) не зарегистрируется, в `optional` — регистрируется без отметки. Одиночный сервер аттестацию только
сохраняет и видит `key_storage` со слов приложения.

## Запуск

```bash
npm ci                   # Node 22 (.nvmrc в корне репозитория)
npm test                 # ядро + перекрёстно с Python-сервером; с KGCHECK — перекрёстно с keyguard
npm run typecheck
npx expo lint
npm run vectors          # пересоздать общие векторы схемы действий для keyguard (после правки actions.ts)

npx expo start           # Expo Go: работает на программных ключах, без mTLS
npx expo run:ios         # dev-сборка с модулем fd-secure (нужен Xcode)
npx expo run:android     # dev-сборка с модулем fd-secure (нужен Android SDK)
npx eas-cli@latest build --profile development   # то же в облаке EAS
```

### Установка на телефон

**Android.** APK собирает CI: GitHub → Actions → **mobile-android** → последний зелёный запуск → Artifacts →
`fugu-deck-android`. Распакуйте архив и установите `app-release.apk`: откройте файл на телефоне (разрешив установку из
этого источника) или `adb install app-release.apk`. Сборка — только для `arm64-v8a`, с нативным модулем `fd-secure`,
JS внутри (Metro не нужен). Подписана общеизвестным отладочным ключом Expo — для проверки, не для раздачи.
Локально то же: `npx expo prebuild --platform android && cd android && ./gradlew assembleRelease` (нужны JDK 17 и Android SDK).

**iPhone.** Нужны Mac с Xcode и участие в Apple Developer Program (подпись и App Attest): `npx expo run:ios --device`
или `npx eas-cli@latest build --platform ios`. В CI не собирается — без сертификата Apple на устройство не поставить.

**После установки приложению нужен сервер**: одиночный (`../backend`, раздел ниже) — по HTTPS: само приложение
допускает `http://` для адресов локальной сети, но release-сборка Android незашифрованный трафик не пропускает.
Кластер — вход в него заработает только с control-plane v2, которого ещё нет.

Сквозной тест ядра против одиночного сервера:
```bash
cd ../backend
uvicorn tests.mock_server:app --port 9100 &
SAKANA_API_KEY=x SAKANA_BASE_URL=http://127.0.0.1:9100/v1 GITHUB_TOKEN=x GITHUB_API_URL=http://127.0.0.1:9100/gh \
  APP_PASSWORD=test-pass COOKIE_SECURE=false MTLS_MODE=optional uvicorn app.main:app --port 8000 &
cd ../mobile && npm run itest
```

## Одиночный сервер: что настроить

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

Приложение входит в кластер по QR-приглашению `fugudeck://join?api=…&iss=…&join=…&hpke=…&invite=…`:

| Шаг | Где в коде |
|---|---|
| разбор приглашения: только https, один домен, ключ keyguard на кривой | `src/core/cluster.ts` `parseClusterInvite` |
| вход в Keycloak через системный браузер, PKCE S256, проверка `state` | `browserStartUrl`, `parseRedirect` |
| вызов для аттестации — до создания ключей: чип вписывает его в аттестацию | `fetchChallenge`; `src/app/join.tsx` |
| обмен кода на токен **с DPoP**; непривязанный Bearer — отказ | `exchangeCode`, `refresh` |
| регистрация: токен + DPoP + действие `device_enroll` — JWS (биометрия) + CSR ключом сессии + аттестация и вызов | `buildEnroll` |
| ожидание подтверждения, сертификат mTLS | `fetchStatus`; экран `src/app/cluster/[cid].tsx` |
| ввод ключа API: HPKE для keyguard + подпись + хэш шифротекста | `src/core/hpke.ts`, `src/core/apikeys.ts` |
| схема подписанных действий: точный набор полей, запрет невидимых символов, текст для биометрии из тех же полей | `src/core/actions.ts` (`prepareAction`); `signClusterAction` подписывает только подготовленное |

Экраны: `src/app/join.tsx` (вход), `src/app/cluster/[cid].tsx` (статус, ключи), `src/app/oauth.tsx` (возврат из браузера).
Сервер кластера, к которому обращаются `join/v1/enroll`, `join/v1/enroll/challenge`, `join/v1/enroll/status` и
`api/v1/keys`, — control-plane v2: **его кода пока нет**; он передаёт запросы в keyguard как есть (`/v1/devices`,
`/v1/devices/challenge`, `/v1/devices/status`, `/v1/keys`). Поэтому вход в кластер проверен на обработчиках keyguard и
настоящем Keycloak, но не против развёрнутого кластера.

Тесты кластера (`npm test`):
```bash
KGCHECK=…/fugu-deck-keyguard/kgcheck   # go build -o kgcheck ./cmd/kgcheck — перекрёстные проверки с keyguard
KC_URL=http://127.0.0.1:8081           # Keycloak 26.7 с realm deck (скрипт настройки — docs/keycloak-test-realm.sh)
```
Без переменных тесты с Keycloak и keyguard пропускаются, остальные идут всегда. `scripts/keycloak_test.sh` поднимает
одноразовый Keycloak в docker, настраивает realm, собирает `kgcheck` и запускает тесты кластера целиком (идёт в CI).

Нативный модуль на реальных телефонах — [docs/fd-secure-checklist.md](docs/fd-secure-checklist.md).

## Что проверено и что нет

Проверено (всё идёт в CI):
- `npm test` — 23 теста: ядро (канонический JSON и хэш аргументов байт в байт с Python-сервером, Ed25519, ES256, DPoP,
  CSR, SSE); схема действий и текст для биометрии; перекрёстно с keyguard через `kgcheck` — канонический JSON, подпись
  JWS, HPKE (векторы RFC 9180), ввод ключа через настоящий обработчик; запрос вызова для аттестации;
- `scripts/keycloak_test.sh` — на **настоящем Keycloak 26.7.5**: вход кодом приложения с PKCE и DPoP, атаки на выдачу
  токена (повтор кода, чужой `code_verifier`, украденный refresh-токен, password grant), регистрация в keyguard →
  ожидание → подтверждение администратором → сертификат → ввод ключа;
- `npx tsx tests/vectors.ts --check` — общие векторы схемы действий актуальны (17 принимаются, 28 отклоняются обеими
  реализациями — приложением и keyguard);
- `npm run itest` (вручную) — 13 проверок против живого одиночного сервера: подмена отпечатка, регистрация с квитанцией
  и сертификатом, DPoP и отказ повтора, mTLS по серийному номеру, подтверждение с подписью, отзыв устройства.

**Не проверено:**
- **Нативный модуль `fd-secure`** (Swift и Kotlin) не компилировался и не запускался на телефонах. Первым делом в
  dev-сборке: ключи в Secure Enclave / StrongBox, подпись с биометрией, mTLS с ключом из чипа, поток SSE через
  нативный транспорт — [docs/fd-secure-checklist.md](docs/fd-secure-checklist.md).
- **Аттестация на реальных устройствах.** keyguard её проверяет (Android Key Attestation, Apple App Attest), но
  принимаемую настоящую аттестацию без телефона не построить — раздел 5 чек-листа.
- **Вход в развёрнутый кластер**: нет control-plane v2, через который идут запросы приложения.
- Экраны разрешений спонсоров и подтверждения чужих устройств для кластера: схема действий и keyguard готовы,
  интерфейса нет.
