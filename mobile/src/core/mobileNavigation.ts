export type MobileSection = "chats" | "workspace" | "tasks" | "modules" | "more";

const MORE_PATHS = ["/settings", "/prefs", "/skills", "/usage", "/team/", "/teams/", "/cluster/", "/servers/", "/devices/", "/keys/", "/mcp/", "/egress/"];

export function mobileSection(pathname: string): MobileSection {
  if (pathname === "/modules") return "modules";
  if (pathname.includes("/workspace")) return "workspace";
  if (pathname.includes("/tasks")) return "tasks";
  if (MORE_PATHS.some((part) => pathname === part || pathname.includes(part))) return "more";
  return "chats";
}

export function showMobileNavigation(pathname: string): boolean {
  if (/^\/s\/[^/]+\/c\/[^/]+/.test(pathname)) return false;
  return !["/add", "/scan", "/join", "/oauth"].includes(pathname) && !/^\/s\/[^/]+\/login/.test(pathname);
}

export function mobileSectionPath(section: MobileSection, sid?: string): string | null {
  if (section === "modules") return "/modules";
  if (section === "more") return null;
  if (!sid) return "/";
  if (section === "workspace") return `/s/${sid}/workspace`;
  if (section === "tasks") return `/s/${sid}/tasks`;
  return `/s/${sid}/chats`;
}
