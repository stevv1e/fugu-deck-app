import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { useServers } from "@/state/servers";
import { Btn, Card, Chip, Notice, Row, Screen, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";

const STEPS = ["Проверяем ключи и сертификат", "Обновляем защищённую сессию", "Запускаем пространство", "Открываем рабочую область"];

export default function LaunchSpace() {
  const { sid } = useLocalSearchParams<{ sid: string }>();
  const { get, ready, api: openApi } = useServers();
  const rec = get(sid);
  const [attempt, setAttempt] = useState(0);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { p } = useTheme();

  useEffect(() => {
    if (!ready || !rec?.device) return;
    let alive = true;
    void Promise.resolve().then(() => {
      if (alive) setStep(1);
      return openApi(sid);
    }).then(async (api) => {
      if (!alive) return;
      setStep(2);
      await api.projects();
      if (!alive) return;
      setStep(3);
      setTimeout(() => {
        if (alive) router.replace(`/s/${sid}/chats`);
      }, 250);
    }).catch((e) => {
      if (alive) setError(e?.message || String(e));
    });
    return () => { alive = false; };
  }, [ready, openApi, sid, attempt, rec?.device]);

  if (ready && !rec) {
    return <Screen title="Запуск пространства"><Notice text="Пространство не найдено" /><Btn title="В главное меню" onPress={() => router.replace("/")} /></Screen>;
  }
  if (rec && !rec.device) return <Redirect href={`/s/${sid}/login`} />;

  return (
    <Screen title={rec?.name || "Запуск пространства"}>
      <Card accent={p.accent}>
        <Txt kind="label">запускаем пространство</Txt>
        <Txt kind="h2">{rec?.name || "Fugu Deck"}</Txt>
        <Txt kind="dim">Сессия и устройство остаются прежними. Возврат в меню не отключает сервер.</Txt>
      </Card>
      <View style={{ gap: 9 }}>
        {STEPS.map((title, index) => (
          <Row key={title} style={{ justifyContent: "space-between", opacity: index > step ? 0.45 : 1 }}>
            <Txt>{title}</Txt>
            <Chip text={index < step ? "готово" : index === step ? "в работе" : "ожидает"} color={index < step ? p.ok : index === step ? p.accent : p.dim} />
          </Row>
        ))}
      </View>
      {error ? <Notice text={error} /> : null}
      <Row gap={8}>
        {error ? <Btn title="Повторить" onPress={() => { setError(null); setStep(0); setAttempt((v) => v + 1); }} style={{ flex: 1 }} /> : null}
        <Btn title="В главное меню" kind="ghost" onPress={() => router.replace("/")} style={{ flex: 1 }} />
      </Row>
    </Screen>
  );
}
