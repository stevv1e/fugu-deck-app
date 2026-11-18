export type ModelRole = "code" | "review" | "summary";
export type ScenarioModels = Record<ModelRole, string>;
export type ModelPreferences = {
  favorites: string[];
  recent: string[];
  roles: ScenarioModels;
  fallbacks: string[];
};

export const EMPTY_MODEL_PREFS: ModelPreferences = {
  favorites: [], recent: [], roles: { code: "", review: "", summary: "" }, fallbacks: [],
};

export function providerOf(model: string): string {
  return model.includes(":") ? model.split(":", 1)[0] : "sakana";
}

export function nameOfModel(model: string): string {
  return model.includes(":") ? model.slice(model.indexOf(":") + 1) : model;
}

export function rememberModel(value: ModelPreferences, model: string): ModelPreferences {
  return { ...value, recent: [model, ...value.recent.filter((x) => x !== model)].slice(0, 8) };
}

export function toggleFavorite(value: ModelPreferences, model: string): ModelPreferences {
  const exists = value.favorites.includes(model);
  return { ...value, favorites: exists ? value.favorites.filter((x) => x !== model) : [...value.favorites, model] };
}

export function visibleModels(models: string[], query: string): string[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return models.filter((model) => {
    const haystack = `${providerOf(model)} ${nameOfModel(model)} ${model}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function fallbackChain(preferences: ModelPreferences): string[] {
  return preferences.fallbacks.filter((x, i, all) => x && all.indexOf(x) === i).slice(0, 3);
}

export function resolveScenario(preferences: ModelPreferences, primary: string, models: string[], ready: string[]): ScenarioModels {
  const available = models.filter((model) => ready.includes(providerOf(model)));
  const usable = available.length ? available : [primary];
  const valid = (value: string) => usable.includes(value) ? value : "";
  const other = usable.find((model) => model !== primary) || primary;
  return {
    code: valid(preferences.roles.code) || primary,
    review: valid(preferences.roles.review) || other,
    summary: valid(preferences.roles.summary) || other,
  };
}
