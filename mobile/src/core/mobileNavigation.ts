import { appSection, appSectionPath } from "./navigation";

export type MobileSection = "chats" | "projects" | "models" | "more";

export function mobileSection(pathname: string): MobileSection {
  const section = appSection(pathname);
  if (section === "projects" || section === "servers") return "projects";
  if (section === "models") return "models";
  if (["parameters", "access", "permissions", "home"].includes(section)) return "more";
  return "chats";
}

export function showMobileNavigation(pathname: string): boolean {
  if (pathname === "/" || pathname.startsWith("/launch/") || pathname.startsWith("/teams/")) return false;
  if (/^\/s\/[^/]+\/c\/[^/]+/.test(pathname)) return false;
  return !["/add", "/scan", "/join", "/oauth"].includes(pathname) && !/^\/s\/[^/]+\/login/.test(pathname);
}

export function mobileSectionPath(section: MobileSection, sid?: string): string | null {
  if (section === "more") return null;
  if (!sid) return "/";
  if (section === "projects") return appSectionPath("projects", { sid });
  if (section === "models") return appSectionPath("models", { sid });
  return appSectionPath("chats", { sid });
}
