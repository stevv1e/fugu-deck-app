# Эксплуатация, тестирование и сборки Fugu Deck

## 1. Локальные требования

- Node.js 22 и npm;
- Python 3.12 для backend;
- Go 1.26 для серверных Go-компонентов в монорепе;
- Docker для интеграционных стендов и образов;
- Android SDK/Gradle для локальной нативной сборки, если GitHub Actions недоступен.

В Expo-проекте используйте команды из `mobile/AGENTS.md`. Не обновляйте Expo/React Native и не добавляйте зависимости без проверки manifest/lockfile.

## 2. Проверки приложения

```bash
cd mobile
npm ci
npm test
npm run typecheck
npm run web:export
```

Для полного `npm test` нужны Python-зависимости backend: кросс-тесты вызывают его код. В чистом окружении создайте временный venv и установите `backend/requirements-dev.txt`.

Точечный lint изменённых файлов:

```bash
npx eslint <изменённые-файлы>
```

Полный lint обязателен для push/PR; известных исключений для старых экранов нет.

Windows transport:

```bash
cd desktop/windows
npm ci
npm test
```

Backend:

```bash
cd backend
python -m pip install -r requirements-dev.txt
python -m pytest -q
```

Лимиты одного agent run задаются `MAX_AGENT_STEPS`, `AGENT_MAX_RUN_SECONDS`, `AGENT_MAX_TOTAL_TOKENS`, `AGENT_MAX_COST_USD` и `AGENT_MAX_TOOL_CALLS`. Ноль для параметров `AGENT_*` отключает соответствующий дополнительный лимит; `MAX_AGENT_STEPS` остаётся обязательным.

## 3. Интеграционные проверки

- Keycloak image test поднимает одноразовый Keycloak, создаёт пользователя, проверяет passkey и pairing pending/approved → OAuth code.
- Control plane unit tests проверяют pairing lifecycle, подмену ника/ключа/кода/подписанта и повторное подтверждение.
- Postgres test проверяет общее состояние и гонку двух реплик.
- Keyguard Go tests проверяют TypeScript/Go action vectors и правила доступа.
- Device-to-device сценарий остаётся обязательным: установка APK/EXE, pairing, активация ПК, чат, модель и E2EE-перенос. Web export и unit tests не заменяют эту проверку.

## 4. GitHub Actions приложения

Репозиторий: https://github.com/stevv1e/fugu-deck-app/actions

- `validate.yaml` — backend tests, mobile lint/typecheck/tests, общие action vectors, настоящий keyguard `kgcheck`, web export и Electron transport на push/PR.
- `android.yml` — Expo prebuild, arm64 release APK, подпись keystore из Actions secrets, загрузка артефакта и публикация в Release.
- `windows.yml` — Expo web export, Electron transport tests, NSIS x64 installer и публикация в Release.

Сборки запускаются для main и создания Release. Для релиза не нужно собирать APK/EXE на production-сервере.

После публикации:

1. Скачайте оба опубликованных файла обратно.
2. Сравните имена и размеры с release assets.
3. Создайте/проверьте `SHA256SUMS.txt` по скачанным файлам.
4. Загрузите checksums в тот же Release. Release workflows также публикуют подписанные отдельным Ed25519-ключом из `DECK_UPDATE_PRIVATE_KEY` манифесты: `update-android.json`/`update-windows.json` для stable и `update-android-beta.json`/`update-windows-beta.json` для pre-release.
5. Обновите прямые ссылки лендинга.

Stable Release и Beta pre-release используют один формат `fugu-deck-update/1`, но разные значения `channel` и разные имена манифестов. Клиент принимает beta только после явного выбора канала; подмена канала или Release URL отклоняется. Control Plane получает `DECK_APP_LATEST`, `DECK_APP_URL`, необязательные `DECK_APP_BETA`, `DECK_APP_BETA_URL`, а также `DECK_APP_PREVIOUS`, `DECK_APP_PREVIOUS_URL` для восстановления Windows.

Windows rollback является отдельной операцией: предыдущий stable скачивается и проверяется так же, как обновление, но запускается только кнопкой подтверждения. Не выдавайте его за автоматический атомарный откат: установка поверх и сохранение состояния проверяются на реальном ПК. Android не поддерживает обычную установку APK с меньшим `versionCode`; для него нужен отдельный recovery-пакет с новым номером сборки, которого пока нет.

