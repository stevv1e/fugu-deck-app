# Fugu Local

Второе приложение Fugu Deck — **без сервера**. Сообщения и ключ уходят с устройства прямо провайдеру модели
(Sakana, Claude, DeepSeek, OpenAI); история чатов хранится только на устройстве.

| | Fugu Deck (`../mobile`) | Fugu Local (этот каталог) |
|---|---|---|
| куда идут запросы | сервер Fugu Deck → keyguard → провайдер | устройство → провайдер |
| ключи моделей | в кластере (keyguard), вводятся подписанным действием | на телефоне: Android Keystore |
| агент, серверы, Git, база знаний, общие пространства | есть | нет — только чат с моделью |
| Android-пакет | `kz.fugudeck.app` | `kz.fugudeck.local` |

Приложения не мешают друг другу: на один телефон ставятся оба.

## Устройство

- `src/core/providers.ts` — адреса, заголовки, тела запросов, разбор потоков SSE (OpenAI-совместимый и Anthropic);
- `src/core/chat.ts` — один ответ модели; сеть передаётся параметром (тесты — `tests/providers.test.ts`);
- `src/platform/net.ts` — потоковый POST через `expo/fetch`;
- `src/platform/secrets.ts` — ключи в `expo-secure-store`;
- `src/state/store.ts` — чаты и настройки (AsyncStorage).

## Проверка

```
npm ci
npx tsc --noEmit && npm test && npx expo lint
```

## Android

Как у Fugu Deck, только из этого каталога: `npx expo prebuild --platform android` и `./gradlew assembleRelease`
(на VPS — `~/.deck/android/build-apk-local.sh`). Версия берётся из `DECK_VERSION`.
