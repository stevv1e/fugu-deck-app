# Сборщик установщиков Windows (Fugu Deck и Fugu Local) на Linux: кросс-компиляция под MSVC (cargo-xwin), NSIS,
# подпись Authenticode (osslsigncode). Утилиты — готовые бинарники с закреплёнными хешами: компилировать их
# из исходников (cargo install) на сервере с 8 ГБ слишком тяжело.
# Debian trixie: tauri нужен NSIS ≥ 3.09 (в bookworm 3.08 без Win\RestartManager.nsh).
FROM rust:1.99-trixie
RUN apt-get update \
 && apt-get install -y --no-install-recommends clang lld llvm nsis osslsigncode \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf clang /usr/bin/clang-cl \
 && rustup target add x86_64-pc-windows-msvc
ARG XWIN=0.23.1
ARG XWIN_SHA=c492c6dfb7e5ac0eee586b796e0fc950ba13077e7f0bbb046f445d71790d5360
ARG TAURI=2.12.2
ARG TAURI_SHA=35c7b50266256cb6d5f757608d7097a59a5faeb0c75879ee1f504652a9b6087e
RUN set -e; cd /tmp \
 && curl -fsSLo xwin.tgz https://github.com/rust-cross/cargo-xwin/releases/download/v$XWIN/cargo-xwin-v$XWIN.x86_64-unknown-linux-musl.tar.gz \
 && echo "$XWIN_SHA  xwin.tgz" | sha256sum -c - \
 && curl -fsSLo tauri.tgz https://github.com/tauri-apps/tauri/releases/download/tauri-cli-v$TAURI/cargo-tauri-x86_64-unknown-linux-gnu.tgz \
 && echo "$TAURI_SHA  tauri.tgz" | sha256sum -c - \
 && tar xzf xwin.tgz -C /usr/local/cargo/bin cargo-xwin \
 && tar xzf tauri.tgz -C /usr/local/cargo/bin cargo-tauri \
 && rm -f xwin.tgz tauri.tgz \
 && cargo xwin --version && cargo tauri --version
COPY sign.sh /usr/local/bin/deck-sign
ENV XWIN_ACCEPT_LICENSE=1 XWIN_CACHE_DIR=/cache/xwin CARGO_HOME=/cache/cargo CARGO_BUILD_JOBS=1
WORKDIR /src
