import { useCallback, useEffect, useState } from "react";

import { modulePermissions, type InstalledModule } from "@/core/modules";
import type { ModuleSecurityEvent } from "@/core/security";
import { clearModuleEvents, moduleEvents } from "@/platform/moduleAudit";
import { useServers } from "@/state/servers";
import { Btn, Card, Chip, Empty, errText, Loading, Notice, Row, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";

type ServerAudit = { id: number; ts: number; tool: string; approved: boolean | null; ok: boolean; summary: string };

export function ModuleSecurity({ installed, onToggle }: { installed: InstalledModule[]; onToggle(id: string, enabled: boolean): Promise<void> }) {
  const { p } = useTheme();
  const { servers, api } = useServers();
  const server = servers.find((item) => item.device);
  const [events, setEvents] = useState<ModuleSecurityEvent[] | null>(null);
  const [serverAudit, setServerAudit] = useState<ServerAudit[]>([]);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setEvents(await moduleEvents());
    if (server) {
      try { setServerAudit(await (await api(server.id)).audit()); }
      catch (e) { setError(`Локальный журнал доступен; серверный: ${errText(e)}`); }
    }
  }, [api, server]);
  useEffect(() => {
    const timer = setTimeout(() => { void refresh(); }, 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  return <>
    <Card accent={p.accent}>
      <Row style={{ justifyContent: "space-between", flexWrap: "wrap" }}><Txt kind="h2">Центр безопасности</Txt><Btn small kind="ghost" title="Обновить" onPress={() => void refresh()} /></Row>
      <Txt kind="small">Локальные установки, обновления и RPC модулей вместе с серверным журналом действий агента и моделей. Сетевые запросы не содержат тела ответа или API-ключи.</Txt>
      <Row style={{ flexWrap: "wrap" }}><Chip text="60 RPC / мин" color={p.accent} /><Chip text="ответ ≤ 100 КБ" color={p.accent} /><Chip text="storage ≤ 50 КБ" color={p.accent} /><Chip text="события ≤ 500" color={p.accent} /></Row>
    </Card>
    {error ? <Notice kind="warn" text={error} /> : null}
    <Txt kind="label">разрешения и блокировки</Txt>
    {installed.map((module) => <Card key={module.manifest.id} accent={module.enabled ? p.ok : p.warn}>
      <Row style={{ justifyContent: "space-between", flexWrap: "wrap" }}><Txt kind="h2">{module.manifest.name}</Txt><Chip text={module.enabled ? "разрешён" : "заблокирован"} color={module.enabled ? p.ok : p.warn} /></Row>
      <Txt kind="mono">{module.manifest.id} · {module.manifest.version}</Txt>
      {modulePermissions(module.manifest).map((permission) => <Txt key={permission} kind="small">• {permission}</Txt>)}
      <Btn small kind="ghost" title={module.enabled ? "Заблокировать выполнение" : "Снять блокировку"} onPress={() => void onToggle(module.manifest.id, !module.enabled).then(refresh)} style={{ alignSelf: "flex-start" }} />
    </Card>)}
    {!installed.length ? <Empty title="Нет установленных модулей" /> : null}
    <Row style={{ justifyContent: "space-between" }}><Txt kind="label">журнал модулей</Txt><Btn small kind="ghost" title="Очистить локальный журнал" onPress={() => void clearModuleEvents().then(refresh)} /></Row>
    {!events ? <Loading /> : null}
    {events?.map((event) => <Card key={event.id} accent={event.ok ? p.line2 : p.accent2}>
      <Row style={{ justifyContent: "space-between", flexWrap: "wrap" }}><Txt kind="mono">{event.module} · {event.action}</Txt><Chip text={event.ok ? "ok" : "отклонено"} color={event.ok ? p.ok : p.accent2} /></Row>
      <Txt kind="small">{new Date(event.ts).toLocaleString()} · {event.details}</Txt>
    </Card>)}
    {events && !events.length ? <Empty title="Событий модулей пока нет" /> : null}
    <Txt kind="label">действия агента и моделей на сервере</Txt>
    {serverAudit.map((event) => <Card key={event.id} accent={event.ok ? p.line2 : p.accent2}>
      <Row style={{ justifyContent: "space-between", flexWrap: "wrap" }}><Txt kind="mono">{event.tool}</Txt><Chip text={event.approved === null ? "без согласования" : event.approved ? "подтверждено" : "отклонено"} color={event.ok ? p.ok : p.accent2} /></Row>
      <Txt kind="small">{new Date(event.ts * 1000).toLocaleString()} · {event.summary || (event.ok ? "успешно" : "ошибка")}</Txt>
    </Card>)}
    {!server ? <Txt kind="dim">Подключите пространство, чтобы увидеть серверный журнал.</Txt> : null}
    {server && !serverAudit.length ? <Empty title="Серверных событий пока нет" /> : null}
  </>;
}
