// Версия приложения не ведётся руками: сборка (workflow mobile-android) передаёт версию сервисов Fugu Deck, вместе
// с которой собран этот APK, и коммит. Без переменных (локальный запуск) остаётся версия из app.json.
//   DECK_VERSION — "0.3.7": попадает в versionName Android / CFBundleShortVersionString iOS; из неё растёт Android versionCode;
//   DECK_COMMIT  — короткий хеш коммита: виден на экране настроек.
// На экране версия показывается как «alpha-<версия>» (src/core/version.ts): до выпуска это тестовые сборки.
module.exports = ({ config }) => {
  const version = /^\d+\.\d+\.\d+$/.test(process.env.DECK_VERSION ?? "") ? process.env.DECK_VERSION : config.version;
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  const versionCode = major * 1000000 + minor * 1000 + patch;
  return { ...config, version, android: { ...config.android, versionCode }, extra: { ...config.extra, commit: (process.env.DECK_COMMIT ?? "").slice(0, 7) } };
};
