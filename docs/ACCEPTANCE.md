# Acceptance matrix Fugu Deck

Снимок: 24.11.2026, опубликованный клиент и Space 0.15.1, platform components 0.12.x.

Матрица не заменяет тесты и не выдаёт их за проверку на устройстве. `PASS` означает, что указанный уровень проверки действительно выполнен; `PENDING` — сценарий ещё нужно выполнить на опубликованных APK/EXE. Пароли, токены, device IDs, invite/pairing secrets и содержимое чатов в результаты не вносятся.

## 1. Автоматические и production-проверки

| Область | Проверено | Результат |
| --- | --- | --- |
| Backend | 113 passed, 1 skipped: `cd backend && python -m pytest -q` | PASS |
| Mobile core | 69 passed, 5 skipped без локального `kgcheck`; typecheck | PASS |
| Public validation | Backend, mobile lint/typecheck/tests, action vectors, настоящий keyguard `kgcheck`, web export и Electron | [PASS](https://github.com/stevv1e/fugu-deck-app/actions/runs/45436411065) |
| Electron files/transport | 4 passed: `cd desktop/windows && npm test` | PASS |
| Android release 0.15.1 | GitHub Actions `apk`, release event; asset скачан и проверен | [PASS](https://github.com/stevv1e/fugu-deck-app/actions/runs/45437713799) |
| Windows release 0.15.1 | GitHub Actions `exe`, release event; asset скачан и проверен | [PASS](https://github.com/stevv1e/fugu-deck-app/actions/runs/45437714189) |
| Space image 0.15.1 | GHCR build, push, cosign sign/verify | [PASS](https://github.com/stevv1e/fugu-deck-app/actions/runs/45437705801) |
| Platform images | keyguard, control-plane, space-operator и ssh-gateway собраны и подписаны | [PASS](https://github.com/stevv1e/fugu-deck-platform/actions/runs/44804818638) |
| Platform validation | Go race tests для четырёх компонентов и disposable Keycloak | [PASS](https://github.com/stevv1e/fugu-deck-platform/actions/runs/44805580530) |
| Большое видео | Production-видео 582 МБ → keyguard → FFmpeg worker → корректные OGG-фрагменты | PASS |
| Space → worker | Реальный вызов через keyguard, получен корректный OGG | PASS |

## 2. Реальные Android и Windows

Проверять нужно опубликованный релиз, а не development build. Для каждой строки фиксируются версия, ОС устройства, фактический результат и ссылка на issue при ошибке.

| Сценарий | Автоматическая основа | Android | Windows |
| --- | --- | --- | --- |
| Pairing: положительный путь и обязательный `device_approve` | mobile/platform tests | Подтверждён ранее; повторить на 0.15.1 | Подтверждён ранее; повторить на 0.15.1 |
| Pairing: неверный и истёкший код, повтор и отмена | mobile/control-plane negative tests | PENDING | PENDING |
| Повторный запуск и DPoP refresh без браузера | session/core tests | PENDING | PENDING |
| Revoke устройства и восстановление новым pairing | integration tests отзыва и повторной регистрации | PENDING | PENDING |
| Личные и общие пространства, проекты и участники | navigation/team tests | Общие данные подтверждены ранее; повторить на 0.15.1 | Общие данные подтверждены ранее; повторить на 0.15.1 |
| Чат, streaming, остановка ответа и multi-model | backend/mobile tests | Модели подтверждены ранее; полный сценарий PENDING | Модели подтверждены ранее; полный сценарий PENDING |
| Drive: read, write и create folder | backend tests с моками API | Create folder подтверждён ранее; read/write PENDING | PENDING |
| Media больше 250 МБ: загрузка, отмена и восстановление частей | chunk upload tests и production worker 582 МБ | PENDING | PENDING |
| Windows file picker, drag-and-drop, несколько файлов, Unicode, открытие и сохранение | Electron file bridge tests и chunked upload tests | Не применимо | PENDING на EXE 0.15.1 |
| Обновление с сохранением состояния, неверная подпись/hash и отмена | update manifest tests и Windows update bridge tests | PENDING на APK 0.16.0 | PENDING на EXE 0.16.0 |
| Официальный и custom Git module, сетевые блокировки и журнал | module sandbox/signature/journal tests | PENDING | PENDING |
| E2EE в обе стороны, неверная фраза и конфликт версий | backup round-trip, authentication и optimistic conflict tests | PENDING | PENDING |

## 3. Порядок ручного прогона

1. Установить APK и EXE из одного GitHub Release и сверить SHA-256.
2. Проверить pairing, повторный запуск и revoke до остальных сценариев.
3. На одном и том же пространстве проверить чат, модели, Drive и вложения на обоих устройствах.
4. Для media использовать файл больше 250 МБ; отдельно проверить отмену, обрыв и возобновление.
5. Проверить модули и E2EE, включая неверную фразу и одновременные offline-изменения.
6. Заменить `PENDING` фактическим результатом; при ошибке завести issue и не помечать сценарий успешным.

P0 считается завершённым только после заполнения этой таблицы фактическими результатами и успешного повторного CI без ручных обходов.
