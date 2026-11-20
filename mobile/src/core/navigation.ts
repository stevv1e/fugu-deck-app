export type AppSection = "home" | "chats" | "projects" | "models" | "servers" | "access" | "permissions" | "parameters";
export type SpaceKind = "standalone" | "cluster" | "team";

export type RouteInventoryItem = {
  match: string;
  section: AppSection;
  features: string;
};

export const ROUTE_INVENTORY: RouteInventoryItem[] = [
  { match: "/", section: "home", features: "Подключённые пространства, вход, регистрация, QR и приглашения" },
  { match: "/add,/scan,/join,/oauth,/s/[sid]/login", section: "home", features: "Добавление, авторизация, OAuth и pairing без рабочей навигации" },
  { match: "/launch/[sid]", section: "home", features: "Проверка сессии, запуск пространства, повтор и возврат в меню" },
  { match: "/s/[sid]/chats,/s/[sid]/c/[cid]", section: "chats", features: "Чаты, streaming, вложения, модели чата, отмена и подтверждения" },
  { match: "/s/[sid]/tasks", section: "chats", features: "Активные и завершённые запуски, уведомления и переходы в чат" },
  { match: "/s/[sid],/s/[sid]/p/[pid]", section: "projects", features: "Проекты, режимы, создание, импорт/экспорт, переименование и удаление" },
  { match: "/s/[sid]/kb/[pid],/s/[sid]/sched/[pid]", section: "projects", features: "База знаний, связи, предложения и расписания проекта" },
  { match: "/s/[sid]/workspace", section: "projects", features: "Файлы, Git diff, CI, запуски и ручной SSH Workspace" },
  { match: "/s/[sid]/prefs?tab=models", section: "models", features: "Каталог, провайдеры, избранное, роли, fallback и /models" },
  { match: "/s/[sid]/prefs?tab=repos", section: "projects", features: "GitHub/GitLab и репозитории проектов" },
  { match: "/servers/[cid],/s/[sid]/settings", section: "servers", features: "SSH-серверы, устройства сервера, отпечаток, отзыв и выход" },
  { match: "/keys/[cid]", section: "access", features: "AI/Git ключи, шифрование для keyguard, лимиты и удаление" },
  { match: "/mcp/[cid],/egress/[cid]", section: "access", features: "MCP endpoints и разрешённые домены" },
  { match: "/s/[sid]/prefs?tab=agents,/s/[sid]/skills", section: "permissions", features: "Права агентов, auto-write, опасные действия и скилы" },
  { match: "/cluster/[cid],/team/[sid],/teams/[cid]", section: "permissions", features: "Устройства, pairing, участники, роли и общие пространства" },
  { match: "/devices/[cid]", section: "permissions", features: "Подтверждение, отзыв и приглашение устройств" },
  { match: "/settings", section: "parameters", features: "Темы, уведомления, ключи приложения и сведения о сборке" },
  { match: "/modules", section: "parameters", features: "Каталог, конструктор, безопасность, экспорт и E2EE модулей" },
  { match: "/s/[sid]/usage", section: "parameters", features: "Расходы, участники и стоимость запусков" },
];

export const SECTION_LABELS: Record<AppSection, string> = {
  home: "Главное меню",
  chats: "Чаты",
  projects: "Проекты",
  models: "Модели",
  servers: "Сервера",
  access: "Доступы",
  permissions: "Разрешения",
  parameters: "Параметры",
};

export function appSection(pathname: string): AppSection {
  if (pathname === "/" || pathname === "/modules" || pathname === "/settings") {
    if (pathname === "/modules" || pathname === "/settings") return "parameters";
    return "home";
  }
  if (["/add", "/scan", "/join", "/oauth"].includes(pathname) || pathname.startsWith("/launch/") || /^\/s\/[^/]+\/login/.test(pathname)) return "home";
  if (pathname === "/modules" || pathname === "/settings" || pathname.includes("/usage")) return "parameters";
  if (pathname.startsWith("/keys/") || pathname.startsWith("/mcp/") || pathname.startsWith("/egress/")) return "access";
  if (pathname.startsWith("/servers/") || /\/settings$/.test(pathname)) return "servers";
  if (pathname.startsWith("/devices/") || pathname.startsWith("/cluster/") || pathname.startsWith("/team/") || pathname.startsWith("/teams/") || pathname.includes("/skills")) return "permissions";
  if (pathname.includes("/workspace") || /\/(p|kb|sched)\//.test(pathname) || /^\/s\/[^/]+$/.test(pathname)) return "projects";
  if (pathname.includes("/prefs")) return "models";
  if (pathname.includes("/tasks") || pathname.includes("/chats") || /\/c\//.test(pathname)) return "chats";
  return "chats";
}

export function appSectionPath(section: AppSection, o: { sid?: string; cluster?: string | null; kind?: SpaceKind } = {}): string {
  const { sid, cluster } = o;
  if (section === "home") return "/";
  if (section === "parameters") return "/settings";
  if (!sid) return "/";
  switch (section) {
    case "chats": return `/s/${sid}/chats`;
    case "projects": return `/s/${sid}`;
    case "models": return `/s/${sid}/prefs?tab=models`;
    case "servers": return cluster ? `/servers/${cluster}` : `/s/${sid}/settings`;
    case "access": return cluster ? `/keys/${cluster}` : `/s/${sid}/prefs?tab=models`;
    case "permissions":
      if (o.kind === "team") return `/team/${sid}`;
      return cluster ? `/cluster/${cluster}` : `/s/${sid}/prefs?tab=agents`;
  }
}

export const appModulesPath = () => "/modules";
