# Fugu Deck

> **Два режима работы**
> - **Одиночный сервер** (docker compose): один владелец, ключи в `.env`. Описан ниже.
> - **Кластер для команды** (k3s + Argo CD): вход по passkey, личные и общие приватные пространства,
>   ключи Claude и Sakana хранятся только на телефонах, правило 72 часов. Установка: [`infra/README.md`](infra/README.md).

Мобильное приложение-агент: пишете задачу с телефона, **Sakana Fugu** работает с вашими репозиториями
на **GitHub и GitLab**. Он создаёт репозитории, читает код, коммитит, открывает PR/MR и проверяет CI.
Каждое изменяющее действие вы подтверждаете кнопкой в приложении.

```
 Телефон (PWA)  ──HTTPS──▶  Caddy  ──▶  API-агент (FastAPI)  ──▶  Sakana Fugu API
                                              │
                                              ├──▶  GitHub REST API
                                              └──▶  GitLab REST API
```

## Возможности

| | |
|---|---|
| Чат с Fugu | стриминг ответа, выбор модели (Max / Ultra), история чатов |
| Репозитории | список, создание, ветки, чтение файлов, коммит нескольких файлов сразу, PR/MR, статус CI |
| Файлы с телефона | прикрепляете файл: текст попадает в контекст, картинки идут как изображения, любые файлы можно закоммитить |
| Подтверждения | карточка с diff-превью: **WRITE** (жёлтая) или **DANGER** (розовая: основная ветка, удаление, новый репозиторий) |
| Устойчивость к мобильной сети | агент работает на сервере; если экран погас или сеть моргнула, приложение переподключается и продолжает с того же места |
| Расходы | стоимость каждого запроса, итог за день и месяц |
| Журнал | все действия агента с отметкой, подтверждены они или нет |
| Безопасность | пароль + 2FA (TOTP), httpOnly-cookie, защита от перебора, токены только на сервере |
| **Проекты** | у каждого проекта свои чаты, инструкции для агента, набор скилов, память и участники |
| **Память** | агент сам сохраняет решения и факты (`memory_save`), ищет по ним (`memory_search`, полнотекстовый поиск); вы смотрите и правите всё в разделе «Память», можете закреплять записи |
| **Память между проектами** | проекту можно дать доступ к памяти других проектов — **только на чтение** |
| **Скилы** | инструкции в отдельной папке `skills/<имя>/SKILL.md`; агент видит список и загружает нужный; включаются по проектам; папку можно вести в git |
| **Реальное время** | все устройства и люди видят новые сообщения, работу агента, изменения памяти и скилов сразу; видно, кто сейчас в проекте и в каком чате |
| **Параллельные агенты** | несколько чатов проекта работают одновременно и на каждом шаге видят свежую память друг друга |
| **Команда** | владелец создаёт пользователей; роли в проекте: читатель / редактор / владелец |
| **10 тем оформления** | Neon Grid, Matrix, Synthwave, Neo Noir, Abyss, Amber CRT, Toxic, Sakura, Mono, Ice |

## Проекты, память, скилы — как это устроено

```
Проект «Shop»                         Проект «Infra»
 ├─ инструкции                         ├─ инструкции
 ├─ скилы: conventional-commits        ├─ скилы: все
 ├─ память ◀──── только чтение ─────── ├─ память
 └─ чаты (агенты работают параллельно)  └─ чаты
```

- В начале каждого шага агент получает инструкции проекта, список включённых скилов и снимок памяти
  (закреплённые записи и свежие, до ~6 000 символов). Остальное он ищет сам через `memory_search`.
- Скил — это папка с `SKILL.md`:
  ```markdown
  ---
  name: deploy-checklist
  description: Чеклист деплоя. Используй перед любым выкатом в прод.
  ---
  1. Бэкап БД …
  ```
  Рядом можно положить дополнительные файлы (шаблоны, примеры), агент прочитает их через `read_skill_file`.
- **Скилы через GitOps:** держите их в отдельном репозитории, смонтируйте папку в контейнер
  (`./skills:/skills:ro` в `docker-compose.yml`) и укажите `SKILLS_DIR=/skills`. После `git pull` скилы обновятся сразу, перезапуск не нужен.

## Команда и роли

