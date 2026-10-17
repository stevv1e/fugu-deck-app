/** Сервер и устройства: отпечаток, привязанные телефоны (отзыв — с биометрией), QR-приглашение, выход. */
import * as Clipboard from "expo-clipboard";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Share, View } from "react-native";

import type { DeviceRow } from "@/core/types";
import { useApi, useLoad } from "@/state/hooks";
import { useServers } from "@/state/servers";
import { Btn, Card, Chip, Divider, errText, Fingerprint, Loading, Notice, QrCode, Row, Screen, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";

const STORAGE: Record<string, string> = {
  secure_enclave: "Secure Enclave",
  strongbox: "StrongBox",
  tee: "TEE",
  tpm: "TPM",
  software: "программные",
};

const date = (ts?: number | null) => (ts ? new Date(ts * 1000).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "—");

export default function ServerSettings() {
  const { p } = useTheme();
  const { sid } = useLocalSearchParams<{ sid: string }>();
  const { get, signOut, remove } = useServers();
  const rec = get(sid);
  const { api, error: apiError } = useApi(sid);
  const devs = useLoad(useCallback(() => api?.devices() ?? null, [api]));
  const [invite, setInvite] = useState<{ link: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!rec) return <Screen title="Сервер">{null}</Screen>;
  const d = rec.device;
  const owner = d?.user.role === "owner";

  const revoke = async (dev: DeviceRow) => {
    if (!api) return;
    setBusy(dev.id);
    setError(null);
    try {
      await api.revokeDevice(dev.id, dev.name);
      await devs.reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const showInvite = async () => {
    if (!api) return;
    setBusy("invite");
    try {
      setInvite(await api.invite());
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen title="Сервер и устройства">
      {apiError ? <Notice text={apiError} /> : null}
      {error ? <Notice text={error} /> : null}

      <Card accent={p.accent}>
        <Txt kind="label">сервер</Txt>
        <Txt kind="h2">{rec.name}</Txt>
        <Txt kind="mono" color={p.dim} selectable>
          {rec.url}
        </Txt>
        <Row gap={6} style={{ flexWrap: "wrap" }}>
          <Chip text={rec.verifiedBy === "qr" ? "проверен по QR" : "сверен вручную"} color={p.accent} />
          <Chip text={`mTLS: ${rec.mtls}`} />
        </Row>
        <Txt kind="label" style={{ marginTop: 6 }}>
          закреплённый отпечаток
        </Txt>
        <Fingerprint fp={rec.fingerprint} />
      </Card>

      {d ? (
        <Card>
          <Txt kind="label">этот телефон</Txt>
          <Row style={{ justifyContent: "space-between" }}>
            <Txt>{d.user.display_name || d.user.username}</Txt>
            <Chip text={STORAGE[d.keyStorage]} color={d.keyStorage === "software" ? p.warn : p.ok} />
          </Row>
          <Txt kind="small">устройство {d.id} · привязано {new Date(d.enrolledAt).toLocaleDateString("ru-RU")}</Txt>
          {d.certPem ? <Txt kind="small">сертификат mTLS до {date(d.certExpires)} — продлевается автоматически</Txt> : null}
        </Card>
      ) : null}

      <Txt kind="label">привязанные устройства</Txt>
      {!devs.data && !devs.error ? <Loading /> : null}
      {devs.error ? <Notice text={devs.error} /> : null}
      {devs.data?.map((dev) => (
        <Card key={dev.id} accent={dev.revoked_at ? p.faint : dev.current ? p.ok : p.line2}>
          <Row style={{ justifyContent: "space-between" }}>
            <Txt style={{ fontWeight: "600", flex: 1 }} numberOfLines={1}>
              {dev.name}
            </Txt>
            {dev.current ? <Chip text="это устройство" color={p.ok} /> : dev.revoked_at ? <Chip text="отозвано" /> : null}
          </Row>
          <Txt kind="small">
            {dev.platform || "—"} · ключи: {STORAGE[dev.key_storage] || dev.key_storage} · был в сети {date(dev.last_seen)}
          </Txt>
          {!dev.current && !dev.revoked_at ? (
            <Btn title="Отозвать ⌁" kind="danger" small onPress={() => revoke(dev)} busy={busy === dev.id} style={{ alignSelf: "flex-start" }} />
          ) : null}
        </Card>
      ))}
      <Txt kind="small">Отзыв подписывается ключом подтверждения — понадобится биометрия. Отозванный телефон теряет доступ сразу.</Txt>

      {owner ? (
        <>
          <Divider />
          <Txt kind="label">пригласить на сервер</Txt>
          {invite ? (
            <Card style={{ alignItems: "center" }}>
              <QrCode value={invite.link} />
              <Txt kind="small" style={{ textAlign: "center" }}>
                Новый участник сканирует QR в приложении — адрес и отпечаток сервера проверятся автоматически. Логин и пароль ему выдаёте вы.
              </Txt>
              <Row style={{ flexWrap: "wrap" }}>
                <Btn title="Копировать ссылку" kind="ghost" small onPress={() => Clipboard.setStringAsync(invite.link)} />
                <Btn title="Поделиться" kind="ghost" small onPress={() => Share.share({ message: invite.link })} />
              </Row>
            </Card>
          ) : (
            <Btn title="Показать QR-приглашение" kind="ghost" onPress={showInvite} busy={busy === "invite"} />
          )}
        </>
      ) : null}

      <Divider />
      <View style={{ gap: 10 }}>
        {d ? (
          <Btn
            title="Выйти с этого телефона"
            kind="ghost"
            busy={busy === "out"}
            onPress={async () => {
              setBusy("out");
              await signOut(sid);
              router.replace(`/s/${sid}/login`);
            }}
          />
        ) : null}
        <Btn
          title="Удалить сервер из приложения"
          kind="danger"
          onPress={async () => {
            await signOut(sid).catch(() => {});
            await remove(sid);
            router.replace("/");
          }}
        />
        <Txt kind="small">Выход отзывает это устройство на сервере и удаляет его ключи с телефона.</Txt>
      </View>
    </Screen>
  );
}
