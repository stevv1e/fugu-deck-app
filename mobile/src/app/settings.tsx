/** Настройки приложения: оформление и что защищает ключи на этом телефоне. */
import Constants from "expo-constants";
import { Pressable, View } from "react-native";

import { versionLabel } from "@/core/version";
import { useServers } from "@/state/servers";
import { Card, Chip, Row, Screen, Txt } from "@/ui/kit";
import { THEMES, useTheme } from "@/ui/theme";

const STORAGE: Record<string, string> = {
  secure_enclave: "Secure Enclave — ключи в отдельном чипе iPhone",
  strongbox: "StrongBox — ключи в отдельном защищённом чипе",
  tee: "TEE — ключи в защищённой среде процессора",
  tpm: "TPM — ключи в защищённом чипе компьютера",
  software: "Программные ключи в Keychain/Keystore",
};

export default function AppSettings() {
  const { p, setTheme } = useTheme();
  const { caps } = useServers();
  return (
    <Screen title="Настройки">
      <Txt kind="label">оформление</Txt>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {THEMES.map((t) => {
          const on = t.id === p.id;
          return (
            <Pressable
              key={t.id}
              onPress={() => setTheme(t.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={{
                width: "47%",
                flexGrow: 1,
                backgroundColor: t.bg,
                borderWidth: on ? 2 : 1,
                borderColor: on ? t.accent : t.line2,
                borderRadius: t.radius,
                padding: 12,
                gap: 6,
              }}
            >
              <Row gap={5}>
                {[t.accent, t.accent2, t.warn].map((c) => (
                  <View key={c} style={{ width: 14, height: 14, backgroundColor: c, borderRadius: t.radius ? 7 : 0 }} />
                ))}
              </Row>
              <Txt style={{ color: t.text, fontWeight: "700" }}>{t.name}</Txt>
              <Txt style={{ color: t.dim, fontSize: 12 }}>{t.note}</Txt>
            </Pressable>
          );
        })}
      </View>

      <Txt kind="label">безопасность телефона</Txt>
      <Card>
        {caps ? (
          <>
            <Row style={{ justifyContent: "space-between" }}>
              <Txt style={{ flex: 1 }}>{STORAGE[caps.storage]}</Txt>
              <Chip text={caps.storage} color={caps.storage === "software" ? p.warn : p.ok} />
            </Row>
            <Txt kind="dim">Биометрия: {caps.biometry ? "есть — спрашивается на каждое подтверждение" : "не настроена"}</Txt>
            <Txt kind="dim">mTLS: {caps.mtls ? "поддерживается" : "недоступен в этой сборке"}</Txt>
            {caps.note ? <Txt kind="small">{caps.note}</Txt> : null}
          </>
        ) : (
          <Txt kind="dim">…</Txt>
        )}
      </Card>

      <Card>
        <Txt kind="label">о приложении</Txt>
        <Txt kind="dim" selectable>
          Fugu Deck {versionLabel(Constants.expoConfig?.version, Constants.expoConfig?.extra?.commit)} · протокол устройств v1
        </Txt>
        <Txt kind="small">
          Вход по ключу устройства (DPoP), подтверждения подписываются ключом с биометрией, сервер проверяется по отпечатку его ключа.
        </Txt>
      </Card>
    </Screen>
  );
}
