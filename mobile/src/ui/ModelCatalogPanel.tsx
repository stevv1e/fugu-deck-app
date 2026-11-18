import { useEffect, useState } from "react";

import type { AppConfig, DeckApi } from "@/core/api";
import {
  EMPTY_MODEL_PREFS,
  fallbackChain,
  nameOfModel,
  type ModelPreferences,
  type ModelRole,
} from "@/core/models";
import { loadModelPreferences, saveModelPreferences } from "@/state/modelPreferences";
import { Btn, Card, Chip, errText, Field, Notice, Row, Txt } from "@/ui/kit";
import { ModelPicker } from "@/ui/ModelPicker";
import { useTheme } from "@/ui/theme";

const ROLES: { id: ModelRole; title: string; hint: string }[] = [
  { id: "code", title: "Код и работа", hint: "основной исполнитель сценария" },
  { id: "review", title: "Независимое ревью", hint: "проверяет результат без инструментов" },
  { id: "summary", title: "Сводка", hint: "короткий итог после ревью" },
];

export function ModelCatalogPanel({ api, config, onChanged }: {
  api: DeckApi;
  config: AppConfig;
  onChanged(): Promise<void>;
}) {
  const { p } = useTheme();
  const [preferences, setPreferences] = useState<ModelPreferences>(EMPTY_MODEL_PREFS);
  const [assign, setAssign] = useState<ModelRole | "fallback" | null>(null);
  const [refreshing, setRefreshing] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [custom, setCustom] = useState({ id: "", name: "", base_url: "", models: "", api_key: "" });
  useEffect(() => { void loadModelPreferences().then(setPreferences); }, []);

  const patch = async (next: ModelPreferences) => {
    setPreferences(next);
    await saveModelPreferences(next);
  };
  const select = async (model: string) => {
    if (!assign) return;
    if (assign === "fallback") {
      if (model !== config.default_model && !preferences.fallbacks.includes(model)) {
        await patch({ ...preferences, fallbacks: [...preferences.fallbacks, model].slice(0, 3) });
      }
    } else {
      await patch({ ...preferences, roles: { ...preferences.roles, [assign]: model } });
    }
    setAssign(null);
  };
  const refresh = async (provider: string) => {
    setRefreshing(provider); setError(""); setNote("");
    try {
      const result = await api.refreshModels(provider);
      await onChanged();
      setNote(`${config.provider_titles?.[provider] || provider}: получено ${result.models.length} моделей`);
    } catch (e) { setError(errText(e)); } finally { setRefreshing(""); }
  };
  const addEndpoint = async () => {
    setSaving(true); setError(""); setNote("");
    try {
      await api.addModelEndpoint({
        id: custom.id.trim(), name: custom.name.trim(), base_url: custom.base_url.trim(),
        models: custom.models.split(/[\s,]+/).filter(Boolean), api_key: custom.api_key,
      });
      setCustom({ id: "", name: "", base_url: "", models: "", api_key: "" });
      setCustomOpen(false);
      await onChanged();
      setNote("Endpoint сохранён. Ключ хранится только в памяти сервера и снова понадобится после перезапуска или истечения TTL.");
    } catch (e) { setError(errText(e)); } finally { setSaving(false); }
  };

  return (
    <>
      <Card accent={p.accent}>
        <Txt kind="label">модели по задачам</Txt>
        <Txt kind="small">Роли используются сценарием «Код → ревью → сводка». Это локальные предпочтения устройства.</Txt>
        {ROLES.map((role) => (
          <Row key={role.id} style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <ViewLike title={role.title} hint={role.hint} />
            <Btn small kind="ghost" title={preferences.roles[role.id] ? nameOfModel(preferences.roles[role.id]) : "Выбрать"} onPress={() => setAssign(role.id)} />
          </Row>
        ))}
        <Txt kind="label">fallback при сбое до начала ответа</Txt>
        <Row gap={6} style={{ flexWrap: "wrap" }}>
          {fallbackChain(preferences).map((model) => <Btn key={model} small kind="ghost" title={`${nameOfModel(model)} ×`} onPress={() => patch({ ...preferences, fallbacks: preferences.fallbacks.filter((x) => x !== model) })} />)}
          {preferences.fallbacks.length < 3 ? <Btn small kind="ghost" title="+ Fallback" onPress={() => setAssign("fallback")} /> : null}
        </Row>
      </Card>
      {assign ? <Card accent={p.accent}><Txt kind="label">{assign === "fallback" ? "резервная модель" : `модель для: ${ROLES.find((x) => x.id === assign)?.title}`}</Txt>
        <ModelPicker models={config.models} ready={config.llm_ready} providerTitles={config.provider_titles} onSelect={(m) => void select(m)} onClose={() => setAssign(null)} />
      </Card> : null}
      <Card>
        <Txt kind="label">поиск и избранное</Txt>
        <ModelPicker models={config.models} ready={config.llm_ready} providerTitles={config.provider_titles} selected={config.default_model}
          onSelect={(model) => { void patch({ ...preferences, roles: { ...preferences.roles, code: model } }); }} />
      </Card>
      {error ? <Notice text={error} /> : null}
      {note ? <Notice kind="ok" text={note} /> : null}
      <Card>
        <Row style={{ justifyContent: "space-between" }}><Txt kind="h2">Динамический каталог</Txt><Chip text={`${config.models.length} моделей`} color={p.accent} /></Row>
        <Txt kind="small">Запросить актуальный список /models у провайдера с уже добавленным ключом. Новые ID сохраняются в каталоге сервера.</Txt>
        <Row gap={6} style={{ flexWrap: "wrap" }}>
          {config.llm_ready.filter((provider) => !provider.startsWith("custom-")).map((provider) => (
            <Btn key={provider} small kind="ghost" busy={refreshing === provider} disabled={!!refreshing}
              title={`↻ ${config.provider_titles?.[provider] || provider}`} onPress={() => refresh(provider)} />
          ))}
          {!config.llm_ready.length ? <Txt kind="small">Сначала добавьте ключ провайдера.</Txt> : null}
        </Row>
      </Card>
      <Card>
        <Row style={{ justifyContent: "space-between" }}><Txt kind="h2">Свои OpenAI-совместимые API</Txt><Btn small kind="ghost" title={customOpen ? "Закрыть" : "+ Endpoint"} onPress={() => setCustomOpen(!customOpen)} /></Row>
        <Txt kind="small">Только standalone. В кластере сетевые запросы разрешены через Keyguard, поэтому произвольные endpoint там отключены.</Txt>
        {(config.custom_endpoints ?? []).map((endpoint) => (
          <Row key={endpoint.id} style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <ViewLike title={endpoint.name} hint={`${endpoint.base_url} · ${endpoint.models.length} моделей`} />
            <Btn small kind="danger" title="Удалить" onPress={async () => { try { await api.deleteModelEndpoint(endpoint.id); await onChanged(); } catch (e) { setError(errText(e)); } }} />
          </Row>
        ))}
        {customOpen ? <>
          <Field label="ID (латиницей)" value={custom.id} onChangeText={(id) => setCustom({ ...custom, id })} placeholder="my-api" />
          <Field label="Название" value={custom.name} onChangeText={(name) => setCustom({ ...custom, name })} placeholder="Мой API" />
          <Field label="Base URL" value={custom.base_url} onChangeText={(base_url) => setCustom({ ...custom, base_url })} placeholder="https://api.example.com/v1" />
          <Field label="ID моделей через запятую" value={custom.models} onChangeText={(models) => setCustom({ ...custom, models })} placeholder="model-one, model-two" />
          <Field label="API-ключ (не записывается на диск)" value={custom.api_key} onChangeText={(api_key) => setCustom({ ...custom, api_key })} secureTextEntry placeholder="Может быть пустым для API без авторизации" />
          <Btn title="Сохранить endpoint" onPress={addEndpoint} busy={saving} disabled={!custom.id.trim() || !custom.name.trim() || !custom.base_url.trim() || !custom.models.trim()} />
        </> : null}
      </Card>
      <Txt kind="small">Цена — за миллион токенов: ввод / вывод, если тариф известен. Динамические и пользовательские модели могут не иметь оценки стоимости.</Txt>
    </>
  );
}

function ViewLike({ title, hint }: { title: string; hint: string }) {
  return <Txt style={{ flex: 1 }}><Txt>{title}</Txt>{"\n"}<Txt kind="small">{hint}</Txt></Txt>;
}
