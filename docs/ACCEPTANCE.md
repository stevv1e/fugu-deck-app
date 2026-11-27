# Acceptance matrix Fugu Deck

Снимок: 27.11.2026, main 0.21.0, опубликованный клиент 0.18.1, Space 0.20.0, Control Plane 0.12.0, Space Operator 0.14.0; ручные сценарии нового релиза ещё не закрыты. Authenticode реализован в main, но подписанный релиз ещё не выпущен.

Матрица не заменяет тесты и не выдаёт их за проверку на устройстве. `PASS` означает, что указанный уровень проверки действительно выполнен; `PENDING` — сценарий ещё нужно выполнить на опубликованных APK/EXE. Пароли, токены, device IDs, invite/pairing secrets и содержимое чатов в результаты не вносятся.

## 1. Автоматические и production-проверки

| Область | Проверено | Результат |
| --- | --- | --- |
| Backend | 134 passed, 1 skipped в main со schema v29, durable resume, router, repo map, evals и KB evidence/verify: `cd backend && python -m pytest -q` | PASS |
| Harness offline | Router 4/4; synthetic 20 files: map reduction 76,45%, одна функция 83 символа против 113580 исходных; live модели не запускались | PASS только offline |
| Harness image/migration | Опубликованный Space 0.20.0: свежая БД получила schema v29 и durable tables, deterministic router выбрал code-модель; router также проверен в sleeping Space specs | PASS |
| Harness production chat | Реальный auto chat и resume после перезапуска; существующие Space спят и не пробуждались для проверки | PENDING |
| Mobile core | 72 passed, 5 skipped без локального `kgcheck`; typecheck и lint | PASS |
| KB evidence/on-demand | 15 targeted backend tests: компактный поиск, memory_read, fresh/stale/unavailable, current revision, REST verify и source evidence; 5 KB mobile tests | PASS |
| KB release/production | Space 0.21.0, APK/EXE 0.21.0, кнопка на Android/Windows и live-агент с изменившимся источником | PENDING |
| Public validation | Backend, mobile lint/typecheck/tests, action vectors, настоящий keyguard `kgcheck`, web export и Electron | [PASS](https://github.com/stevv1e/fugu-deck-app/actions/runs/45901309008) |
| Electron files/transport/updates | 7 passed в опубликованном 0.18.1; 10 passed в main, включая Authenticode configuration, NotSigned и чужого издателя: `cd desktop/windows && npm test` | PASS для unit/main |
| Authenticode release | Реальные `Get-AuthenticodeSignature = Valid`, совпадение subject и установка подписанного EXE; нужен сертификат издателя | PENDING |
| Android release 0.18.1 | GitHub Actions `apk`, release event; APK скачан, подпись manifest и SHA-256 проверены | [PASS](https://github.com/stevv1e/fugu-deck-app/actions/runs/45681555105) |
| Windows release 0.18.1 | GitHub Actions `exe`, release event; EXE скачан, подпись manifest и SHA-256 проверены | [PASS](https://github.com/stevv1e/fugu-deck-app/actions/runs/45681554880) |
| Space image 0.20.0 | GHCR build, push, cosign sign/verify; отдельный migration smoke schema v29 в опубликованном образе | [PASS](https://github.com/stevv1e/fugu-deck-app/actions/runs/46015574244) |
| Platform images 0.14.0 | keyguard, control-plane, space-operator и ssh-gateway собраны и подписаны | [PASS](https://github.com/stevv1e/fugu-deck-platform/actions/runs/46017508693) |
| Platform validation | Go race tests для четырёх компонентов и disposable Keycloak | [PASS](https://github.com/stevv1e/fugu-deck-platform/actions/runs/46017488005) |
| Production rollout | `deck-services` и `landing` Synced/Healthy; Control Plane 0.12.0, latest 0.18.1, previous 0.17.1, Space Operator 0.14.0, Space image 0.20.0; оба sleeping Space spec обновлены | PASS |
| Production chat mode | Личные Space спят; сквозной запуск и переключение на production ещё не выполнены | PENDING |
| Большое видео | Production-видео 582 МБ → keyguard → FFmpeg worker → корректные OGG-фрагменты | PASS |
| Space → worker | Реальный вызов через keyguard, получен корректный OGG | PASS |

## 2. Реальные Android и Windows

Проверять нужно опубликованный релиз, а не development build. Для каждой строки фиксируются версия, ОС устройства, фактический результат и ссылка на issue при ошибке.

| Сценарий | Автоматическая основа | Android | Windows |
| --- | --- | --- | --- |
| Pairing: положительный путь и обязательный `device_approve` | mobile/platform tests | Подтверждён ранее; повторить на 0.15.1 | Подтверждён ранее; повторить на 0.15.1 |
| Pairing: неверный и истёкший код, повтор и отмена | mobile/control-plane negative tests | PENDING | PENDING |
| Windows Hello после pairing, повторный PIN/биометрический вход и recovery | PKCE/AIA unit tests; нужен реальный ПК | Не применимо | PENDING на 0.17.1 |
| Повторный запуск и DPoP refresh без браузера | session/core tests | PENDING | PENDING |
| Revoke устройства и восстановление новым pairing | integration tests отзыва и повторной регистрации | PENDING | PENDING |
| Личные и общие пространства, проекты и участники | navigation/team tests | Общие данные подтверждены ранее; повторить на 0.15.1 | Общие данные подтверждены ранее; повторить на 0.15.1 |
| Чат, streaming, остановка ответа и multi-model | backend/mobile tests | Модели подтверждены ранее; полный сценарий PENDING | Модели подтверждены ранее; полный сценарий PENDING |
| Переключатель Инжиниринг/Общение с историей и возвратом исходного проекта | backend migration/move test и typecheck | PENDING на 0.18.1 | PENDING на 0.18.1 |
| Drive: read, write и create folder | backend tests с моками API | Create folder подтверждён ранее; read/write PENDING | PENDING |
| Media больше 250 МБ: загрузка, отмена и восстановление частей | chunk upload tests и production worker 582 МБ | PENDING | PENDING |
| Windows file picker, drag-and-drop, несколько файлов, Unicode, открытие и сохранение | Electron file bridge tests и chunked upload tests | Не применимо | PENDING на EXE 0.15.1 |
| Обновление с сохранением состояния, неверная подпись/hash и отмена | update manifest tests и Windows update bridge tests | PENDING на APK 0.18.1 | PENDING на EXE 0.18.1 |
| Beta channel и явный rollback на предыдущий stable | отдельные signed-manifest и Windows IPC tests | Beta update PENDING; downgrade поверх не поддерживается ОС | PENDING на EXE 0.18.1 |
| Authenticode: доверенный publisher, NotSigned/чужой publisher, rollback на подписанный stable | 10 Electron tests в main и обязательная CI-проверка двух EXE | Не применимо | PENDING на следующем подписанном EXE |
| Официальный и custom Git module, сетевые блокировки и журнал | module sandbox/signature/journal tests | PENDING | PENDING |
| E2EE в обе стороны, неверная фраза и конфликт версий | backup round-trip, authentication и optimistic conflict tests | PENDING | PENDING |
| База знаний: источник, ревизия, fresh/stale/unavailable и ручная пометка | FTS5/BM25 и source-check tests | PENDING на 0.17.0 | PENDING на 0.17.0 |

## 3. Порядок ручного прогона

1. Установить APK и EXE из одного GitHub Release и сверить SHA-256.
2. Проверить pairing, повторный запуск и revoke до остальных сценариев.
3. На одном и том же пространстве проверить чат, модели, Drive и вложения на обоих устройствах.
4. Для media использовать файл больше 250 МБ; отдельно проверить отмену, обрыв и возобновление.
5. Проверить модули и E2EE, включая неверную фразу и одновременные offline-изменения.
6. Заменить `PENDING` фактическим результатом; при ошибке завести issue и не помечать сценарий успешным.

P0 считается завершённым только после заполнения этой таблицы фактическими результатами и успешного повторного CI без ручных обходов.
