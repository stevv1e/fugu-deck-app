/**
 * Перенос проекта: копия в другое пространство (или на другой сервер) и сохранение в файл. Копируются инструкции,
 * скилы и заметки базы знаний; чаты остаются на месте (формат fugu-deck-project/1).
 */
import { useState } from "react";

import type { DeckApi, ProjectExport } from "@/core/api";
import { listSpaces } from "@/core/teams";
import { saveText } from "@/platform/pick";
import { clusterOfSid, getCluster, spaceSid } from "@/state/cluster";
import { openClusterSession } from "@/state/clusterSession";
import { useServers } from "@/state/servers";

import { Btn, Card, errText, Notice, Row, Txt } from "./kit";

type Target = { sid: string; title: string };

export function ProjectTransfer({ sid, pid, name, api }: { sid: string; pid: string; name: string; api: DeckApi }) {
  const { servers, api: apiFor } = useServers();
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);

  const run = async (tag: string, fn: () => Promise<string | null>) => {
    setBusy(tag);
    setMsg(null);
    try {
      const done = await fn();
      if (done) setMsg({ kind: "ok", text: done });
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const open = () => run("list", async () => {
    const out: Target[] = [];
    const cid = clusterOfSid(sid);
    const c = cid ? await getCluster(cid) : null;
    if (c) {
      const spaces = await listSpaces(await openClusterSession(c, c.api));
      for (const s of spaces) {
        const t = spaceSid(c.id, s.kind === "team" ? s.id : null);
        if (t !== sid && s.exists && !s.delete_requested && (s.role === "owner" || s.role === "editor"))
          out.push({ sid: t, title: s.kind === "team" ? `${s.title} (общее)` : "Личное пространство" });
      }
    }
    for (const r of servers) if (r.id !== sid && r.device) out.push({ sid: r.id, title: r.name });
    setTargets(out);
    return out.length ? null : "Копировать некуда: других пространств, где вы редактор, нет";
  });

  const copyTo = (t: Target) => run(t.sid, async () => {
    const data = await api.exportProject(pid);
    const dst = await apiFor(t.sid);
    const p = await dst.importProject(data);
    setTargets(null);
    return `Проект скопирован в «${t.title}» как «${p.name}»: инструкции, скилы и ${data.memories.length} заметок. Чаты остались здесь.`;
  });

  const toFile = () => run("file", async () => {
    const data: ProjectExport = await api.exportProject(pid);
    const safe = name.replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 60) || "project";
    const ok = await saveText(`${safe}.fugu-deck.json`, "application/json", JSON.stringify(data, null, 2));
    return ok ? `Сохранено: ${safe}.fugu-deck.json (${data.memories.length} заметок)` : null;
  });

  return (
    <Card>
      <Txt kind="label">перенос проекта</Txt>
      <Txt kind="small">Копируются инструкции, скилы и заметки базы знаний. Чаты не копируются.</Txt>
      <Row gap={8} style={{ flexWrap: "wrap" }}>
        <Btn small kind="ghost" title="Копировать в пространство…" onPress={open} busy={busy === "list"} disabled={!!busy} />
        <Btn small kind="ghost" title="Сохранить в файл" onPress={toFile} busy={busy === "file"} disabled={!!busy} />
      </Row>
      {targets?.map((t) => (
        <Btn key={t.sid} small title={`→ ${t.title}`} onPress={() => copyTo(t)} busy={busy === t.sid} disabled={!!busy} />
      ))}
      {msg ? <Notice kind={msg.kind} text={msg.text} /> : null}
    </Card>
  );
}
