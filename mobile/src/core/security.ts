export type ModuleSecurityEvent = {
  id: string;
  ts: number;
  module: string;
  action: "install" | "update" | "remove" | "enable" | "disable" | "storage.get" | "storage.set" | "network.get" | "rate_limit" | "publish" | "import";
  ok: boolean;
  details: string;
};

export function appendModuleEvent(events: ModuleSecurityEvent[], input: Omit<ModuleSecurityEvent, "id" | "ts">, now = Date.now()): ModuleSecurityEvent[] {
  const event: ModuleSecurityEvent = {
    ...input, id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 9)}`, ts: now,
    module: input.module.slice(0, 80), details: input.details.slice(0, 500),
  };
  return [event, ...events].slice(0, 500);
}
