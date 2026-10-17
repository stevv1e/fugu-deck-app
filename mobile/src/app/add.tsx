/**
 * Добавление сервера. Сюда же ведёт ссылка-приглашение fugudeck://add?url=…&fp=…&name=…
 *  • из QR отпечаток известен заранее — сверяем автоматически, при расхождении не даём подключиться;
 *  • при ручном вводе показываем отпечаток и просим сверить его с владельцем по другому каналу.
 */
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";

import { isInsecure, parseInvite, type Invite } from "@/core/invite";
import { TrustError } from "@/core/server";
import type { ServerInfo } from "@/core/types";
import { useServers } from "@/state/servers";
import { isDesktop } from "@/platform/desktop";
import { Btn, Card, Chip, errText, Field, Fingerprint, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";

export default function AddServer() {
  const { p } = useTheme();
  const params = useLocalSearchParams<{ url?: string; fp?: string; name?: string }>();
  const { probe, add } = useServers();
  // приглашение из ссылки или QR разбираем сразу, проверку сервера запускаем эффектом
  const initial = useMemo(() => {
    if (!params.url) return { inv: null as Invite | null, err: null as string | null };
    try {
      const q = [`url=${encodeURIComponent(params.url)}`];
      if (params.fp) q.push(`fp=${params.fp}`);
      if (params.name) q.push(`name=${encodeURIComponent(params.name)}`);
      return { inv: parseInvite(`fugudeck://add?${q.join("&")}`), err: null };
    } catch (e) {
      return { inv: null, err: errText(e) };
    }
  }, [params.url, params.fp, params.name]);

  const [text, setText] = useState("");
  const [inv, setInv] = useState<Invite | null>(initial.inv);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [error, setError] = useState<{ text: string; hard: boolean } | null>(initial.err ? { text: initial.err, hard: false } : null);
  const [busy, setBusy] = useState(!!initial.inv);

  const failed = (e: unknown) => ({ text: errText(e), hard: e instanceof TrustError && e.kind === "mismatch" });

  useEffect(() => {
    const i = initial.inv;
    if (!i) return;
    let alive = true;
    probe(i.url, i.fp).then(
      (r) => alive && setInfo(r),
      (e) => alive && setError(failed(e)),
    ).finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [initial, probe]);

  const check = async (i: Invite) => {
    setInv(i);
    setInfo(null);
    setError(null);
    setBusy(true);
    try {
      setInfo(await probe(i.url, i.fp));
    } catch (e) {
      setError(failed(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    try {
      check(parseInvite(text));
    } catch (e) {
      setError({ text: errText(e), hard: false });
    }
  };

  const confirm = async () => {
    if (!info || !inv) return;
    setBusy(true);
    try {
      const rec = await add(info, inv.url, inv.source, inv.name);
      router.replace(rec.device ? `/s/${rec.id}` : `/s/${rec.id}/login`);
    } catch (e) {
      setError({ text: errText(e), hard: false });
      setBusy(false);
    }
  };

  const reset = () => {
    setInv(null);
    setInfo(null);
    setError(null);
  };

  return (
    <Screen title="Новый сервер">
      {!inv || (!info && !busy && !error?.hard) ? (
        <>
          <Field
            label="Адрес сервера"
            placeholder="deck.example.com"
            value={text}
            onChangeText={setText}
            keyboardType="url"
            returnKeyType="go"
            onSubmitEditing={submit}
            hint="Можно вставить и ссылку-приглашение fugudeck://… Без HTTPS — только серверы в локальной сети."
          />
          {error ? <Notice text={error.text} /> : null}
          <Btn title="Проверить сервер" onPress={submit} busy={busy} disabled={!text.trim()} />
          {isDesktop ? null : <Btn title="Сканировать QR" kind="ghost" onPress={() => router.replace("/scan")} />}
          <Card>
            <Txt kind="label">как это работает</Txt>
            <Txt kind="dim">
              У каждого сервера есть свой ключ. Приложение запомнит его отпечаток и при каждом подключении будет проверять, что
              говорит с тем же сервером. Регистрация телефона подписывается этим ключом — подменённый сервер её не пройдёт.
            </Txt>
          </Card>
        </>
      ) : busy && !info ? (
        <Loading text={`Связываюсь с ${inv.url}…`} />
      ) : error?.hard ? (
        <>
          <Notice text={error.text} />
          <Txt kind="dim">Адрес: {inv.url}</Txt>
          <Btn title="Назад" kind="ghost" onPress={reset} />
        </>
      ) : info ? (
        <>
          <Card accent={p.accent}>
            <Txt kind="label">сервер</Txt>
            <Txt kind="h2">{inv.name || info.name}</Txt>
            <Txt kind="mono" color={p.dim}>
              {inv.url}
            </Txt>
            <Row gap={6} style={{ flexWrap: "wrap" }}>
              {info.auth.totp ? <Chip text="пароль + код" /> : <Chip text="пароль" />}
              {info.devices.mtls !== "off" ? <Chip text={`mTLS: ${info.devices.mtls}`} color={p.accent} /> : null}
              {isInsecure(inv.url) ? <Chip text="без HTTPS" color={p.accent2} /> : null}
            </Row>
          </Card>

          <Txt kind="label">отпечаток ключа сервера</Txt>
          <Fingerprint fp={info.identity.fingerprint} highlight={inv.source === "qr"} />

          {inv.source === "qr" ? (
            <Notice kind="ok" text="✓ Отпечаток совпал с QR-приглашением. Это тот сервер, который вам передали." />
          ) : (
            <Notice
              kind="warn"
              text="Сверьте отпечаток с владельцем сервера по другому каналу — лично, по телефону или в мессенджере. Если отличается хоть один символ, не подключайтесь: кто-то может выдавать себя за сервер."
            />
          )}
          {isInsecure(inv.url) ? <Notice kind="warn" text="Соединение без HTTPS. Допустимо только в доверенной локальной сети." /> : null}

          <Btn title={inv.source === "qr" ? "Добавить сервер" : "Совпадает — добавить"} onPress={confirm} busy={busy} />
          {inv.source === "manual" ? <Btn title="Не совпадает" kind="danger" onPress={reset} /> : null}
        </>
      ) : null}
    </Screen>
  );
}
