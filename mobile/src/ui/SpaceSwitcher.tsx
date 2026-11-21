import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { listSpaces, PHASE_NAMES as PHASE } from "@/core/teams";
import { listClusters, spaceSid } from "@/state/cluster";
import { openClusterSession } from "@/state/clusterSession";
import { useServers } from "@/state/servers";
import { recallWorkspaceContext } from "@/state/workspaceContext";

import { Chip, IconBtn, Loading, Notice, Txt } from "./kit";
import { alpha, useTheme } from "./theme";

type Target = {
  sid: string;
  title: string;
  subtitle: string;
  phase?: string;
  unavailable?: boolean;
};

export function SpaceSwitcher({ visible, currentSid, onClose }: { visible: boolean; currentSid?: string; onClose(): void }) {
  const { p } = useTheme();
  const { servers } = useServers();
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (!alive) return;
      setTargets(null);
      setError(null);
      const out: Target[] = servers.filter((s) => s.device).map((s) => ({
        sid: s.id, title: s.name, subtitle: new URL(s.url).host,
      }));
      const clusters = await listClusters();
      const errors: string[] = [];
      await Promise.all(clusters.filter((c) => c.status === "active" && c.certPem).map(async (c) => {
        try {
          const spaces = await listSpaces(await openClusterSession(c, c.api));
          out.push(...spaces.map((s) => ({
            sid: spaceSid(c.id, s.kind === "team" ? s.id : null),
            title: s.kind === "personal" ? "Личное пространство" : s.title,
            subtitle: `${new URL(c.api).host} · ${s.kind === "personal" ? c.user : "общее"}`,
            phase: !s.exists ? "не создано" : PHASE[s.phase ?? ""] ?? "создаётся",
            unavailable: s.delete_requested || s.phase === "Failed",
          })));
        } catch {
          errors.push(new URL(c.api).host);
        }
      }));
      if (!alive) return;
      out.sort((a, b) => a.title.localeCompare(b.title, "ru"));
      setTargets(out);
      if (errors.length) setError(`Не удалось загрузить пространства: ${errors.join(", ")}`);
    })();
    return () => { alive = false; };
  }, [visible, servers]);

  const select = async (target: Target) => {
    if (opening || target.unavailable) return;
    setOpening(target.sid);
    try {
      const next = await recallWorkspaceContext(target.sid);
      onClose();
      router.push({ pathname: "/launch/[sid]", params: { sid: target.sid, next } });
    } finally {
      setOpening(null);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Закрыть выбор пространства" />
        <View style={[styles.dialog, { backgroundColor: p.bg2, borderColor: p.line2 }]}>
          <View style={[styles.header, { borderBottomColor: p.line }]}>
            <View style={{ flex: 1 }}>
              <Txt kind="h2">Сменить пространство</Txt>
              <Txt kind="small">Вернёмся к последнему открытому месту</Txt>
            </View>
            <IconBtn glyph="×" label="Закрыть" onPress={onClose} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.list}>
            {error ? <Notice text={error} /> : null}
            {!targets && !error ? <Loading text="Загружаем пространства…" /> : null}
            {targets?.map((target) => {
              const current = target.sid === currentSid;
              return (
                <Pressable key={target.sid} disabled={target.unavailable} onPress={() => select(target)} accessibilityRole="button" accessibilityState={{ selected: current, disabled: target.unavailable }}
                  style={({ pressed }) => [styles.item, { backgroundColor: pressed ? p.panel2 : current ? alpha(p.accent, 0.09) : p.panel, borderColor: current ? alpha(p.accent, 0.4) : p.line, opacity: target.unavailable ? 0.5 : 1 }]}>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Txt numberOfLines={1} style={{ fontWeight: "600" }}>{target.title}</Txt>
                    <Txt kind="small" numberOfLines={1}>{target.subtitle}</Txt>
                  </View>
                  {target.phase ? <Chip text={target.phase} color={target.phase === "готово" ? p.ok : p.dim} /> : null}
                  {current ? <Chip text="текущее" color={p.accent} /> : null}
                  <Text style={{ color: p.accent }}>{opening === target.sid ? "…" : "→"}</Text>
                </Pressable>
              );
            })}
            {targets?.length === 0 ? <Txt kind="dim" style={styles.empty}>Нет подключённых пространств.</Txt> : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20 },
  backdrop: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.66)" },
  dialog: { width: "100%", maxWidth: 570, maxHeight: "78%", borderWidth: 1, borderRadius: 16, overflow: "hidden" },
  header: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16, borderBottomWidth: 1 },
  list: { padding: 10, gap: 7 },
  item: { minHeight: 65, flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderWidth: 1, borderRadius: 10 },
  empty: { textAlign: "center", padding: 22 },
});
