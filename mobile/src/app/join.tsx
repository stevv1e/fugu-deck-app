/**
 * Вход в кластер по QR-приглашению (fugudeck://join?…): браузер → Keycloak (passkey) → токен с DPoP →
 * регистрация устройства (ждёт подтверждения пригласившим). Открывается и по ссылке, и из сканера.
 */
import { unb64 } from "@/core/bytes";
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useMemo, useState } from "react";

import {
  browserStartUrl, buildEnroll, clusterDeviceId, fetchChallenge, exchangeCode, joinHeaders, newPkce, parseClusterInvite, parseRedirect, REDIRECT_URI,
} from "@/core/cluster";
import { errorFrom } from "@/core/http";
import { keyProvider } from "@/platform/keys";
import { plainHttp } from "@/platform/http";
import { clusterId, saveCluster, saveRefresh } from "@/state/cluster";
import { Btn, Card, errText, Field, Notice, Screen, Txt } from "@/ui/kit";

export default function Join() {
  const q = useLocalSearchParams<Record<string, string>>();
  const [name, setName] = useState("Мой телефон");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState("");

  const inv = useMemo(() => {
    try {
      return parseClusterInvite("fugudeck://join?" + new URLSearchParams(q as Record<string, string>).toString());
    } catch (e) {
      return e as Error;
    }
  }, [q]);

  if (inv instanceof Error) {
    return (
      <Screen title="Приглашение в кластер">
        <Notice text={inv.message} />
        <Btn title="Назад" kind="ghost" onPress={() => router.replace("/")} />
      </Screen>
    );
  }

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const id = clusterId(inv);
      const alias = `cluster.${id}`;
      const http = plainHttp();
      setStep("Создаю ключи устройства…");
      const provider = await keyProvider();
      await provider.remove(alias).catch(() => {});
      // вызов сервера вписывается чипом в аттестацию ключей — его нужно получить до их создания
      const challenge = await fetchChallenge(http, inv);
      const keys = await provider.create(alias, challenge ? unb64(challenge) : undefined);
      const pkce = newPkce();
      setStep("Вход в браузере…");
      const res = await WebBrowser.openAuthSessionAsync(browserStartUrl(inv, pkce), REDIRECT_URI);
      if (res.type !== "success") throw new Error("Вход отменён");
      const code = parseRedirect(res.url, pkce);
      setStep("Получаю токен, привязанный к ключу устройства…");
      const now = () => Date.now() / 1000;
      const tokens = await exchangeCode(http, inv, keys, code, pkce, now());
      setStep("Регистрирую устройство (подтвердите биометрией)…");
      const body = await buildEnroll(inv, keys, tokens, name.trim() || "Телефон", now(), challenge);
      const r = await http.request({ method: "POST", url: `${inv.join}/v1/enroll`, headers: joinHeaders(inv), body: JSON.stringify(body) });
      if (r.status !== 200) throw errorFrom(r.status, r.text);
      const out = JSON.parse(r.text) as { device_id: string; user: string; status: "pending" | "active" };
      if (out.device_id !== clusterDeviceId(keys)) throw new Error("Сервер вернул чужой ID устройства");
      await saveRefresh(id, tokens.refreshToken);
      await saveCluster({ id, api: inv.api, issuer: inv.issuer, join: inv.join, hpke: inv.hpke, alias,
        deviceId: out.device_id, user: out.user, name, status: out.status });
      router.replace({ pathname: "/cluster/[cid]", params: { cid: id } });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
      setStep("");
    }
  };

  return (
    <Screen title="Приглашение в кластер">
      <Card>
        <Txt kind="dim">Сервер</Txt>
        <Txt selectable>{new URL(inv.api).host}</Txt>
        <Txt kind="dim">Вход</Txt>
        <Txt selectable>{new URL(inv.issuer).host}</Txt>
      </Card>
      <Txt kind="dim">
        Откроется браузер: войдите по passkey. Телефон создаст два ключа в защищённом чипе, токен будет привязан к ним.
        После регистрации устройство подтвердит тот, кто вас пригласил.
      </Txt>
      <Field label="Название устройства" value={name} onChangeText={setName} maxLength={40} />
      {error ? <Notice text={error} /> : null}
      {step ? <Notice kind="info" text={step} /> : null}
      <Btn title="Войти" onPress={start} busy={busy} />
    </Screen>
  );
}
