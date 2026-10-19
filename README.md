# Fugu Deck — приложение

| Папка | Что |
|---|---|
| `mobile/` | нативное приложение, единственный клиент: React Native + Expo, ключи устройства в чипе (модуль `fd-secure`), DPoP, аттестация, подписанные действия, вход в кластер, ввод ключей API для keyguard. Подробно — [mobile/README.md](mobile/README.md) |
| `backend/` | агент пространства (FastAPI): чаты, проекты, несколько агентов, база знаний, скилы, инструменты GitHub/GitLab, серверы (через ssh-gateway), MCP и страницы с разрешённых доменов (через keyguard), расписания, подтверждения. В кластере (`DECK_MODE=space`) к моделям, Git, MCP и сайтам ходит только через keyguard (`KEYGUARD_URL`) |
| `local/` | Fugu Local — второе приложение без сервера: модели напрямую с телефона ([local/README.md](local/README.md)) |

Архитектура — `../docs/ARCHITECTURE-v2.md`, инфраструктура кластера — `../fugu-deck-infra/`, keyguard — `../fugu-deck-keyguard/`.

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
