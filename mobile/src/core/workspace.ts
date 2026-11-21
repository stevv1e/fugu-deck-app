export const defaultWorkspaceRoute = (sid: string) => `/s/${sid}/chats`;

export function workspaceSid(pathname: string): string | null {
  const match = /^\/s\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match || pathname.startsWith(`/s/${match[1]}/login`)) return null;
  return match[1];
}

export function workspaceContextPath(pathname: string, tab?: string): string | null {
  if (!workspaceSid(pathname)) return null;
  const path = pathname.replace(/\/+$/, "");
  const suffix = pathname.endsWith("/prefs") && tab && ["models", "repos", "agents"].includes(tab) ? `?tab=${tab}` : "";
  return path + suffix;
}

export function safeWorkspaceRoute(sid: string, route?: string): string {
  const fallback = defaultWorkspaceRoute(sid);
  if (!route || route.length > 500 || route.includes("\\") || route.includes("#")) return fallback;
  const base = `/s/${sid}`;
  if (route !== base && !route.startsWith(base + "/")) return fallback;
  if (route.startsWith(base + "/login")) return fallback;
  const [path, query, extra] = route.split("?");
  if (extra !== undefined || (query && !["tab=models", "tab=repos", "tab=agents"].includes(query))) return fallback;
  return workspaceContextPath(path, query?.slice(4)) ?? fallback;
}