| Роль | Что может |
|---|---|
| владелец сервера (`OWNER_USERNAME`) | всё: пользователи, скилы, все проекты, журнал |
| владелец проекта | участники, доступ к памяти других проектов, удаление проекта |
| редактор | запускать агента, подтверждать действия, редактировать память и инструкции |
| читатель | видеть чаты, работу агента и память в реальном времени |

Важно: git-токены общие для сервера. Агент, запущенный любым редактором, действует от имени этих токенов,
поэтому давайте роль «редактор» только тем, кому доверяете доступ к репозиториям.

## Структура

```
control-plane/      кластер: passkey-вход, пространства, приглашения, пропуска, оператор, правило 72 ч
  cp/orchestrator/    создание пространств (local — процессы, kubernetes — namespace + ресурсы)
  tests/e2e_three_users.py  сценарий «Анна, Боб, Вика»
infra/              GitOps-репозиторий кластера (Argo CD, cert-manager, egress-прокси, control-plane)
backend/            FastAPI-агент (он же «пространство» в кластере)
  app/llm/            провайдеры: Claude (Anthropic) и Sakana; задел под OpenAI/Grok
  app/keyvault.py     ключи пользователей — только в оперативной памяти
  app/agent.py        цикл «модель → инструменты → подтверждение»
  app/tools/          инструменты; новые добавляются декоратором @tool
  app/tools/providers.py  клиенты GitHub/GitLab
  app/tools/memory_tools.py, skill_tools.py  память и скилы
  app/events.py       шина событий реального времени (SSE) и присутствие
  app/skills.py       хранилище скилов (папка SKILL.md)
  tests/              unit-тесты + мок Sakana/GitHub для e2e-проверки
frontend/           PWA (React + Vite), Caddyfile, Dockerfile
deploy/             docker-compose.yml, .env.example
.github/workflows/  CI/CD для GitHub (GHCR)
.gitlab-ci.yml      CI/CD для GitLab (Container Registry)
```

---

## Установка

### 1. Сервер

Подойдёт VPS с **1–2 vCPU, 1–2 ГБ RAM, 20 ГБ SSD**, Ubuntu 22.04/24.04.
**Расположение: вне ЕС, Великобритании и Швейцарии**, так как Sakana там не работает.

```bash
# Docker
curl -fsSL https://get.docker.com | sh
# пользователь для деплоя
sudo useradd -m -s /bin/bash -G docker deploy
sudo mkdir -p /opt/fugu-deck && sudo chown deploy /opt/fugu-deck
# фаервол
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw allow 443/udp && sudo ufw enable
```

Направьте домен (A-запись) на IP сервера, например `deck.example.com`. HTTPS-сертификат Caddy получит сам.

### 2. Токены

- **Sakana:** console.sakana.ai → API Keys.
- **GitHub:** Settings → Developer settings → **Fine-grained tokens**. Выберите нужные репозитории (или All).
  Нужны права Contents: RW, Pull requests: RW, Metadata: R, Actions: R.
  Administration: RW нужно, только если агент будет создавать репозитории.
- **GitLab:** Preferences → Access tokens, scope `api`. Для self-hosted GitLab укажите `GITLAB_URL`.

Можно подключить что-то одно: второй провайдер просто не появится.

### 3. Конфигурация на сервере

```bash
cd /opt/fugu-deck
# скопируйте сюда deploy/docker-compose.yml и deploy/.env.example → .env
nano .env          # заполните DOMAIN, SAKANA_API_KEY, APP_PASSWORD, токены
chmod 600 .env
```

2FA (рекомендую):
```bash
python3 -c "import secrets,base64;print(base64.b32encode(secrets.token_bytes(20)).decode())"
```
Полученную строку запишите в `TOTP_SECRET` и добавьте в Google Authenticator / Aegis («ввести ключ вручную»).

### 4. CI/CD (GitOps-путь)

Весь деплой описан в репозитории. Push в `main` запускает цепочку: тесты → сборка образов → registry → сервер делает `pull` и `up -d`.

**GitHub** → Settings → Secrets and variables → Actions:

| Secret | Значение |
|---|---|
| `DEPLOY_HOST` | IP или домен сервера |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | приватный ключ (ed25519), публичный добавьте в `~deploy/.ssh/authorized_keys` |
| `DEPLOY_KNOWN_HOSTS` | вывод `ssh-keyscan <сервер>` |

