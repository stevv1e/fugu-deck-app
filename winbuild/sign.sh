#!/bin/sh
# Подпись Authenticode одного файла на месте: tauri вызывает её для приложения и установщика (bundle.windows.signCommand).
# Ключ и сертификат монтируются в /sign (только чтение) и в образ не попадают.
set -eu
f=$1
osslsigncode sign -certs /sign/codesign.crt -key /sign/codesign.key \
  -n "${DECK_SIGN_NAME:-Fugu Deck}" -i https://github.com/stevv1e/fugu-deck -h sha256 \
  ${DECK_SIGN_TS:+-ts "$DECK_SIGN_TS"} -in "$f" -out "$f.signed" >/dev/null
mv "$f.signed" "$f"
osslsigncode verify -CAfile /sign/codesign.crt -in "$f" >/dev/null
echo "подписан: $(basename "$f")"
