/** Ключи провайдеров (только на этом устройстве), модели, системная подсказка и тема. */
import Constants from "expo-constants";
import { useEffect, useState } from "react";
import { Linking } from "react-native";

import { DEFAULT_MODELS, PROVIDER_IDS, PROVIDERS, validModel, type Provider } from "@/core/providers";
import { delKey, getKey, secretsWeak, setKey } from "@/platform/secrets";
import { getSettings, saveSettings, type Settings } from "@/state/store";
import { Btn, Card, errText, Field, Notice, Row, Screen, Txt } from "@/ui/kit";
import { THEMES, useTheme } from "@/ui/theme";

const mask = (k: string) => (k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : "••••");

function KeyCard({ prov }: { prov: Provider }) {
  const P = PROVIDERS[prov];
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getKey(prov).then(setSaved, (e) => setErr(errText(e)));
  }, [prov]);

  const v = draft.trim();
  const bad = v && (/\s/.test(v) || v.length < 8) ? "Ключ без пробелов, не короче 8 символов" : P.keyPrefix && v && !v.startsWith(P.keyPrefix) ? `Ключи ${P.title} обычно начинаются с ${P.keyPrefix}` : null;

  const save = async () => {
    setErr(null);
    try {
      await setKey(prov, v);
      setSaved(v);
      setDraft("");
    } catch (e) {
      setErr(errText(e));
    }
  };
  const drop = async () => {
    await delKey(prov).catch(() => {});
    setSaved(null);
  };

  return (
    <Card>
      <Row style={{ justifyContent: "space-between" }}>
        <Txt kind="h2">{P.title}</Txt>
        <Txt kind="small">{saved ? `ключ ${mask(saved)}` : "ключа нет"}</Txt>
      </Row>
      <Field label={saved ? "Заменить ключ" : "Ключ API"} value={draft} onChangeText={setDraft} secureTextEntry placeholder={P.keyPrefix ? `${P.keyPrefix}…` : ""} hint={bad ?? undefined} />
      {err ? <Notice text={err} /> : null}
      <Row gap={8} style={{ flexWrap: "wrap" }}>
        <Btn small title="Сохранить" onPress={save} disabled={!v || /\s/.test(v) || v.length < 8} />
        {saved ? <Btn small kind="ghost" title="Удалить ключ" onPress={drop} /> : null}
        <Btn small kind="ghost" title="Где взять" onPress={() => void Linking.openURL(P.keyUrl)} />
      </Row>
    </Card>
  );
}

export default function SettingsScreen() {
  const { p, setTheme } = useTheme();
  const [s, setS] = useState<Settings | null>(null);
  const [add, setAdd] = useState("");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then(setS);
  }, []);

  const update = async (next: Settings) => {
    setS(next);
    await saveSettings(next);
  };
  const addBad = add.trim() ? validModel(add) : null;

  return (
    <Screen title="Настройки">
      <Txt kind="dim">
        Fugu Local не обращается к серверу Fugu Deck: сообщения и ключ уходят с этого устройства прямо провайдеру модели.
        Ключи хранятся в защищённом хранилище системы, история чатов — только здесь.
      </Txt>
      {secretsWeak() ? <Notice kind="warn" text="Это браузер: ключи лежат в localStorage. Настоящие ключи вводите в приложении для Android." /> : null}

      <Txt kind="label">ключи моделей</Txt>
      {PROVIDER_IDS.map((prov) => <KeyCard key={prov} prov={prov} />)}

      {s ? (
        <>
          <Txt kind="label">модели</Txt>
          <Card>
            <Txt kind="small">Нажмите модель, чтобы сделать её моделью новых чатов; удерживайте — чтобы убрать из списка.</Txt>
            <Row gap={6} style={{ flexWrap: "wrap" }}>
              {s.models.map((m) => (
                <Btn key={m} small title={m} kind={m === s.defaultModel ? "primary" : "ghost"}
                  onPress={() => update({ ...s, defaultModel: m })} />
              ))}
            </Row>
            <Field label="Добавить модель (провайдер:модель)" value={add} onChangeText={setAdd} placeholder="deepseek:deepseek-flash" hint={addBad ?? undefined} />
            <Row gap={8} style={{ flexWrap: "wrap" }}>
              <Btn small title="Добавить" disabled={!add.trim() || !!addBad || s.models.includes(add.trim())}
                onPress={() => { update({ ...s, models: [...s.models, add.trim()] }); setAdd(""); }} />
              {s.models.length > 1 ? (
                <Btn small kind="ghost" title="Убрать выбранную" onPress={() => {
                  const models = s.models.filter((m) => m !== s.defaultModel);
                  update({ ...s, models, defaultModel: models[0] });
                }} />
              ) : null}
              <Btn small kind="ghost" title="Как было" onPress={() => update({ ...s, models: DEFAULT_MODELS, defaultModel: DEFAULT_MODELS[0] })} />
            </Row>
          </Card>

          <Txt kind="label">системная подсказка</Txt>
          <Card>
            <Field label="Инструкция модели в начале каждого чата" value={s.system} multiline
              onChangeText={(system) => setS({ ...s, system })} style={{ minHeight: 90, textAlignVertical: "top" }} />
            <Btn small title="Сохранить подсказку" onPress={async () => { await saveSettings(s); setNote("Сохранено"); setTimeout(() => setNote(null), 1500); }} />
            {note ? <Txt kind="small">{note}</Txt> : null}
          </Card>
        </>
      ) : null}

      <Txt kind="label">тема</Txt>
      <Row gap={6} style={{ flexWrap: "wrap" }}>
        {THEMES.map((t) => (
          <Btn key={t.id} small title={t.name} kind={t.id === p.id ? "primary" : "ghost"} onPress={() => setTheme(t.id)} />
        ))}
      </Row>

      <Txt kind="small">Fugu Local alpha-{Constants.expoConfig?.version ?? "?"}{Constants.expoConfig?.extra?.commit ? ` (${Constants.expoConfig.extra.commit})` : ""}</Txt>
    </Screen>
  );
}