## 5. Серверные образы

Публичные GHCR-имена:

```text
ghcr.io/stevv1e/deck-space
ghcr.io/stevv1e/deck-space-operator
ghcr.io/stevv1e/deck-control-plane
ghcr.io/stevv1e/deck-keyguard
ghcr.io/stevv1e/deck-ssh-gateway
ghcr.io/stevv1e/deck-keycloak
ghcr.io/stevv1e/deck-squid
```

### Публичные source repositories и workflows

- `fugu-deck-platform/.github/workflows/release.yaml` — space-operator, control plane, keyguard и SSH Gateway.
- `fugu-deck-platform/.github/workflows/platform-images.yaml` — Keycloak и Squid.
- `fugu-deck-app/.github/workflows/space-image.yaml` — `deck-space` из публичного `backend/`.

Push в main создаёт `main-<sha>`, тег `vX.Y.Z` создаёт `X.Y.Z` там, где это предусмотрено workflow. Dockerfile Go-сервисов выполняет тесты до сборки результата. Образы публикуются в GHCR и подписываются cosign keyless. Kyverno проверяет issuer и точный workflow identity; production может закреплять образ по digest.

Приватная монорепа на переходный период сохраняет прежние workflows и overlays, но не является новым каноническим публичным источником.

### Требование к зелёной сборке

Релиз нельзя считать полностью собранным, пока все нужные matrix jobs не `completed success`. Ошибку `permission_denied: write_package` исправляют через GHCR Actions access для связанного репозитория, а не публикацией неподписанного обходного образа.

## 6. Порядок релиза

### Приложение

1. Обновить `VERSION` и версии/lockfile Windows.
2. Прогнать полный mobile/backend/Electron набор и реальные пользовательские сценарии.
3. Опубликовать main и тег `vX.Y.Z`.
4. Создать GitHub Release и дождаться APK/EXE.
5. Проверить assets и SHA-256.

### Сервер

1. Обновить зависимые action vectors и документацию.
2. Выпустить серверный тег и дождаться всех необходимых образов.
3. Обновить control plane/keyguard/space tags по фактической области изменений.
4. Для Keycloak зафиксировать новый подписанный digest.
5. Обновить `DECK_APP_LATEST`, `DECK_APP_URL` и лендинг.
6. Дать GitOps применить изменения и дождаться Synced/Healthy.
7. Проверить публичный OIDC, pairing, регистрацию, чат и модель.

## 7. Диагностика

### Pairing 404

Проверьте, что публичный join route пропускает точный `Path(/v1/pair/start)` и имеет invite-gate. Наличие работающего `/v1/enroll` не доказывает наличие pairing route.

### ПК видит ожидание, но телефон не находит код

Проверьте срок 15 минут, активную сессию телефона, API mTLS и отсутствие подмены регистра кода. Не создавайте pairing вручную в базе для обхода ошибки.

### Телефон подтвердил код, но ПК не получает OAuth

Проверьте `X-Deck-Pair-Status` на invite-gate, его копирование Traefik и authenticator Keycloak. Не принимайте этот заголовок напрямую от интернет-клиента.

### Устройство зарегистрировано, но API запрещает доступ

Проверьте второе `device_approve`, статус active, сертификат, session key и refresh token. Pairing approval сам не выпускает сертификат.

### Модель возвращает 401/403/404

Отдельно проверьте ключ, provider endpoint, модель и регион. Не считайте причиной одинаковой ошибки приложение без подтверждения. Sakana/Google могут требовать отдельный сетевой egress.

### Drive access_denied

Проверьте consent screen, тестового пользователя и scopes. Refresh token не выводить в логи и не сохранять в клиентском общем хранилище.

## 8. Правила публикации операционной информации

Можно публиковать архитектуру, имена образов, команды тестов, generic manifest и чек-листы. Нельзя публиковать PAT, OAuth secrets, refresh tokens, приватные ключи, keystore, DB DSN, реальные invites/pairing secrets и приватные egress credentials.
