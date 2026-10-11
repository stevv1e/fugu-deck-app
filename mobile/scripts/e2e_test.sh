#!/usr/bin/env bash
# Сквозной тест логики приложения против НАСТОЯЩИХ Keycloak, keyguard и control-plane (tests/e2e.cluster.test.ts):
#   приглашение → вызов для аттестации → вход (PKCE + DPoP) → регистрация → сертификат → mTLS на api → ввод ключа API,
#   плюс то, на чём приложение ломалось на телефоне: использованное приглашение, второе устройство, статус без
#   приглашения, вход на api без сертификата.
# Что настоящее: realm deck из манифестов с модулем deck-invite, сервис control-plane, обработчики keyguard, код
# приложения (src/core). Что подменено: экран passkey в браузере (вход паролем), Traefik (его роль — mTLS и заголовок
# с сертификатом — играет сам тест), OpenBao и TokenReview за keyguard (их проверяет keyguard/scripts/integration_test.sh).
# Нужны docker, go, node 22, jq, curl, python3-yaml.
#   scripts/e2e_test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(cd ../.. && pwd)
DOMAIN=e2e.deck.test
KCDIR="$REPO/fugu-deck-infra/images/keycloak"
KC_IMAGE=$(sed -nE 's/^FROM (quay.io\/keycloak\/keycloak:[0-9.]+) AS build$/\1/p' "$KCDIR/Dockerfile")
NAME="deck-e2e-$$"; WORK=$(mktemp -d); PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [[ -n $p ]] && kill "$p" 2>/dev/null || true; done
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  [[ -n ${KEEP:-} ]] && echo "журналы: $WORK" || rm -rf "$WORK"
}
trap cleanup EXIT

echo "== сборка: модуль Keycloak, keyguard (kgcheck), control-plane"
docker build -q --target provider -t deck-invite-provider:e2e "$KCDIR" >/dev/null
CID=$(docker create deck-invite-provider:e2e); docker cp "$CID:/src/target/deck-invite.jar" "$WORK/deck-invite.jar" >/dev/null; docker rm "$CID" >/dev/null
chmod 644 "$WORK/deck-invite.jar"
(cd "$REPO/fugu-deck-keyguard" && go build -o "$WORK/kgcheck" ./cmd/kgcheck)
(cd "$REPO/fugu-deck-control-plane" && go build -o "$WORK/control-plane" ./cmd/control-plane)

echo "== Keycloak ($KC_IMAGE): издатель https://id.$DOMAIN, как в кластере"
docker run -d --name "$NAME" -p 127.0.0.1::8080 -v "$WORK/deck-invite.jar:/opt/keycloak/providers/deck-invite.jar:ro" \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin-pass \
  "$KC_IMAGE" start-dev --features=dpop,passkeys --hostname="https://id.$DOMAIN" --hostname-backchannel-dynamic=true \
  --proxy-headers=xforwarded --http-enabled=true >/dev/null
KCPORT=$(docker port "$NAME" 8080/tcp | head -1 | sed 's/.*://'); KC="http://127.0.0.1:$KCPORT"
for _ in $(seq 150); do curl -fsS -o /dev/null "$KC/realms/master" 2>/dev/null && break; sleep 2; done
curl -fsS -o /dev/null "$KC/realms/master" || { docker logs --tail 40 "$NAME"; echo "Keycloak не поднялся" >&2; exit 1; }
ADM=$(curl -fsS -d client_id=admin-cli -d username=admin -d password=admin-pass -d grant_type=password \
  "$KC/realms/master/protocol/openid-connect/token" | jq -r .access_token)
api() { curl -fsS -H "Authorization: Bearer $ADM" -H "Content-Type: application/json" "$@"; }
SECRET=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
python3 - "$REPO/fugu-deck-infra/kubernetes/platform/keycloak/realms.yaml" "$SECRET" "id.$DOMAIN" > "$WORK/realm.json" <<'PY'
import json, sys, yaml
doc = next(d for d in yaml.safe_load_all(open(sys.argv[1])) if d["metadata"]["name"] == "deck")
realm = json.loads(json.dumps(doc["spec"]["realm"]).replace("${CP_CLIENT_SECRET}", sys.argv[2]))
realm["webAuthnPolicyPasswordlessRpId"] = sys.argv[3]
print(json.dumps(realm))
PY
api -X POST "$KC/admin/realms" -d @"$WORK/realm.json"
# Единственная подмена в realm: вместо экрана passkey — вход паролем (passkey без браузера и чипа не пройти).
api -X PUT "$KC/admin/realms/deck" -d '{"browserFlow":"browser"}'

echo "== keyguard (боевые обработчики) и control-plane (боевой сервис)"
KG_ISSUER="https://id.$DOMAIN/realms/deck" KG_JWKS="$KC/realms/deck/protocol/openid-connect/certs" \
  KG_ENROLL_URL="https://join.$DOMAIN/v1/enroll" KG_ADMIN=anna "$WORK/kgcheck" serve > "$WORK/kg.out" 2> "$WORK/kg.log" &
PIDS+=($!)
for _ in $(seq 50); do [[ -s $WORK/kg.out ]] && break; sleep 0.2; done
KG=$(head -1 "$WORK/kg.out"); [[ -n $KG ]] || { cat "$WORK/kg.log"; echo "keyguard не поднялся" >&2; exit 1; }
jq -r .token <<<"$KG" > "$WORK/kg-token"; jq -r .ca_pem <<<"$KG" > "$WORK/device-ca.pem"
port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
P_PUB=$(port); P_AUTH=$(port); P_ADMIN=$(port)
DECK_DOMAIN="$DOMAIN" DECK_STATE=memory DECK_HPKE_PUBLIC="$(jq -r .hpke_pub <<<"$KG")" \
  DECK_KEYGUARD_URL="$(jq -r .addr <<<"$KG")" DECK_KEYGUARD_TOKEN_PATH="$WORK/kg-token" \
  DECK_KEYCLOAK_URL="$KC" KEYCLOAK_CLIENT_SECRET="$SECRET" \
  DECK_LISTEN="127.0.0.1:$P_PUB" DECK_LISTEN_AUTH="127.0.0.1:$P_AUTH" DECK_LISTEN_ADMIN="127.0.0.1:$P_ADMIN" \
  "$WORK/control-plane" > "$WORK/cp.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 50); do curl -fsS -o /dev/null "http://127.0.0.1:$P_PUB/healthz" 2>/dev/null && break; sleep 0.2; done
curl -fsS -o /dev/null "http://127.0.0.1:$P_PUB/healthz" || { cat "$WORK/cp.log"; echo "control-plane не поднялся" >&2; exit 1; }

echo "== приложение (src/core) против стенда"
set +e
E2E_DOMAIN="$DOMAIN" E2E_KC="$KC" E2E_KC_ADMIN_TOKEN="$ADM" E2E_CP="http://127.0.0.1:$P_PUB" E2E_CP_ADMIN="http://127.0.0.1:$P_ADMIN" \
  E2E_DEVICE_CA="$WORK/device-ca.pem" node --import tsx --test tests/e2e.cluster.test.ts
RC=$?
set -e
if [[ $RC != 0 ]]; then echo "--- control-plane"; tail -15 "$WORK/cp.log"; echo "--- keyguard"; tail -15 "$WORK/kg.log"; fi
exit $RC
