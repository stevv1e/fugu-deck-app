/**
 * Вход и привязка телефона. Пароль (и код) вводится один раз — телефон создаёт два ключа
 * (в чипе, если есть модуль fd-secure), подписывает ими заявление и получает квитанцию,
 * подписанную ключом сервера. Дальше вход — только ключом устройства.
 */
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Platform } from "react-native";

import { shortFp } from "@/core/invite";
import type { ServerInfo } from "@/core/types";
import { useServers } from "@/state/servers";
import { Btn, Card, Chip, errText, Field, Notice, Row, Screen, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";

const DEFAULT_NAME = Platform.select({ ios: "iPhone", android: "Android", default: "Браузер" });

const STORAGE_TEXT: Record<string, string> = {
  secure_enclave: "Ключи создаются в Secure Enclave и не покидают чип.",
  strongbox: "Ключи создаются в StrongBox (отдельный защищённый чип) и не покидают его.",
  tee: "Ключи создаются в защищённой среде процессора (TEE) и не покидают её.",
  software: "Ключи программные — в Keychain/Keystore телефона.",
};

export default function Login() {
  const { p } = useTheme();
  const { sid } = useLocalSearchParams<{ sid: string }>();
  const { get, probe, signIn, caps, notices, remove } = useServers();
  const rec = get(sid);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [deviceName, setDeviceName] = useState(DEFAULT_NAME);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (rec) probe(rec.url).then(setInfo, (e) => setError(errText(e)));
  }, [rec?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rec) {
    return (
      <Screen title="Вход">
        <Notice text="Сервер не найден" />
      </Screen>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(sid, { username: username.trim(), password, totp: totp.trim() || undefined, deviceName: deviceName.trim() });
      router.replace(`/s/${sid}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={rec.name}>
      {notices[sid] ? <Notice kind="warn" text={notices[sid]} /> : null}
      <Card accent={p.accent}>
        <Txt kind="label">вход на сервер</Txt>
        <Txt kind="mono" color={p.dim}>
          {rec.url}
        </Txt>
        <Txt kind="small">ключ сервера {shortFp(rec.fingerprint)}</Txt>
      </Card>

      <Field label="Логин" placeholder="владелец — можно оставить пустым" value={username} onChangeText={setUsername} textContentType="username" />
      <Field label="Пароль" value={password} onChangeText={setPassword} secureTextEntry textContentType="password" onSubmitEditing={submit} />
      {info?.auth.totp ? (
        <Field label="Код из приложения" value={totp} onChangeText={setTotp} keyboardType="number-pad" maxLength={8} textContentType="oneTimeCode" hint="Нужен владельцу сервера" />
      ) : null}
      <Field label="Имя устройства" value={deviceName} onChangeText={setDeviceName} hint="Так телефон будет виден в списке устройств" />

      {error ? <Notice text={error} /> : null}
      <Btn title="Войти и привязать телефон" onPress={submit} busy={busy} disabled={!password} />

      {caps ? (
        <Card>
          <Row style={{ justifyContent: "space-between" }}>
            <Txt kind="label">защита телефона</Txt>
            <Chip text={caps.storage} color={caps.storage === "software" ? p.warn : p.ok} />
          </Row>
          <Txt kind="dim">{STORAGE_TEXT[caps.storage]}</Txt>
          <Txt kind="dim">
            {caps.biometry
              ? "Подтверждения действий агента и отзыв устройств — только с биометрией, на каждую подпись."
              : "Биометрия не настроена — подтверждения будут защищены кодом телефона."}
          </Txt>
          {info?.devices.mtls && info.devices.mtls !== "off" ? (
            <Txt kind="dim">
              {caps.mtls
                ? "Сервер использует mTLS: телефон получит сертификат на ключ сессии."
                : info.devices.mtls === "required"
                  ? "Сервер требует mTLS — эта сборка приложения его не умеет."
                  : "Сервер поддерживает mTLS, эта сборка — нет; вход по DPoP."}
            </Txt>
          ) : null}
          {caps.note ? <Txt kind="small">{caps.note}</Txt> : null}
        </Card>
      ) : null}

      <Btn
        title="Убрать сервер из приложения"
        kind="ghost"
        small
        onPress={async () => {
          await remove(sid);
          router.replace("/");
        }}
      />
    </Screen>
  );
}