Образы в GHCR по умолчанию приватные, поэтому один раз на сервере выполните:
`docker login ghcr.io -u <логин>` с PAT, у которого есть право `read:packages`.

**GitLab**: те же переменные в Settings → CI/CD → Variables. Деплой там ручной (кнопка ▶), это настраивается в `.gitlab-ci.yml`.

Если не хотите возиться с CI для первого запуска, можно собрать всё прямо на сервере:
```bash
git clone <ваш-репозиторий> src && cd src/deploy && cp /opt/fugu-deck/.env .
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

### 5. Телефон

Откройте `https://ваш-домен` и войдите.
- **iPhone (Safari):** «Поделиться» → «На экран Домой».
- **Android (Chrome):** меню ⋮ → «Установить приложение».

Приложение откроется без адресной строки, как обычное.

---

## Локальная разработка

```bash
# backend
cd backend && pip install -r requirements-dev.txt
APP_PASSWORD=dev COOKIE_SECURE=false SAKANA_API_KEY=... GITHUB_TOKEN=... uvicorn app.main:app --reload
# frontend (проксирует /api на :8000)
cd frontend && npm install && npm run dev
```

Проверка без реальных ключей, на моках:
```bash
cd backend
uvicorn tests.mock_server:app --port 9100 &
SAKANA_API_KEY=x SAKANA_BASE_URL=http://127.0.0.1:9100/v1 GITHUB_TOKEN=x \
  GITHUB_API_URL=http://127.0.0.1:9100/gh APP_PASSWORD=test-pass COOKIE_SECURE=false \
  uvicorn app.main:app --port 8000 &
python tests/e2e_check.py   # репозитории, подтверждения, переподключение
python tests/e2e_v2.py      # проекты, пользователи, память, скилы, realtime
pytest -q
```

## Кластер локально (без Kubernetes)

Control-plane умеет запускать пространства обычными процессами — удобно для разработки:
```bash
cd frontend && npm run build
cd ../control-plane && pip install -r requirements.txt
CP_BOOTSTRAP_CODE=BOOT-1 CP_COOKIE_SECURE=false CP_STATIC_DIR=../frontend/dist \
  CP_ORCHESTRATOR=local CP_SPACE_BACKEND_DIR=../backend uvicorn cp.main:app --port 8080
# откройте http://localhost:8080 → код BOOT-1 → ник → passkey
```
Тест на моках (три пользователя, два провайдера, приглашения, отзыв доступа, 72 ч):
```bash
uvicorn tests.mock_server:app --port 9100 --app-dir ../backend &
CP_TEST_MODE=true CP_ORCHESTRATOR=local CP_COOKIE_SECURE=false CP_DATA_DIR=/tmp/cp-e2e CP_SPACE_BACKEND_DIR=../backend \
  CP_LOCAL_SPACE_ENV="SAKANA_BASE_URL=http://127.0.0.1:9100/v1;ANTHROPIC_BASE_URL=http://127.0.0.1:9100/anthropic" \
  uvicorn cp.main:app --port 8080 &
CP_DATA_DIR=/tmp/cp-e2e python tests/e2e_three_users.py
```

## Как добавить инструмент (задел под следующий этап: SSH и серверы)

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

## Важно знать

- **API работает в одном процессе** (1 воркер). Активные запуски и ожидающие подтверждения хранятся в памяти.
  При перезапуске контейнера текущий запуск прервётся, а история чатов сохранится в SQLite (`api-data` volume).
- **Бэкап:** достаточно копировать volume `fugu-deck_api-data`.
- Fugu Ultra может думать несколько минут, поэтому таймауты рассчитаны на долгие ответы (до 15 минут).
- Если Sakana изменит имена моделей, поменяйте `MODELS` и `PRICING_JSON` в `.env`, код трогать не нужно.

## Мобильное приложение

`mobile/` — React Native + Expo. Пользователь сам добавляет сервер: QR-приглашение или адрес со сверкой отпечатка ключа сервера.
Вход по ключу устройства (DPoP), подтверждения агента подписываются ключом с биометрией, отзыв устройств, mTLS.
Подробно — [mobile/README.md](mobile/README.md), архитектура — `docs/ARCHITECTURE-v2.md`, раздел 3.6.

```bash
cd mobile && npm install && npm test && npm run typecheck
npx expo start            # Expo Go: программные ключи
npx expo run:android      # dev-сборка с ключами в чипе (модуль fd-secure)
```

