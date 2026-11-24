/** Обновление по подписанному manifest: фоновая загрузка, проверка целостности и установка с согласия пользователя. */
import Constants from "expo-constants";
import { useEffect, useState } from "react";
import { Linking, Platform } from "react-native";

import { isNewer, versionLabel } from "@/core/version";
import { desktopAvailable, desktopCancelUpdate, desktopDownloadUpdate, desktopInstallUpdate, onDesktopUpdateProgress } from "@/platform/desktop";
import { cancelAndroidUpdate, downloadAndroidUpdate, installAndroidUpdate } from "@/platform/update";
import type { ClusterRecord } from "@/state/cluster";
import { openClusterSession } from "@/state/clusterSession";

import { Btn, Card, Row, Txt } from "./kit";
import { useTheme } from "./theme";

export function UpdateBanner({ clusters }: { clusters: ClusterRecord[] }) {
  const { p } = useTheme();
  const [upd, setUpd] = useState<{ latest: string; url: string } | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [downloaded, setDownloaded] = useState<{ id: string; size: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mine = Constants.expoConfig?.version;
  const activeCluster = clusters.find((c) => c.status === "active" && c.certPem);

  useEffect(() => {
    if (!activeCluster) return;
    let alive = true;
    openClusterSession(activeCluster, activeCluster.api)
      .then((s) => s.request<{ latest: string; url: string }>("GET", "/v1/app"))
      .then((r) => alive && isNewer(r.latest, mine) && r.url.startsWith("https://") && setUpd(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [activeCluster, mine]);

  useEffect(() => {
    if (!desktopAvailable()) return;
    return onDesktopUpdateProgress(setProgress);
  }, []);

  if (!upd || hidden) return null;
  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDownloaded(null);
    try {
      if (desktopAvailable()) setDownloaded(await desktopDownloadUpdate(upd.latest));
      else if (Platform.OS === "android" && mine) setDownloaded(await downloadAndroidUpdate(upd.latest, mine, (done, total) => setProgress({ done, total })));
      else return await Linking.openURL(upd.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
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
  const percent = progress && progress.total > 0 ? Math.round(progress.done / progress.total * 100) : 0;

  return (
    <Card accent={p.accent}>
      <Txt style={{ fontWeight: "700" }}>Доступна версия {versionLabel(upd.latest)}</Txt>
      <Txt kind="small">У вас {versionLabel(mine)}. Обновление ставится поверх; ключи устройств, серверы, пространства, чаты и настройки сохраняются.</Txt>
      {busy ? <Txt kind="small" color={p.accent}>Скачивание и проверка подписи: {percent}%</Txt> : null}
      {downloaded ? <Txt kind="small" color={p.ok}>Пакет скачан и проверен. Перезапуск можно отложить.</Txt> : null}
      {error ? <Txt kind="small" color={p.accent2}>{error}</Txt> : null}
      <Row>
        {downloaded ? <Btn small title="Установить и перезапустить" onPress={() => void install()} /> : <Btn small title={busy ? "Скачивается…" : "Скачать обновление"} busy={busy} disabled={busy} onPress={() => void start()} />}
        {busy && Platform.OS === "android" ? <Btn small kind="ghost" title="Отмена" onPress={() => void (desktopAvailable() ? desktopCancelUpdate() : cancelAndroidUpdate())} /> : null}
        {!busy ? <Btn small kind="ghost" title="Позже" onPress={() => setHidden(true)} /> : null}
      </Row>
    </Card>
  );
}
