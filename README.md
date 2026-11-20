# Fugu Deck — приложение

| Папка | Что |
|---|---|
| `mobile/` | приложение Android: React Native + Expo, ключи устройства в чипе (модуль `fd-secure`), DPoP, аттестация, подписанные действия, вход в кластер, ввод ключей API для keyguard. Подробно — [mobile/README.md](mobile/README.md) |
| `desktop/windows/` | Windows-клиент на Electron поверх общего React Native-интерфейса: вход по коду с подтверждением на телефоне без Bluetooth/USB, Workspace, файлы и diff Git, CI, фоновые задачи, подписываемый SSH-терминал, command palette и уведомления |
| `backend/` | агент пространства (FastAPI): чаты, проекты, несколько агентов, база знаний, скилы, инструменты GitHub/GitLab, серверы (через ssh-gateway), MCP и страницы с разрешённых доменов (через keyguard), расписания, подтверждения. В кластере (`DECK_MODE=space`) к моделям, Git, MCP и сайтам ходит только через keyguard (`KEYGUARD_URL`) |
| `local/` | Fugu Local — второе приложение без сервера: модели напрямую с телефона ([local/README.md](local/README.md)) |

Архитектура и границы компонентов описаны в [технической документации](docs/TECHNICAL_ARCHITECTURE.md). Серверная монорепа и приватные manifests отделены от публичного клиента.

## Документация

Полная актуальная документация находится в [`docs/`](docs/README.md):

- [руководство пользователя](docs/USER_GUIDE.md);
- [интерфейс и маршрутизация](docs/INTERFACE.md);
- [техническая архитектура и протоколы](docs/TECHNICAL_ARCHITECTURE.md);
- [эксплуатация, GitHub Actions и образы](docs/OPERATIONS.md);
- [руководство для ИИ-разработчиков](docs/AI_DEVELOPMENT_GUIDE.md);
- [план развития](docs/ROADMAP.md).

Быстрые ссылки: [серверная платформа](https://github.com/stevv1e/fugu-deck-platform) · [релизы](https://github.com/stevv1e/fugu-deck-app/releases) · [официальные модули](https://github.com/stevv1e/fugu-modules) · [лендинг](https://fugu.ghostixel.io).

## Рабочие пространства, модели и модули

- Общий Workspace на Android и Windows показывает файлы и diff репозиториев, CI и запуски агента. Ручной SSH-терминал использует тот же шлюз и подписи, что инструменты агента; локальные shell-команды на ПК не выполняются.
- Каталог моделей поддерживает поиск, избранное, недавние, роли и fallback. Можно обновить список через `/models`; пользовательские OpenAI-совместимые endpoint разрешены только в standalone, чтобы кластер не обходил keyguard.
- Сценарий `code-review-summary` последовательно запускает исполнителя, независимое ревью без инструментов и сводку в отдельных под-чатах. Fallback срабатывает только до первого фрагмента ответа.
- Git-модули устанавливаются по commit с SHA-256 и запускаются в изолированном WebView/iframe. Официальный `index.json` подписан Ed25519; пользовательские источники маркируются отдельно. В приложении есть конструктор с локальной отладкой и атомарной публикацией в GitHub, центр безопасности с общим журналом агента/модулей, экспорт без API-ключей и необязательная E2EE-синхронизация Android и Windows. Официальный каталог: https://github.com/stevv1e/fugu-modules.

## Запуск и тесты

```bash
cd backend && pip install -r requirements-dev.txt && python -m pytest -q           # Python 3.12
APP_PASSWORD=dev COOKIE_SECURE=false SAKANA_API_KEY=... GITHUB_TOKEN=... uvicorn app.main:app --reload   # локально

cd mobile && npm ci && npm test && npm run typecheck     # Node 22
npx expo start            # Expo Go: программные ключи
npx expo run:android      # dev-сборка с ключами в чипе (модуль fd-secure)
```
Из корня репозитория то же делает `make test-app`, а `make integration` добавляет вход на настоящем Keycloak.

`backend` работает одним процессом (1 воркер): активные запуски агента и ожидающие подтверждения живут в памяти.

## Как добавить инструмент

```python
# backend/app/tools/ssh_tools.py
from .registry import tool, obj

@tool("run_command", "Выполнить команду на сервере",
      obj({"host": {"type": "string"}, "command": {"type": "string"}}, ["host", "command"]),
      risk="dangerous", group="ssh", title="Команда на сервере")
async def run_command(ctx, a):
    ...
```
Затем добавьте импорт в `tools/__init__.py`. Карточка подтверждения, журнал и учёт расходов подключатся автоматически.

## Два режима backend

| `DECK_MODE` | Что это | Состояние |
|---|---|---|
| `space` | пространство в кластере: вход по токену control-plane, ключи моделей и Git — только через keyguard | работает в test (личные и общие пространства) с 11.10; приложение работает с ним |
| `standalone` | один сервер: пароль владельца, ключи из `.env`, свой реестр устройств | интеграционные тесты приложения (`mobile/tests/integration.ts`) и проверка экранов в браузере |

`standalone` и код входа (`auth.py`) остаются ради тестов приложения без кластера.
