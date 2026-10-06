#!/usr/bin/env bash
# realm deck как в кластере (kubernetes/platform/keycloak): deck-app публичный, PKCE S256, DPoP обязателен, редирект только в приложение
KC=${KC:-http://127.0.0.1:8081}
ADM=$(curl -s -d client_id=admin-cli -d username=admin -d password=admin-pass -d grant_type=password $KC/realms/master/protocol/openid-connect/token | jq -r .access_token)
H=(-H "Authorization: Bearer $ADM" -H "Content-Type: application/json")
curl -s -o /dev/null -w "realm %{http_code}\n" "${H[@]}" -X POST $KC/admin/realms -d '{"realm":"deck","enabled":true}'
curl -s -o /dev/null -w "client %{http_code}\n" "${H[@]}" -X POST $KC/admin/realms/deck/clients -d '{
 "clientId":"deck-app","publicClient":true,"standardFlowEnabled":true,"directAccessGrantsEnabled":false,"implicitFlowEnabled":false,
 "serviceAccountsEnabled":false,"redirectUris":["fugudeck://oauth"],"webOrigins":[],
 "attributes":{"pkce.code.challenge.method":"S256","dpop.bound.access.tokens":"true"}}'
for u in anna admin; do
curl -s -o /dev/null -w "user $u %{http_code}\n" "${H[@]}" -X POST $KC/admin/realms/deck/users -d "{\"username\":\"$u\",\"enabled\":true,\"email\":\"$u@deck.test\",\"emailVerified\":true,\"firstName\":\"$u\",\"lastName\":\"T\",\"credentials\":[{\"type\":\"password\",\"value\":\"$u-pass\",\"temporary\":false}]}"
done
curl -s "${H[@]}" "$KC/admin/realms/deck/clients?clientId=deck-app" | jq -c '.[0] | {clientId, publicClient, directAccessGrantsEnabled, pkce: .attributes["pkce.code.challenge.method"], dpop: .attributes["dpop.bound.access.tokens"]}'
echo "password grant (должен быть запрещён):"; curl -s -d client_id=deck-app -d username=anna -d password=anna-pass -d grant_type=password $KC/realms/deck/protocol/openid-connect/token | jq -c .
