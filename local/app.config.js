// Версия — как у Fugu Deck: сборка передаёт DECK_VERSION и DECK_COMMIT (см. mobile/app.config.js).
module.exports = ({ config }) => {
  const version = /^\d+\.\d+\.\d+$/.test(process.env.DECK_VERSION ?? "") ? process.env.DECK_VERSION : config.version;
  return { ...config, version, extra: { ...config.extra, commit: (process.env.DECK_COMMIT ?? "").slice(0, 7) } };
};
