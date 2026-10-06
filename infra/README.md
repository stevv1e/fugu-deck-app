# Кластер Fugu Deck (k3s + Argo CD, GitOps)

```
                        deck.<домен>  (один адрес для всех)
                                │ HTTPS (Let's Encrypt)
                  ┌─────────────┴─────────────┐
                  │  Traefik (встроен в k3s)  │
                  └──┬───────────────┬────────┘
            /  и /cp/api/*        /s/<id>/*
                     │               │
          ┌──────────┴───┐   ┌───────┴────────────────────────────┐
          │ deck-system  │   │ deck-u-…   deck-u-…   deck-t-…     │  ← пространства
          │ control-plane│──▶│ (личные)              (общие)      │    создаёт control-plane
          │ + PWA        │   │ NetworkPolicy: только Traefik и    │
          └──────────────┘   │ control-plane внутрь, наружу — DNS │
                             │ и egress-прокси                    │
                             └───────────────┬────────────────────┘
                                             ▼
                              deck-egress: tinyproxy (белый список)
                              api.anthropic.com, api.sakana.ai, GitHub, GitLab
```

## Что где лежит

| Путь | Что это |
|---|---|
| `bootstrap/root-app.yaml` | корневое приложение Argo CD (применяется один раз руками) |
| `apps/` | приложения Argo CD: cert-manager, платформа, control-plane |
| `platform/` | ClusterIssuer Let's Encrypt, egress-прокси |
| `control-plane/base` | control-plane: RBAC, диск, Deployment, маршруты, сертификат, NetworkPolicy |
| `control-plane/overlays/prod` | ваш домен, образы, настройки. **CI меняет здесь тег образа после каждой сборки** |

Пространства пользователей в git не описываются: это данные, а не конфигурация.
Их создаёт и удаляет control-plane (шаблон — `control-plane/cp/orchestrator/manifests.py`).
При каждом старте control-plane приводит все пространства к текущей версии образа.

## Установка с нуля

**0. Сервер:** 4 vCPU, 8 ГБ RAM, 80 ГБ SSD, Ubuntu 24.04, **вне ЕС/UK/CH**. A-запись домена → IP сервера.

**1. k3s**
```bash
curl -sfL https://get.k3s.io | sh -s - --secrets-encryption
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config && sudo chown $USER ~/.kube/config
sudo ufw allow 80,443/tcp && sudo ufw allow 6443/tcp from <ваш IP>
```
В k3s уже есть Traefik, local-path storage и контроллер NetworkPolicy.

**2. Argo CD**
```bash
kubectl create namespace argocd
kubectl apply -n argocd --server-side -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

**3. Подставьте свои значения** и закоммитьте:
- `YOUR_LOGIN` в `bootstrap/root-app.yaml` и `apps/*.yaml` — ваш репозиторий;
- `deck.example.kz` в `control-plane/base/ingress.yaml` и `control-plane/overlays/prod/kustomization.yaml`;
- `your_login` в образах (`ghcr.io/<логин>/…`), почту в `platform/cert-manager/cluster-issuer.yaml`.

**4. Секрет первого входа** (в git не кладём):
```bash
kubectl create namespace deck-system
kubectl -n deck-system create secret generic control-plane-secrets \
  --from-literal=CP_BOOTSTRAP_CODE="$(openssl rand -hex 8 | tee /dev/stderr)"
```
Если образы в GHCR приватные, создайте также `imagePullSecret` и укажите `CP_SPACE_IMAGE_PULL_SECRET`.

**5. Запуск GitOps**
```bash
kubectl apply -n argocd -f infra/bootstrap/root-app.yaml
```
Через пару минут Argo CD развернёт cert-manager, прокси и control-plane, а Let's Encrypt выпустит сертификат.

**6. Первый вход:** откройте `https://deck.<домен>` → код из шага 4 → ник → passkey.
Вы администратор: в «Настройки → Приглашения в сервис» создаются одноразовые коды для остальных.

## Как идёт обновление

```
git push → CI: тесты → образы space / cp → коммит «deploy: <sha>» с новым тегом в overlays/prod
        → Argo CD видит коммит → выкатывает control-plane → тот обновляет пространства
```

## Безопасность — кратко

- **Ключей API на сервере нет.** Они хранятся на телефонах, зашифрованные, и попадают в pod пространства только в RAM.
- **Пропуск в пространство** — ES256-токен на 10 минут. Пространство знает только публичный ключ control-plane.
- **Изоляция:** namespace на пространство, `restricted` Pod Security, read-only файловая система, отдельный диск и квоты,
  NetworkPolicy (внутрь — только Traefik и control-plane; наружу — только DNS и egress-прокси с белым списком).
- **Удаление участника** срабатывает сразу: control-plane отзывает его токены в пространстве, закрывает потоки и стирает ключи из памяти.
- **72 часа неактивности:** control-plane раз в час проверяет активность, на 48 ч присылает предупреждение, на 72 ч удаляет namespace целиком.
- У control-plane кластерные права на namespace. Доступ к нему и к `kubeconfig` защищайте одинаково.

## Что стоит проверить при первом запуске

- **Образ egress-прокси** (`vimagick/tinyproxy`) — сторонний. Закрепите digest или соберите свой.
  Проверьте, что он работает от непривилегированного пользователя с read-only файловой системой.
- **Метки пода Traefik** в вашей версии k3s: `kubectl -n kube-system get pods --show-labels`.
  NetworkPolicy ожидает `app.kubernetes.io/name=traefik`.
- **Проверка манифестов:** `kubeconform` (все 33 ресурса проходят, включая CRD Traefik, cert-manager и Argo CD).
