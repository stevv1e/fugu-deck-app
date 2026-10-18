import "@/platform/polyfill";

import * as Notifications from "expo-notifications";
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { routeFor, startPush } from "@/platform/push";
import { ServersProvider } from "@/state/servers";
import { ThemeProvider, useTheme } from "@/ui/theme";

function Themed() {
  const { p } = useTheme();
  return (
    <>
      <StatusBar style={p.dark ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: p.bg }, animation: "slide_from_right" }} />
    </>
  );
}

/** Уведомления: токен — кластерам при запуске; нажатие на уведомление — в нужный чат. */
function PushRouter() {
  const last = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    let stop: (() => void) | undefined;
    startPush().then((f) => (stop = f), () => {});
    return () => stop?.();
  }, []);
  useEffect(() => {
    const id = last?.notification.request.identifier;
    if (!last || !id || handled.current === id) return;
    handled.current = id;
    routeFor(last.notification.request.content.data as Record<string, unknown>).then((to) => {
      if (to) router.push(to as never);
      Notifications.clearLastNotificationResponse();
    }, () => {});
  }, [last]);
  return null;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ServersProvider>
          <Themed />
          <PushRouter />
        </ServersProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
