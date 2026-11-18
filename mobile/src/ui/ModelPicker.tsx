import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import {
  nameOfModel,
  providerOf,
  rememberModel,
  toggleFavorite,
  visibleModels,
  type ModelPreferences,
} from "@/core/models";
import { loadModelPreferences, saveModelPreferences } from "@/state/modelPreferences";
import { Chip, IconBtn, Row, Txt } from "@/ui/kit";
import { alpha, MONO, useTheme } from "@/ui/theme";

export function ModelPicker({ models, ready, selected, providerTitles = {}, onSelect, onClose, maxHeight = 520 }: {
  models: string[];
  ready: string[];
  selected?: string;
  providerTitles?: Record<string, string>;
  onSelect(model: string): void;
  onClose?(): void;
  maxHeight?: number;
}) {
  const { p } = useTheme();
  const [query, setQuery] = useState("");
  const [preferences, setPreferences] = useState<ModelPreferences | null>(null);
  useEffect(() => { void loadModelPreferences().then(setPreferences); }, []);
  const visible = useMemo(() => visibleModels(models, query), [models, query]);
  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const model of visible) {
      const provider = providerOf(model);
      map.set(provider, [...(map.get(provider) || []), model]);
    }
    return [...map.entries()].sort(([a], [b]) => (providerTitles[a] || a).localeCompare(providerTitles[b] || b));
  }, [visible, providerTitles]);

  const patch = async (next: ModelPreferences) => {
    setPreferences(next);
    await saveModelPreferences(next);
  };
  const choose = (model: string) => {
    if (preferences) void patch(rememberModel(preferences, model));
    onSelect(model);
  };
  const favorite = (model: string) => {
    if (preferences) void patch(toggleFavorite(preferences, model));
  };

  const modelRow = (model: string) => {
    const available = ready.includes(providerOf(model));
    const active = selected === model;
    return (
      <Row key={model} style={{ justifyContent: "space-between", alignItems: "center", gap: 6 }}>
        <Pressable onPress={() => available && choose(model)} disabled={!available} style={{ flex: 1, opacity: available ? 1 : 0.42, paddingVertical: 6 }}>
          <Txt kind="mono" numberOfLines={1} color={active ? p.accent : p.text} style={{ fontSize: 12 }}>{nameOfModel(model)}</Txt>
          <Txt kind="small" numberOfLines={1}>{model}{!available ? " · нет ключа" : ""}</Txt>
        </Pressable>
        {active ? <Chip text="выбрана" color={p.accent} /> : null}
        <IconBtn glyph={preferences?.favorites.includes(model) ? "★" : "☆"} label={preferences?.favorites.includes(model) ? "Убрать из избранного" : "В избранное"} onPress={() => favorite(model)} />
      </Row>
    );
  };

  const special = (title: string, values: string[]) => values.length ? (
    <View style={{ gap: 3 }}><Txt kind="label">{title}</Txt>{values.map(modelRow)}</View>
  ) : null;

  return (
    <View style={{ borderWidth: 1, borderColor: p.line2, borderRadius: 12, backgroundColor: p.bg2, overflow: "hidden" }}>
      <Row style={{ padding: 10, borderBottomWidth: 1, borderBottomColor: p.line, gap: 8 }}>
        <Text style={{ color: p.dim, fontFamily: MONO }}>⌕</Text>
        <TextInput value={query} onChangeText={setQuery} placeholder="Модель или провайдер…" placeholderTextColor={p.faint} autoCapitalize="none" autoCorrect={false}
          style={{ flex: 1, color: p.text, fontSize: 14, outlineStyle: "none", paddingVertical: 5 } as never} />
        {onClose ? <IconBtn glyph="×" label="Закрыть выбор модели" onPress={onClose} /> : null}
      </Row>
      <ScrollView style={{ maxHeight }} contentContainerStyle={{ padding: 10, gap: 13 }} keyboardShouldPersistTaps="handled">
        {preferences && !query ? special("избранное", preferences.favorites.filter((x) => models.includes(x))) : null}
        {preferences && !query ? special("недавние", preferences.recent.filter((x) => models.includes(x) && !preferences.favorites.includes(x))) : null}
        {groups.map(([provider, values]) => (
          <View key={provider} style={{ gap: 3 }}>
            <Row style={{ justifyContent: "space-between" }}><Txt kind="label">{providerTitles[provider] || provider}</Txt><Chip text={ready.includes(provider) ? `${values.length}` : "нет ключа"} color={ready.includes(provider) ? p.ok : p.dim} /></Row>
            {values.map(modelRow)}
          </View>
        ))}
        {!visible.length ? <Txt kind="dim" style={{ padding: 12, textAlign: "center" }}>Ничего не найдено.</Txt> : null}
      </ScrollView>
      <View style={{ padding: 10, borderTopWidth: 1, borderTopColor: p.line, backgroundColor: alpha(p.accent, 0.03) }}><Txt kind="small">Звезда — избранное. Выбранные модели попадают в недавние на этом устройстве.</Txt></View>
    </View>
  );
}
