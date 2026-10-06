/**
 * Устройство в кластере: ожидание подтверждения → сертификат mTLS → ввод ключей API.
 * Ключ шифруется на телефоне для keyguard (HPKE) и подписывается биометрией; посредники видят только шифротекст.
 */
import { FdSecure } from "fd-secure";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";

import { buildKeyPut, KEY_PROVIDERS, validateApiKey, type KeyProvider } from "@/core/apikeys";
import { unb64 } from "@/core/bytes";
import { clusterDeviceId, fetchStatus, refresh, signClusterAction, type ClusterInvite } from "@/core/cluster";
import { dpopProof } from "@/core/dpop";
import { errorFrom } from "@/core/http";
import { mtlsHttp, nativeMtlsAvailable, plainHttp } from "@/platform/http";
import { keyProvider } from "@/platform/keys";
import { getCluster, loadRefresh, saveCluster, saveRefresh, type ClusterRecord } from "@/state/cluster";
import { Btn, Card, Chip, errText, Field, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";

const TITLES: Record<KeyProvider, string> = { anthropic: "Claude", sakana: "Sakana", github: "GitHub", gitlab: "GitLab" };

export default function ClusterDevice() {
  const { cid } = useLocalSearchParams<{ cid: string }>();
  const [rec, setRec] = useState<ClusterRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "ok" | "info"; text: string } | null>(null);
  const [provider, setProvider] = useState<KeyProvider>("anthropic");
  const [apiKey, setApiKey] = useState("");

  useEffect(() => { getCluster(cid).then(setRec); }, [cid]);

  const keys = useCallback(async () => {
    const k = await (await keyProvider()).load(rec!.alias);
    if (!k) throw new Error("Ключи устройства не найдены — зарегистрируйтесь заново по приглашению");
    return k;
  }, [rec]);

  const check = async () => {
    if (!rec) return;
    setBusy(true);
    setMsg(null);
    try {
      const st = await fetchStatus(plainHttp(), rec as unknown as ClusterInvite, await keys(), Date.now() / 1000);
      if (st.status === "active" && st.cert_pem) {
        if (FdSecure) await FdSecure.setClientCertificate(rec.alias + ".s", st.cert_pem);
        const next = { ...rec, status: st.status, certPem: st.cert_pem };
        await saveCluster(next);
        setRec(next);
        setMsg({ kind: "ok", text: "Устройство подтверждено, сертификат получен" });
      } else {
        await saveCluster({ ...rec, status: st.status });
        setRec({ ...rec, status: st.status });
        setMsg({ kind: st.status === "revoked" ? "error" : "info", text: st.status === "revoked" ? "Устройство отозвано" : "Ещё не подтверждено" });
      }
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async () => {
    if (!rec) return;
    const bad = validateApiKey(apiKey.trim());
    if (bad) return setMsg({ kind: "error", text: bad });
    setBusy(true);
    setMsg(null);
    try {
      const k = await keys();
      const inv = rec as unknown as ClusterInvite;
      const rt = await loadRefresh(rec.id);
      if (!rt) throw new Error("Сессия истекла — войдите заново по приглашению");
      const http = nativeMtlsAvailable() && rec.certPem ? mtlsHttp(rec.alias + ".s") : plainHttp();
      const now = () => Date.now() / 1000;
      const t = await refresh(plainHttp(), inv, k, rt, now());
      await saveRefresh(rec.id, t.refreshToken);
      const body = await buildKeyPut((f, r, n) => signClusterAction(k, f, r, n), { hpkePub: unb64(rec.hpke), deviceId: clusterDeviceId(k), provider, apiKey });
      const url = `${rec.api}/v1/keys`;
      const proof = await dpopProof({ key: k.session, method: "POST", url, accessToken: t.accessToken, now: now() });
      const r = await http.request({ method: "POST", url, body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", Authorization: `DPoP ${t.accessToken}`, DPoP: proof } });
      if (r.status !== 200) throw errorFrom(r.status, r.text);
      setApiKey("");
      setMsg({ kind: "ok", text: `Ключ ${TITLES[provider]} сохранён: ${JSON.parse(r.text).masked}. Его видит только keyguard.` });
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!rec) return <Screen title="Кластер"><Loading /></Screen>;
  const active = rec.status === "active";

  return (
    <Screen title={new URL(rec.api).host}>
      <Card>
        <Row><Txt>{rec.name}</Txt><Chip text={active ? "подтверждено" : rec.status === "revoked" ? "отозвано" : "ждёт подтверждения"} /></Row>
        <Txt kind="dim">Пользователь {rec.user} · устройство</Txt>
        <Txt selectable>{rec.deviceId}</Txt>
      </Card>
      {!active ? (
        <>
          <Txt kind="dim">Попросите пригласившего подтвердить устройство с этим кодом. Затем нажмите «Проверить».</Txt>
          <Btn title="Проверить" onPress={check} busy={busy} />
        </>
      ) : (
        <>
          <Txt kind="dim">Ключ API шифруется на этом телефоне для keyguard — ни сервер, ни администратор его не видят.</Txt>
          <Row gap={6}>{KEY_PROVIDERS.map((p) => (
            <Btn key={p} small title={TITLES[p]} kind={p === provider ? "primary" : "ghost"} onPress={() => setProvider(p)} />
          ))}</Row>
          <Field label={`Ключ ${TITLES[provider]}`} value={apiKey} onChangeText={setApiKey} secureTextEntry autoCapitalize="none" autoCorrect={false} />
          <Btn title="Сохранить ключ" onPress={saveKey} busy={busy} disabled={!apiKey} />
          {!nativeMtlsAvailable() ? <Notice kind="warn" text="Сборка без модуля fd-secure: mTLS недоступен, сервер с обязательным mTLS запрос не примет." /> : null}
        </>
      )}
      {msg ? <Notice kind={msg.kind} text={msg.text} /> : null}
    </Screen>
  );
}
