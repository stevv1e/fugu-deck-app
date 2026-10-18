/** Окно компьютера: боковая панель слева, экран справа. При запуске открывает последнее пространство. */
import { router, usePathname } from "expo-router";
import { useEffect, useRef, type ReactNode } from "react";
import { View } from "react-native";

import { prefs } from "@/platform/storage";
import { useServers } from "@/state/servers";
import { useTheme } from "@/ui/theme";

import { Sidebar } from "./Sidebar";

export function Shell({ children }: { children: ReactNode }) {
  const { p } = useTheme();
  const path = usePathname();
  const { ready, get } = useServers();
  const started = useRef(false);
  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    if (path !== "/") return;
    void prefs.get<string | null>("fd.desk.sid", null).then((sid) => {
      if (sid && get(sid)?.device) router.replace(`/s/${sid}` as never);
    });
  }, [ready, path, get]);
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: p.bg }}>
      <Sidebar />
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
    </View>
  );
}
