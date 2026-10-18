import "@/platform/polyfill";

import * as Notifications from "expo-notifications";
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { Shell } from "@/desktop/Shell";
import { useWide } from "@/desktop/wide";
import { isDesktop, onDeepLink } from "@/platform/desktop";
import { routeFor, startPush } from "@/platform/push";
import { ServersProvider } from "@/state/servers";
import { ThemeProvider, useTheme } from "@/ui/theme";

function Themed() {
  const { p } = useTheme();
  // широкое окно (компьютер): боковая панель и экран справа, без анимации перехода
  const wide = useWide();
  const stack = <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: p.bg }, animation: wide ? "none" : "slide_from_right" }} />;
  return (
    <>
      <StatusBar style={p.dark ? "light" : "dark"} />
      {wide ? <Shell>{stack}</Shell> : stack}
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

/** Windows: приглашение fugudeck://join?… (из браузера или по ссылке) открывает вход в кластер. */
function DesktopLinks() {
  useEffect(() => onDeepLink((url) => {
    const m = /^fugudeck:\/\/join\?(.*)$/.exec(url);
    if (m) router.push(`/join?${m[1]}` as never);
  }), []);
  return null;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ServersProvider>
          <Themed />
          {/* push — только на телефоне: в браузере expo-notifications не работает */}
          {isDesktop ? <DesktopLinks /> : Platform.OS === "web" ? null : <PushRouter />}
        </ServersProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
