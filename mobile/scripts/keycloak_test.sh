#!/usr/bin/env bash
# Тесты входа в кластер на НАСТОЯЩЕМ Keycloak (в `npm test` без KC_URL они пропускаются):
#   вход кодом приложения с PKCE и DPoP, атаки на выдачу токена, регистрация устройства в keyguard → подтверждение
#   администратором → ввод ключа API (обработчики keyguard — через cmd/kgcheck).
# Поднимает одноразовый Keycloak в контейнере (порт только на 127.0.0.1), настраивает realm deck как в кластере
# (docs/keycloak-test-realm.sh), собирает kgcheck и запускает tests/cluster.test.ts. Нужны docker, go, node 22, jq.
#   scripts/keycloak_test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
KC_IMAGE="${KC_IMAGE:-quay.io/keycloak/keycloak:26.7.5}"      # = версия Keycloak в fugu-deck-infra
NAME="deck-kc-test-$$"; WORK=$(mktemp -d)
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

echo "== Keycloak ($KC_IMAGE)"
docker run -d --name "$NAME" -p 127.0.0.1::8080 -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin-pass \
  "$KC_IMAGE" start-dev --features=dpop >/dev/null
PORT=$(docker port "$NAME" 8080/tcp | head -1 | sed 's/.*://')
export KC="http://127.0.0.1:$PORT"
for _ in $(seq 120); do curl -fsS -o /dev/null "$KC/realms/master" 2>/dev/null && break; sleep 2; done
curl -fsS -o /dev/null "$KC/realms/master" || { docker logs --tail 30 "$NAME"; echo "Keycloak не поднялся" >&2; exit 1; }
bash docs/keycloak-test-realm.sh

echo "== kgcheck (обработчики keyguard)"
(cd ../../fugu-deck-keyguard && go build -o "$WORK/kgcheck" ./cmd/kgcheck)

KC_URL="$KC" KGCHECK="$WORK/kgcheck" node --import tsx --test tests/cluster.test.ts
