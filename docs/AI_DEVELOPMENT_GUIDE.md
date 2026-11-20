# Руководство для ИИ-разработчиков Fugu Deck

Этот документ — рабочий контракт для AI coding agents. Сначала прочитайте пользовательский запрос, затем этот файл, ближайший `AGENTS.md` и [техническую архитектуру](TECHNICAL_ARCHITECTURE.md). Не воспринимайте устаревший roadmap как доказательство реализованной функции: проверяйте код и живой сценарий.

## 1. Что должно оставаться истинным

1. Мобильный passkey flow не ослабляется и не заменяется Windows pairing.
2. Windows pairing не активирует устройство сам: после OAuth/enroll остаётся обязательный `device_approve`.
3. Session key и confirmation key разделены. Подписи действий выполняет confirmation key.
4. Любой новый action имеет одинаковую строгую схему в TypeScript и Go, понятный текст подтверждения и общие векторы.
5. API-ключи, OAuth refresh tokens и Git credentials не попадают в открытый backend, модули, экспорт или логи.
6. Новое устройство начинает с pending; revoked/pending не подписывает действия.
7. Пользовательские Git-модули остаются sandbox-кодом, а не произвольным Node.js/native кодом.
8. Standalone custom endpoint не появляется в кластерном режиме в обход keyguard.
9. Локальные AI-модели не добавляются как якобы работающая функция на слабых устройствах.
10. Нельзя объявлять работу завершённой только по компиляции или import test.

## 2. Карта репозиториев

### Публичный `fugu-deck-app`

- `mobile/src/app/` — Expo Router screens.
- `mobile/src/core/` — протоколы, OAuth/DPoP, действия, модули, backup, модели.
- `mobile/src/platform/` — Electron/native/storage/files bridge.
- `mobile/src/ui/` — общие компоненты и desktop/mobile оболочки.
- `mobile/tests/` — Node tests, интеграции и action vectors.
- `desktop/windows/` — Electron main/preload/net и NSIS build.
- `backend/app/` — FastAPI space/standalone backend.
- `backend/tests/` — backend tests.
- `local/` — standalone client.
- `docs/` — актуальная публичная документация.

### Публичный `fugu-deck-platform`

- `control-plane/` — invites, pairing, users, spaces, Drive OAuth.
- `keyguard/` — устройства, действия, секреты, egress, media/Drive proxy.
- `space-operator/`, `ssh-gateway/` — отдельные серверные исполнители.
- `images/keycloak/`, `images/squid/` — публичные исходники platform images.
- `kubernetes/platform/` — generic manifests без реальных окружений.

### Приватная монорепа

Содержит зеркало компонентов на переходный период, реальные deployment-overlays и расширенную приватную архитектуру. Новый канонический серверный код — публичный `fugu-deck-platform`; изменения синхронизируются туда и в зеркало до завершения переключения GitOps.

Изменения общего приложения сначала проверяются в публичном дереве, затем синхронизируются в `fugu-deck-app/` монорепы. Не позволяйте версиям разойтись.

## 3. Алгоритм каждой задачи

1. Сформулируйте проверяемый пользовательский результат.
2. Прочитайте существующую реализацию и тесты; не заменяйте архитектуру по памяти.
3. Найдите доверенную границу: кто проверяет подпись, токен, право и повтор.
4. Сделайте минимальный согласованный diff во всех слоях протокола.
5. Обновите тесты положительного пути и атак.
6. Обновите комментарии/docs, описывающие старое поведение.
7. Запустите стандартные команды и реальный сценарий.
8. Проверьте git status, отсутствие секретов/логов/временных файлов.
9. При выпуске проверьте опубликованный артефакт, а не только успешный job.

Если стандартная проверка заблокирована окружением, установите зависимости во временное окружение или поднимите предусмотренный disposable стенд. Не сокращайте проверку молча.

## 4. Изменение signed action

Обязательный порядок:

1. Добавьте тип и точные поля в `mobile/src/core/actions.ts`.
2. Добавьте человекочитаемый `describeAction`/prompt из этих же полей.
3. Обновите `fugu-deck-keyguard/schema.go`.
4. Разрешите проверку только конкретному caller в `ActionVerifiers`.
5. Проверьте владельца/роль/пространство в server handler после криптографической проверки.
6. Добавьте положительный вектор в `mobile/tests/vectors.ts` и при необходимости invalid vectors.
7. Пересоздайте `action-vectors.json` и прогните Go tests.
8. Добавьте server/client tests на подмену каждого критичного поля, replay, stale timestamp, чужое устройство и повтор.

