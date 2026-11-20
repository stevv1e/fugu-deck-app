import { appendModuleEvent, type ModuleSecurityEvent } from "@/core/security";
import { prefs } from "@/platform/storage";

export const MODULE_SECURITY_STORE = "fd:module-security-events";

export async function moduleEvents(): Promise<ModuleSecurityEvent[]> {
  const events = await prefs.get<ModuleSecurityEvent[]>(MODULE_SECURITY_STORE, []);
  return Array.isArray(events) ? events.slice(0, 500) : [];
}

export async function recordModuleEvent(input: Omit<ModuleSecurityEvent, "id" | "ts">): Promise<void> {
  const events = appendModuleEvent(await moduleEvents(), input);
  await prefs.set(MODULE_SECURITY_STORE, events);
}

export async function clearModuleEvents(): Promise<void> {
  await prefs.set(MODULE_SECURITY_STORE, []);
}
