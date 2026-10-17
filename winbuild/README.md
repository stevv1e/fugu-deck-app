# Сборка приложений для Windows

Два приложения, каждое — веб-сборка Expo в окне WebView2 (Tauri 2) и установщик NSIS на пользователя (без прав
администратора):

| | исходники | веб-сборка | установщик |
|---|---|---|---|
| **Fugu Deck** (через сервер) | `fugu-deck-app/desktop` | `fugu-deck-app/mobile` → `mobile/dist` | `Fugu Deck_<версия>_x64-setup.exe` |
| **Fugu Local** (без сервера) | `fugu-deck-app/local/desktop` | `fugu-deck-app/local` → `local/dist` | `Fugu Local_<версия>_x64-setup.exe` |

## На сервере (Linux, этот каталог)

```
NODE_BIN=~/.deck/work/node/bin fugu-deck-app/winbuild/build.sh deck  out/fugu-deck-setup.exe
NODE_BIN=~/.deck/work/node/bin fugu-deck-app/winbuild/build.sh local out/fugu-local-setup.exe
```

Что происходит:

1. `npm ci` и `expo export --platform web` на хосте;
2. Rust кросс-компилируется под `x86_64-pc-windows-msvc` в контейнере `deck-wbuild` (`Dockerfile`: cargo-xwin,
   clang-cl, lld, NSIS, osslsigncode). Утилиты — готовые бинарники с хешами в `Dockerfile`, ничего не компилируется
   при сборке образа. Заголовки и библиотеки MSVC и Windows SDK cargo-xwin скачивает в том `deck-wbuild-cache`
   (там же кэш crates и `target`);
3. приложение и установщик подписываются (`sign.sh`), выводится SHA-256 установщика.

**Ресурсы.** Сборка, уронившая сервер 16.10, ставила cargo-xwin и tauri-cli через `cargo install` без ограничений.
Теперь: Rust в одну задачу (`CARGO_BUILD_JOBS=1`), thin LTO вместо полного, контейнер с потолком памяти `WB_MEM`
(3 ГБ, без подкачки) и `WB_CPUS` (1,5 ядра, низкий приоритет). При нехватке памяти ядро завершает сборку, а не
сервисы сервера. Веб-сборку запускать внутри `systemd-run --scope -p MemoryMax=4800M -p MemorySwapMax=0`.
Первая сборка — около часа, следующие быстрее (кэш в томе).

## Подпись

Ключ подписи кода — RSA 3072, сертификат самоподписанный «Fugu Deck» на 5 лет; лежит на сервере в `~/.deck/winsign`
(`codesign.key` — права 600, в git и в образ не попадает; монтируется в контейнер только для чтения). Без ключа
`build.sh` собирает неподписанный установщик и предупреждает об этом. Подпись с меткой времени (DigiCert), поэтому
остаётся действительной и после истечения сертификата.

Что это даёт и чего нет:

- **даёт** — проверку, что установщик собран нами и не изменён по дороге: Windows показывает издателя «Fugu Deck»
  и отказывается признавать подпись изменённого файла;
- **не даёт** — доверия SmartScreen «из коробки»: сертификат не выдан центром сертификации. На каждом ПК, где
  ставят приложение, один раз доверяем сертификату (ниже), иначе Windows покажет «неизвестный издатель».
  Чтобы предупреждений не было совсем, нужен платный сертификат подписи кода (OV/EV) или Azure Trusted Signing.

### Проверка на ПК перед установкой

1. Сравнить SHA-256 установщика с указанным в релизе:
   ```
   Get-FileHash '.\Fugu Local_0.7.0_x64-setup.exe' -Algorithm SHA256
   ```
2. Один раз доверить сертификату `fugu-deck-codesign.cer` из релиза. Сначала сверить его отпечаток:
   ```
   certutil -hashfile .\fugu-deck-codesign.cer SHA256
   ```
   Отпечаток должен совпасть с указанным в релизе. Затем добавить сертификат для текущего пользователя:
   ```
   Import-Certificate -FilePath .\fugu-deck-codesign.cer -CertStoreLocation Cert:\CurrentUser\Root
   Import-Certificate -FilePath .\fugu-deck-codesign.cer -CertStoreLocation Cert:\CurrentUser\TrustedPublisher
   ```
3. Проверить подпись — должно быть `Valid`, издатель `CN=Fugu Deck`:
   ```
   Get-AuthenticodeSignature '.\Fugu Local_0.7.0_x64-setup.exe' | Format-List Status,SignerCertificate
   ```

## Вручную на ПК с Windows

Нужны: Rust (rustup, toolchain MSVC), Visual Studio Build Tools с компонентом «Разработка классических приложений
на C++», Node 22, WebView2 (есть в Windows 10/11).

```
cargo install tauri-cli --version "^2" --locked

:: Fugu Deck
cd fugu-deck-app\mobile
npm ci
npx expo export --platform web --output-dir dist
cd ..\desktop
cargo tauri build

:: Fugu Local
cd fugu-deck-app\local
npm ci
npx expo export --platform web --output-dir dist
cd desktop
cargo tauri build
```

Установщик — `src-tauri\target\release\bundle\nsis\*.exe`. Собранное так не подписано (ключ только на сервере).
Для разработки: `npx expo start --web` в каталоге веб-сборки и `cargo tauri dev` в каталоге `desktop`.
