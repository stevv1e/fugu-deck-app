/**
 * Push-уведомления (FCM напрямую, без сервиса Expo). Токен устройства отдаётся control-plane каждого кластера; он
 * рассылает уведомления: агент ждёт подтверждения, агент ответил, новое устройство. В уведомлении нет текста
 * переписки — только тип и куда вести; нажатие открывает нужный чат.
 */
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";

import { pushRoute } from "@/core/pushRoute";
import { listClusters, spaceSid, type ClusterRecord } from "@/state/cluster";
import { openClusterSession } from "@/state/clusterSession";

const CHANNEL = "agent";

// Приложение открыто — уведомление не показываем: человек и так видит чат.
Notifications.setNotificationHandler({
  handleNotification: async () => {
    const open = AppState.currentState === "active";
    return { shouldShowBanner: !open, shouldShowList: !open, shouldPlaySound: !open, shouldSetBadge: false };
  },
});

export type PushStatus = "on" | "off" | "denied" | "unavailable";

async function ensureChannel() {
  if (Platform.OS === "android") {
    // Канал до запроса токена: на Android 13+ без канала система не покажет запрос разрешения.
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: "Агент", importance: Notifications.AndroidImportance.HIGH, vibrationPattern: [0, 200, 120, 200],
    });
  }
}

export async function pushStatus(): Promise<PushStatus> {
  if (Platform.OS === "web") return "unavailable";
  const p = await Notifications.getPermissionsAsync();
  return p.granted ? "on" : p.canAskAgain ? "off" : "denied";
}

/** Запросить разрешение (если ещё не дано) и отдать токен всем подтверждённым кластерам. */
export async function enablePush(ask = true): Promise<PushStatus> {
  if (Platform.OS === "web") return "unavailable";
  await ensureChannel();
  let p = await Notifications.getPermissionsAsync();
  if (!p.granted && ask && p.canAskAgain) p = await Notifications.requestPermissionsAsync();
  if (!p.granted) return p.canAskAgain ? "off" : "denied";
  const tok = await Notifications.getDevicePushTokenAsync();
  await registerToken(String(tok.data));
  return "on";
}

async function registerToken(token: string, only?: ClusterRecord[]) {
  for (const c of only ?? (await listClusters())) {
    if (c.status !== "active" || !c.certPem) continue;
    try {
      const s = await openClusterSession(c, c.api);
      await s.request("POST", "/v1/push/token", { token });
    } catch {
      // кластер недоступен — отдадим при следующем запуске
    }
  }
}

/** При запуске: если разрешение уже есть — обновить токен на кластерах и следить за его сменой. */
export async function startPush(): Promise<() => void> {
  if (Platform.OS === "web") return () => {};
  const sub = Notifications.addPushTokenListener((t) => void registerToken(String(t.data)));
  if ((await pushStatus()) === "on") void enablePush(false).catch(() => {});
  return () => sub.remove();
}

/** Куда вести по нажатию (core/pushRoute.ts). */
export async function routeFor(data: Record<string, unknown> | undefined): Promise<string | null> {
  return pushRoute(data, await listClusters(), spaceSid);
}
