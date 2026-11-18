import { EMPTY_MODEL_PREFS, type ModelPreferences } from "@/core/models";
import { prefs } from "@/platform/storage";

const KEY = "fd:model-preferences";

export async function loadModelPreferences(): Promise<ModelPreferences> {
  const saved = await prefs.get<Partial<ModelPreferences>>(KEY, {});
  return {
    favorites: Array.isArray(saved.favorites) ? saved.favorites : [],
    recent: Array.isArray(saved.recent) ? saved.recent : [],
    roles: { ...EMPTY_MODEL_PREFS.roles, ...(saved.roles || {}) },
    fallbacks: Array.isArray(saved.fallbacks) ? saved.fallbacks : [],
  };
}

export async function saveModelPreferences(value: ModelPreferences): Promise<void> {
  await prefs.set(KEY, value);
}
