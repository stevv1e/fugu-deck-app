# Fugu Deck — приложение

| Папка | Что |
|---|---|
| `mobile/` | нативное приложение, единственный клиент: React Native + Expo, ключи устройства в чипе (модуль `fd-secure`), DPoP, аттестация, подписанные действия, вход в кластер, ввод ключей API для keyguard. Подробно — [mobile/README.md](mobile/README.md) |
| `backend/` | агент пространства (FastAPI): чаты, проекты, память, скилы, инструменты GitHub/GitLab, подтверждения. В кластере (`DECK_MODE=space`) к моделям и Git ходит только через keyguard (`KEYGUARD_URL`) |

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
| `space` | пространство в кластере: вход по токену control-plane, ключи моделей и Git — только через keyguard | проверено тестами и стендом `fugu-deck-keyguard/scripts/space_e2e.sh`; в кластере не запускалось — нет control-plane v2 и space-operator |
| `standalone` | один сервер: пароль владельца, ключи из `.env`, свой реестр устройств | на нём сейчас работает приложение и идут его интеграционные тесты (`mobile/tests/integration.ts`) |

Когда вход в кластер заработает целиком, режим `standalone` и связанный с ним код входа (`auth.py`) можно убрать.
