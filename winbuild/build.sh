#!/usr/bin/env bash
# Установщик Windows на Linux-сервере: веб-сборка Expo, кросс-компиляция Rust в контейнере deck-wbuild, подпись.
#   build.sh deck|local <куда положить .exe>
# Переменные: NODE_BIN — каталог с node/npx (если их нет в PATH); DECK_VERSION — версия (по умолчанию из манифеста
# кластера test для deck и из tauri.conf.json для local); DECK_SIGN_DIR — каталог с codesign.key и codesign.crt
# (по умолчанию ~/.deck/winsign; без него установщик не подписывается); WB_MEM, WB_CPUS — потолки контейнера.
#
# Память: у сервера 8 ГБ без подкачки, поэтому Rust собирается в одну задачу (CARGO_BUILD_JOBS=1), с thin LTO,
# а контейнер ограничен WB_MEM (по умолчанию 3 ГБ, без подкачки) — при нехватке ядро убивает сборку, а не сервер.
set -euo pipefail
APP=${1:?deck|local}; OUT=${2:?куда положить .exe}
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd); APPDIR=$ROOT/fugu-deck-app
[ -n "${NODE_BIN:-}" ] && export PATH=$NODE_BIN:$PATH
case $APP in
  deck)  WEB=$APPDIR/mobile; TAURI=fugu-deck-app/desktop
         V=${DECK_VERSION:-$(sed -nE 's/.*deck-control-plane, newTag: "([0-9]+\.[0-9]+\.[0-9]+)".*/\1/p' \
           "$ROOT/fugu-deck-infra/kubernetes/clusters/test/deck-services/kustomization.yaml")} ;;
  local) WEB=$APPDIR/local; TAURI=fugu-deck-app/local/desktop
         V=${DECK_VERSION:-$(sed -nE 's/.*"version": "([^"]+)".*/\1/p' "$WEB/desktop/src-tauri/tauri.conf.json")} ;;
  *) echo "неизвестное приложение: $APP" >&2; exit 2 ;;
esac
export DECK_VERSION=$V DECK_COMMIT=$(git -C "$ROOT" rev-parse --short=7 HEAD)
echo "== $APP $V ($DECK_COMMIT), $(date -u +%H:%M:%S)"

cd "$WEB"
npm ci --no-audit --no-fund >/dev/null
rm -rf dist
nice -n 15 npx expo export --platform web --output-dir dist >/dev/null
echo "== веб-сборка готова, $(date -u +%H:%M:%S)"

docker image inspect deck-wbuild:1 >/dev/null 2>&1 || docker build -q -t deck-wbuild:1 "$HERE" >/dev/null
SIGN=${DECK_SIGN_DIR:-$HOME/.deck/winsign}
CONF="{\"version\":\"$V\"}"; MOUNT=()
if [ -r "$SIGN/codesign.key" ]; then
  CONF="{\"version\":\"$V\",\"bundle\":{\"windows\":{\"signCommand\":\"deck-sign %1\"}}}"
  MOUNT=(-v "$SIGN:/sign:ro")
else
  echo "!! нет $SIGN/codesign.key — установщик не будет подписан"
fi
docker run --rm --memory "${WB_MEM:-3g}" --memory-swap "${WB_MEM:-3g}" --cpus "${WB_CPUS:-1.5}" --cpu-shares 256 \
  --pids-limit 1024 --security-opt no-new-privileges \
  -v "$ROOT:/src" -v deck-wbuild-cache:/cache "${MOUNT[@]}" \
  -e CARGO_TARGET_DIR=/cache/target-$APP -e CARGO_PROFILE_RELEASE_LTO=thin -e CARGO_PROFILE_RELEASE_CODEGEN_UNITS=4 \
  -e DECK_SIGN_TS="${DECK_SIGN_TS-http://timestamp.digicert.com}" \
  -w "/src/$TAURI" deck-wbuild:1 \
  sh -c "B=/cache/target-$APP/x86_64-pc-windows-msvc/release/bundle/nsis; rm -rf \$B \
    && cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis --ci --config '$CONF' \
    && cp \"\$B\"/*_${V}_x64-setup.exe /src/.winbuild-out.exe"
mkdir -p "$(dirname "$OUT")"
mv "$ROOT/.winbuild-out.exe" "$OUT"
echo "== готово: $OUT ($(du -h "$OUT" | cut -f1)), $(date -u +%H:%M:%S)"
sha256sum "$OUT"
