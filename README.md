# Fugu Deck — приложение

Единственный клиент — нативное приложение (`mobile/`). Веб-клиент (PWA), control-plane v1, кластерная обвязка v1 и
установка через docker compose удалены 06.10.2026 (`fugu-deck-infra/docs/decisions.md`, D26).

| Папка | Что |
|---|---|
| `mobile/` | React Native + Expo: ключи устройства в чипе (модуль `fd-secure`), DPoP, подписанные подтверждения, вход в кластер, ввод ключей API для keyguard. Подробно — [mobile/README.md](mobile/README.md) |
| `backend/` | агент пространства (FastAPI): чаты, проекты, память, скилы, инструменты GitHub/GitLab, подтверждения. В кластере (`DECK_MODE=space`) к моделям и Git ходит только через keyguard (`KEYGUARD_URL`) |

Архитектура — `../docs/ARCHITECTURE-v2.md`, инфраструктура кластера — `../fugu-deck-infra/`.

## Запуск и тесты

```bash
cd backend && pip install -r requirements-dev.txt && python -m pytest -q
APP_PASSWORD=dev COOKIE_SECURE=false SAKANA_API_KEY=... GITHUB_TOKEN=... uvicorn app.main:app --reload   # локально

cd mobile && npm ci && npm test && npm run typecheck     # Node 22; перекрёстные тесты с keyguard: KGCHECK=<cmd/kgcheck>
npx expo start            # Expo Go: программные ключи
npx expo run:android      # dev-сборка с ключами в чипе (модуль fd-secure)
```

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

## Открыто

У `backend` остался режим `DECK_MODE=standalone` (один сервер, пароль владельца, ключи из `.env`) — на нём сейчас
работает приложение и идут его интеграционные тесты (`mobile/tests/integration.ts`), потому что control-plane v2 ещё не
написан. Когда вход в кластер заработает целиком, режим и связанный с ним код входа (`auth.py`) можно убрать.
