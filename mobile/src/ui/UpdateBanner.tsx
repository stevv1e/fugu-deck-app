/** Stable/beta-обновления и явный откат Windows по отдельно подписанным manifest. */
import Constants from "expo-constants";
import { useEffect, useState } from "react";
import { Linking, Platform } from "react-native";

import { isNewer, versionLabel } from "@/core/version";
import type { UpdateChannel } from "@/core/updateManifest";
import { desktopAvailable, desktopCancelUpdate, desktopDownloadUpdate, desktopInstallUpdate, onDesktopUpdateProgress } from "@/platform/desktop";
import { prefs } from "@/platform/storage";
import { cancelAndroidUpdate, downloadAndroidUpdate, installAndroidUpdate } from "@/platform/update";
import type { ClusterRecord } from "@/state/cluster";
import { openClusterSession } from "@/state/clusterSession";

import { Btn, Card, Chip, Row, Txt } from "./kit";
import { useTheme } from "./theme";

type Releases = { latest: string; url: string; beta?: string; beta_url?: string; previous?: string; previous_url?: string };
type Downloaded = { id: string; size: number; version: string; mode: "upgrade" | "rollback" };
const CHANNEL_KEY = "fd.update.channel";

export function UpdateBanner({ clusters }: { clusters: ClusterRecord[] }) {
  const { p } = useTheme();
  const [releases, setReleases] = useState<Releases | null>(null);
  const [channel, setChannel] = useState<UpdateChannel>("stable");
  const [ready, setReady] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState<"upgrade" | "rollback" | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [downloaded, setDownloaded] = useState<Downloaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mine = Constants.expoConfig?.version;
  const activeCluster = clusters.find((c) => c.status === "active" && c.certPem);

  useEffect(() => {
    let alive = true;
    prefs.get<UpdateChannel>(CHANNEL_KEY, "stable").then((value) => {
      if (!alive) return;
      setChannel(value === "beta" ? "beta" : "stable");
      setReady(true);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!activeCluster || !ready) return;
    let alive = true;
    openClusterSession(activeCluster, activeCluster.api)
      .then((s) => s.request<Releases>("GET", "/v1/app"))
      .then((r) => alive && r.url.startsWith("https://") && setReleases(r))
      .catch(() => {});
    return () => { alive = false; };
  }, [activeCluster, ready]);

  useEffect(() => {
    if (!desktopAvailable()) return;
    return onDesktopUpdateProgress(setProgress);
  }, []);

  if (!releases || hidden) return null;
  const betaPublished = !!(releases.beta && releases.beta_url?.startsWith("https://"));
  const target = channel === "beta" && betaPublished
    ? { latest: releases.beta!, url: releases.beta_url! }
    : { latest: releases.latest, url: releases.url };
  const updateAvailable = isNewer(target.latest, mine);
  const rollbackAvailable = desktopAvailable() && !!(releases.previous && mine && isNewer(mine, releases.previous));
  const percent = progress && progress.total > 0 ? Math.round(progress.done / progress.total * 100) : 0;

  const chooseChannel = (next: UpdateChannel) => {
    setChannel(next);
    void prefs.set(CHANNEL_KEY, next);
    setError(null);
    setDownloaded(null);
    setHidden(false);
  };

  const start = async (mode: "upgrade" | "rollback") => {
    if (busy) return;
    const version = mode === "rollback" ? releases.previous : target.latest;
    if (!version) return;
    setBusy(mode);
    setError(null);
    setDownloaded(null);
    setProgress(null);
    try {
      if (desktopAvailable()) {
        const result = await desktopDownloadUpdate(version, { channel: mode === "rollback" ? "stable" : channel, mode });
        setDownloaded({ ...result, mode });
      } else if (Platform.OS === "android" && mine && mode === "upgrade") {
        const result = await downloadAndroidUpdate(version, mine, (done, total) => setProgress({ done, total }), channel);
        setDownloaded({ ...result, mode });
      } else {
        return await Linking.openURL(mode === "rollback" ? releases.previous_url! : target.url);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    if (!downloaded) return;
    setError(null);
    try {
      if (desktopAvailable()) await desktopInstallUpdate(downloaded.id);
      else installAndroidUpdate(downloaded.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Card accent={updateAvailable || channel === "beta" ? p.accent : undefined}>
      <Row style={{ justifyContent: "space-between" }}>
        <Txt style={{ fontWeight: "700" }}>{updateAvailable ? `Доступна версия ${versionLabel(target.latest)}` : "Обновления приложения"}</Txt>
        <Chip text={channel} color={channel === "beta" ? p.warn : p.ok} />
      </Row>
      <Row>
        <Btn small kind={channel === "stable" ? "primary" : "ghost"} title="Stable" onPress={() => chooseChannel("stable")} disabled={!!busy} />
        <Btn small kind={channel === "beta" ? "primary" : "ghost"} title="Beta" onPress={() => chooseChannel("beta")} disabled={!!busy} />
      </Row>
      {channel === "beta" && !betaPublished ? <Txt kind="small">Beta пока не опубликована — используется последняя stable-версия.</Txt> : null}
      <Txt kind="small">
        {updateAvailable
          ? `У вас ${versionLabel(mine)}. Обновление сохранит ключи устройств, серверы, пространства, чаты и настройки.`
          : `Установлена актуальная версия ${versionLabel(mine)} для выбранного канала.`}
      </Txt>
      {rollbackAvailable ? <Txt kind="small">Восстановление Windows: stable {releases.previous} установится поверх текущей версии после отдельного подтверждения.</Txt> : null}
      {busy ? <Txt kind="small" color={p.accent}>{busy === "rollback" ? "Скачивание предыдущей версии" : "Скачивание и проверка подписи"}: {percent}%</Txt> : null}
      {downloaded ? <Txt kind="small" color={p.ok}>Пакет {downloaded.version} скачан и проверен. {downloaded.mode === "rollback" ? "Подтвердите восстановление." : "Перезапуск можно отложить."}</Txt> : null}
      {error ? <Txt kind="small" color={p.accent2}>{error}</Txt> : null}
      <Row style={{ flexWrap: "wrap" }}>
        {downloaded ? (
          <Btn small kind={downloaded.mode === "rollback" ? "danger" : "primary"} title={downloaded.mode === "rollback" ? "Восстановить и перезапустить" : "Установить и перезапустить"} onPress={() => void install()} />
        ) : updateAvailable ? (
          <Btn small title={busy === "upgrade" ? "Скачивается…" : "Скачать обновление"} busy={busy === "upgrade"} disabled={!!busy} onPress={() => void start("upgrade")} />
        ) : null}
        {!downloaded && rollbackAvailable ? <Btn small kind="ghost" title={busy === "rollback" ? "Скачивается…" : `Откат на ${releases.previous}`} disabled={!!busy} onPress={() => void start("rollback")} /> : null}
        {busy ? <Btn small kind="ghost" title="Отмена" onPress={() => void (desktopAvailable() ? desktopCancelUpdate() : cancelAndroidUpdate())} /> : null}
        {!busy ? <Btn small kind="ghost" title="Скрыть" onPress={() => setHidden(true)} /> : null}
      </Row>
    </Card>
  );
}
