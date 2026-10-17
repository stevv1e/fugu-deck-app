# Fugu Local

Второе приложение Fugu Deck — **без сервера**. Сообщения и ключ уходят с устройства прямо провайдеру модели
(Sakana, Claude, DeepSeek, OpenAI); история чатов хранится только на устройстве.

| | Fugu Deck (`../mobile`, `../desktop`) | Fugu Local (этот каталог) |
|---|---|---|
| куда идут запросы | сервер Fugu Deck → keyguard → провайдер | устройство → провайдер |
| ключи моделей | в кластере (keyguard), вводятся подписанным действием | на устройстве: Android Keystore / диспетчер учётных данных Windows |
| агент, серверы, Git, база знаний, общие пространства | есть | нет — только чат с моделью |
| Android-пакет / Windows identifier | `kz.fugudeck.app` / `kz.fugudeck.desktop` | `kz.fugudeck.local` |

Приложения не мешают друг другу: на одном устройстве ставятся оба.

## Устройство

- `src/core/providers.ts` — адреса, заголовки, тела запросов, разбор потоков SSE (OpenAI-совместимый и Anthropic);
- `src/core/chat.ts` — один ответ модели; сеть передаётся параметром (тесты — `tests/providers.test.ts`);
- `src/platform/net.ts` — потоковый POST: `expo/fetch` на телефоне, `@tauri-apps/plugin-http` в Windows;
- `src/platform/secrets.ts` — ключи: `expo-secure-store` / команды Tauri `secret_get|set|del` (keyring);
- `src/state/store.ts` — чаты и настройки (AsyncStorage);
- `desktop/src-tauri` — оболочка Windows: окно WebView2 с `dist/`, плагины http (только адреса провайдеров) и opener.

## Проверка

```
npm ci
npx tsc --noEmit && npm test && npx expo lint
```

## Android

Как у Fugu Deck, только из этого каталога: `npx expo prebuild --platform android` и `./gradlew assembleRelease`
(на VPS — `~/.deck/android/build-apk-local.sh`). Версия берётся из `DECK_VERSION`.

## Windows (собирать на ПК с Windows)

Нужны: Rust (rustup, MSVC), Visual Studio Build Tools с «Разработка классических приложений на C++», Node 22, WebView2
(есть в Windows 10/11).

```
cd fugu-deck-app\local
npm ci
npx expo export --platform web --output-dir dist
cd desktop
cargo install tauri-cli --version "^2" --locked
cargo tauri build
```

Установщик — `desktop\src-tauri\target\release\bundle\nsis\Fugu Local_<версия>_x64-setup.exe`.
Для разработки: `npx expo start --web` в `local` и `cargo tauri dev` в `local\desktop`.