Запрещено передавать отдельный неподписанный `nick`/`target` и считать его доверенным только потому, что запрос пришёл от клиента.

## 5. Изменение pairing или входа

Проверьте одновременно:

- invite TTL/used state;
- pairing TTL, secret hash и cookie flags;
- привязку pairing к нику, имени, device ID, session JKT и коду;
- атомарное однократное approve в memory и Postgres;
- trusted headers только от forwardAuth;
- pending не падает обратно в WebAuthn/USB;
- approved выдаёт обычный OAuth code с PKCE;
- token exchange и refresh остаются DPoP;
- enroll создаёт pending, не active;
- обычный `/start` очищает старую pairing cookie;
- мобильный browserStartUrl не содержит pairing параметров.

Обязательные тесты: control plane, Keycloak disposable, keyguard vectors, mobile core, затем реальные ПК+телефон.

## 6. Изменение моделей и провайдеров

Не ограничивайтесь пунктом в UI-каталоге. Проверьте:

- backend catalog и standalone catalog;
- provider API endpoint, auth header и model ID по официальной документации;
- keyguard proxy allowlist, цены, лимиты и streaming;
- шифрование/удаление ключа;
- UI выбора и роли;
- fallback не повторяет частично выданный ответ;
- региональный egress, если провайдер недоступен из кластера.

Реальный платный запрос помечайте отдельно и не выдумывайте его успех. Ошибку 401/403/404 диагностируйте по фактическому ответу.

## 7. Изменение модулей

Перед добавлением capability определите угрозу и RPC-модель. Нельзя просто передать модулю AsyncStorage, fetch ко всем доменам, Git token, SSH или Node `require`.

Минимум:

- manifest schema и версия приложения;
- pinned commit и SHA-256;
- проверка официальной подписи по сырым байтам;
- отдельная маркировка пользовательского источника;
- sandbox origin и CSP;
- allowlist RPC/network, лимиты и журнал;
- offline/upgrade/remove tests;
- export не включает секреты;
- server execution — только отдельный безопасный этап, не неявный побочный эффект UI-функции.

## 8. Media и Drive

Для больших файлов проверяйте не только начало загрузки: лимиты, chunking, отмену, restart, формат каждого фрагмента, склейку и итоговую полноту. Не маскируйте неожиданный ответ модели пустым успешным transcript.

Для Drive используйте OAuth state/PKCE и серверный refresh-token exchange. Не печатайте access/refresh tokens. Операции read/write/create folder должны проходить через существующий keyguard boundary.

## 9. Стиль кода

- Следуйте локальным naming/structural idioms.
- Не добавляйте комментарии, повторяющие очевидный код. Обновляйте комментарии, которые описывают изменённый протокол.
- Не добавляйте зависимость, пока не подтверждено её отсутствие и необходимость.
- Не редактируйте вручную generated native Android/iOS dirs при CNG.
- Не исправляйте unrelated bugs в функциональном PR; сообщайте о них отдельно.
- Не публикуйте реальные invites, pairing secrets, PAT, OAuth secrets, DSN, keystores или device private keys в docs/tests.

## 10. Обязательная матрица проверок

Для UI: профильные tests, полный mobile test с backend Python dependencies, typecheck, lint changed files, web export, Electron tests.

Для control plane: Go tests, Postgres shared-state test для новой persistent сущности, race/atomicity, живой HTTPS маршрут.

Для keyguard: Go tests, action vectors, негативные подписи и caller permissions.

Для Keycloak/Traefik: disposable integration test и live smoke после rollout. Manifest в Git не равен работающему IngressRoute.

Для release: GitHub jobs success, скачанные release assets, SHA-256, production Synced/Healthy и пользовательский end-to-end.

## 11. Работа с GitHub и релизами

Используйте существующие workflows; не переносите сборку APK/EXE на production. PAT никогда не помещайте в remote URL, committed config, docs или output. GHCR job должен подписывать образ cosign keyless; не заменяйте его неподписанным ручным push.

Если GHCR запрещает `write_package`, исправьте Actions access пакета для репозитория или отдельно описанную безопасную авторизацию. Не удаляйте существующий package вместе с production-тегами ради быстрого обхода.

## 12. Критерий завершения

Задача завершена, когда:

- реализованы все части запроса;
- профильные и стандартные проверки зелёные;
- пользовательский сценарий выполнен на реальных вызовах;
- docs соответствуют коду;
- изменения опубликованы в нужные репозитории;
- релизные файлы/образы действительно доступны;
- production healthy;
- непроверенная часть явно названа.

Нельзя называть E2EE device-to-device, реальные provider keys, Windows Hello или live phone approval проверенными, если выполнялись только mocks/unit tests.
