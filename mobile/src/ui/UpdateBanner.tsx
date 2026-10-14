/** «Доступна новая версия»: кластер сообщает свежую сборку приложения (control-plane /v1/app), ссылка — на релиз с APK. */
import Constants from "expo-constants";
import { useEffect, useState } from "react";
import { Linking } from "react-native";

import { isNewer, versionLabel } from "@/core/version";
import type { ClusterRecord } from "@/state/cluster";
import { openClusterSession } from "@/state/clusterSession";

import { Btn, Card, Row, Txt } from "./kit";
import { useTheme } from "./theme";

export function UpdateBanner({ clusters }: { clusters: ClusterRecord[] }) {
  const { p } = useTheme();
  const [upd, setUpd] = useState<{ latest: string; url: string } | null>(null);
  const [hidden, setHidden] = useState(false);
  const mine = Constants.expoConfig?.version;
  const ready = clusters.find((c) => c.status === "active" && c.certPem);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    openClusterSession(ready, ready.api)
      .then((s) => s.request<{ latest: string; url: string }>("GET", "/v1/app"))
      .then((r) => alive && isNewer(r.latest, mine) && r.url.startsWith("https://") && setUpd(r))
      .catch(() => {}); // нет связи — просто без подсказки
    return () => {
      alive = false;
    };
  }, [ready, mine]);

  if (!upd || hidden) return null;
  return (
    <Card accent={p.accent}>
      <Txt style={{ fontWeight: "700" }}>Доступна версия {versionLabel(upd.latest)}</Txt>
      <Txt kind="small">У вас {versionLabel(mine)}. Новая ставится поверх, данные и вход сохраняются.</Txt>
      <Row>
        <Btn small title="Скачать" onPress={() => Linking.openURL(upd.url)} />
        <Btn small kind="ghost" title="Позже" onPress={() => setHidden(true)} />
      </Row>
    </Card>
  );
}
