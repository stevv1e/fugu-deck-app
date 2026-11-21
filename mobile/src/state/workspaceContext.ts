import { usePathname, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";

import { safeWorkspaceRoute, workspaceContextPath, workspaceSid } from "@/core/workspace";
import { prefs } from "@/platform/storage";

const KEY = "fd:workspace-context:v1";
let contexts: Record<string, string> = {};
let loaded: Promise<void> | null = null;
let writes: Promise<void> = Promise.resolve();

function ensureLoaded(): Promise<void> {
  if (!loaded) {
    loaded = prefs.get<Record<string, string>>(KEY, {}).then((value) => {
      contexts = value && typeof value === "object" ? value : {};
    });
  }
  return loaded;
}

export async function rememberWorkspaceContext(path: string | null): Promise<void> {
  if (!path) return;
  const sid = workspaceSid(path);
  if (!sid) return;
  await ensureLoaded();
  if (contexts[sid] === path) return;
  contexts = { ...contexts, [sid]: path };
  const snapshot = contexts;
  writes = writes.catch(() => {}).then(() => prefs.set(KEY, snapshot));
  await writes;
}

export async function recallWorkspaceContext(sid: string): Promise<string> {
  await ensureLoaded();
  return safeWorkspaceRoute(sid, contexts[sid]);
}

export function useRememberWorkspace(): void {
  const pathname = usePathname();
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  const path = workspaceContextPath(pathname, typeof tab === "string" ? tab : undefined);
  useEffect(() => {
    void rememberWorkspaceContext(path);
  }, [path]);
}
