import { useState } from "react";
import { View } from "react-native";

import { draftFromTemplate, draftModule, makeDraft, publishDraft, type ModuleDraft, type ModuleTemplate } from "@/core/moduleStudio";
import { parseGitSource } from "@/core/modules";
import { Btn, Card, Chip, errText, Field, Notice, Row, Txt } from "@/ui/kit";
import { ModuleRunner } from "@/ui/ModuleRunner";
import { useTheme } from "@/ui/theme";

const TEMPLATES: { id: ModuleTemplate; title: string; text: string }[] = [
  { id: "tool", title: "Инструмент", text: "Форма и локальная обработка данных" },
  { id: "panel", title: "UI-панель", text: "Интерфейс с разрешением storage" },
  { id: "schedule", title: "Расписание", text: "Таймер в открытой панели без фоновых задач" },
  { id: "prompts", title: "Промпт-пакет", text: "Набор локальных шаблонов запросов" },
];

export function ModuleStudio() {
  const { p } = useTheme();
  const initial = draftFromTemplate("tool");
  const [draft, setDraft] = useState<ModuleDraft>(initial);
  const [manifest, setManifest] = useState(JSON.stringify(initial.manifest, null, 2));
  const [code, setCode] = useState(initial.code);
  const [preview, setPreview] = useState(false);
  const [source, setSource] = useState({ url: "", ref: "main", path: "", token: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const template = (id: ModuleTemplate) => {
    const next = draftFromTemplate(id);
    setDraft(next); setManifest(JSON.stringify(next.manifest, null, 2)); setCode(next.code); setPreview(false); setError(""); setNote("");
  };
  const rebuild = (value = manifest, entry = code) => {
    const parsed = JSON.parse(value);
    delete parsed.sha256;
    const next = makeDraft(parsed, entry);
    setDraft(next); setManifest(JSON.stringify(next.manifest, null, 2)); setCode(entry);
    return next;
  };
  const check = () => {
    try { rebuild(); setPreview(true); setError(""); }
    catch (e) { setError(errText(e)); setPreview(false); }
  };
  const publish = async () => {
    setBusy(true); setError(""); setNote("");
    try {
      const next = rebuild();
      const parsed = parseGitSource(source.url, source.ref, source.path);
      const result = await publishDraft(parsed, source.token, next);
      setNote(`Опубликован commit ${result.commit}. Модуль можно установить из раздела «Добавить из Git».`);
      setSource({ ...source, token: "" });
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  };

  return <>
    <Card accent={p.accent}>
      <Row style={{ justifyContent: "space-between", flexWrap: "wrap" }}><Txt kind="h2">Конструктор модулей</Txt><Chip text="локально" color={p.ok} /></Row>
      <Txt kind="small">Выберите основу, отредактируйте манифест и JS. SHA-256 пересчитывается автоматически; токен публикации не сохраняется.</Txt>
    </Card>
    {error ? <Notice text={error} /> : null}
    {note ? <Notice kind="ok" text={note} /> : null}
    <View style={{ gap: 10 }}>
      {TEMPLATES.map((item) => <Card key={item.id} accent={draft.manifest.id === draftFromTemplate(item.id).manifest.id ? p.accent : undefined}>
        <Row style={{ justifyContent: "space-between", flexWrap: "wrap" }}><View style={{ flex: 1, minWidth: 220 }}><Txt kind="h2">{item.title}</Txt><Txt kind="small">{item.text}</Txt></View><Btn small kind="ghost" title="Использовать" onPress={() => template(item.id)} /></Row>
      </Card>)}
    </View>
    <Card>
      <Txt kind="label">манифест module.json</Txt>
      <Field label="JSON" value={manifest} onChangeText={(value) => { setManifest(value); setPreview(false); }} multiline style={{ minHeight: 290, textAlignVertical: "top", fontSize: 12 }} />
      <Field label="JS entry" value={code} onChangeText={(value) => { setCode(value); setPreview(false); }} multiline style={{ minHeight: 260, textAlignVertical: "top", fontSize: 12 }} />
      <Btn title="Проверить и запустить черновик" onPress={check} />
    </Card>
    {preview ? <ModuleRunner key={draft.manifest.sha256} module={draftModule(draft)} onError={setError} /> : null}
    <Card>
      <Txt kind="h2">Публикация в GitHub</Txt>
      <Txt kind="small">Один commit через Git Data API, без force-push. Репозиторий и ветка должны уже существовать.</Txt>
      <Field label="GitHub URL репозитория" value={source.url} onChangeText={(url) => setSource({ ...source, url })} placeholder="https://github.com/user/modules" />
      <Field label="Ветка" value={source.ref} onChangeText={(ref) => setSource({ ...source, ref })} />
      <Field label="Папка модуля" value={source.path} onChangeText={(path) => setSource({ ...source, path })} placeholder="modules/my-module; пусто — корень" />
      <Field label="GitHub token (не сохраняется)" value={source.token} onChangeText={(token) => setSource({ ...source, token })} secureTextEntry />
      <Btn title="Опубликовать module.json и entry" busy={busy} disabled={!source.url.trim() || !source.token.trim()} onPress={publish} />
    </Card>
  </>;
}
