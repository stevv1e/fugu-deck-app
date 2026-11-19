/**
 * Агенты пространства: у каждого имя, модель, инструкции, доступы (репозитории, серверы, память, файлы, скилы) и
 * свои скилы. Чат ведёт один агент; на серверы агент входит под своим именем, и права на серверах у каждого свои.
 */
import { useCallback, useState } from "react";

import type { AgentApprovalAction, AgentApprovals, AgentTool, DeckApi, SpaceAgent } from "@/core/api";
import { APPROVAL_ACTIONS, APPROVAL_MODES } from "@/core/agentPolicies";
import { useLoad } from "@/state/hooks";

import { Btn, Card, Chip, errText, Field, Loading, Notice, Row, Txt } from "./kit";
import { useTheme } from "./theme";

const TOOLS: [AgentTool, string][] = [["git", "Репозитории"], ["ssh", "Серверы"], ["memory", "Память"], ["files", "Файлы"], ["skills", "Скилы"], ["mcp", "MCP"], ["web", "Сайты"], ["media", "Медиа"], ["drive", "Google Drive"]];
const APPROVALS: [AgentApprovals, string, string][] = [
  ["", "как на сервере", "по общей настройке сервера"],
  ["sign", "с подписью", "каждое изменение — «Разрешить» с биометрией"],
  ["tap", "без подписи", "«Разрешить» без биометрии — быстрее, но разрешить сможет любой, у кого открыт сеанс этого приложения"],
  ["dangerous", "только опасные", "изменения агент делает сам; опасные (удаление, новый репозиторий) — с подписью"],
  ["none", "без подтверждений", "агент делает всё сам — давайте так только агенту с узкими доступами"],
];
type Rules = NonNullable<SpaceAgent["approval_rules"]>;
type Draft = {
  id: string; name: string; model: string; instructions: string; tools: AgentTool[]; skills: string;
  approvals: AgentApprovals; approval_rules: Rules; isNew: boolean;
};

export function AgentsEditor({ api, canEdit, models }: { api: DeckApi; canEdit: boolean; models: string[] }) {
  const { p } = useTheme();
  const { data, error, reload } = useLoad(useCallback(() => api.agents(), [api]));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  const edit = (a?: SpaceAgent) => setDraft(a
    ? { id: a.id, name: a.name, model: a.model, instructions: a.instructions, tools: a.tools, skills: a.skills.join(", "), approvals: a.approvals ?? "", approval_rules: { ...(a.approval_rules ?? {}) }, isNew: false }
    : { id: "", name: "", model: "", instructions: "", tools: ["ssh", "files"], skills: "*", approvals: "", approval_rules: {}, isNew: true });
  const run = async (tag: string, fn: () => Promise<string>) => {
    setBusy(tag);
    setMsg(null);
    try {
      setMsg({ kind: "ok", text: await fn() });
      reload();
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    } finally {
      setBusy(null);
      setArmed(null);
    }
  };
  const save = () => draft && run("save", async () => {
    const skills = draft.skills.split(",").map((x) => x.trim()).filter(Boolean);
    await api.saveAgent(draft.id.trim(), {
      name: draft.name.trim(), model: draft.model, instructions: draft.instructions, tools: draft.tools, skills,
      approvals: draft.approvals, approval_rules: draft.approval_rules,
    });
    setDraft(null);
    return `Агент «${draft.name.trim()}» сохранён`;
  });
  const setRule = (action: AgentApprovalAction, value: AgentApprovals) => {
    if (draft) setDraft({ ...draft, approval_rules: { ...draft.approval_rules, [action]: value } });
  };
  const badId = draft?.isNew && !/^[a-z][a-z0-9-]{1,30}$/.test(draft.id.trim()) ? "id — латинские строчные буквы, цифры и дефис, с буквы (например, duty)" : null;
  const automatic = draft ? Object.values(draft.approval_rules).filter((v) => v === "none").length + (draft.approvals === "none" ? 1 : 0) : 0;

  if (!data && !error) return <Loading />;
  return (
    <>
      {error ? <Notice text={error} /> : null}
      {msg ? <Notice kind={msg.kind} text={msg.text} /> : null}
      <Txt kind="small">Чат ведёт один агент. Например, «дежурный» с доступом только к серверам и подтверждением каждой команды и «разработчик» с репозиториями и памятью.</Txt>
      {draft ? (
        <Card accent={p.accent}>
          <Txt kind="label">{draft.isNew ? "новый агент" : `агент ${draft.id}`}</Txt>
          {draft.isNew ? <Field label="id (латиницей, под ним агент входит на серверы)" value={draft.id} onChangeText={(id) => setDraft({ ...draft, id: id.toLowerCase() })} placeholder="duty" /> : null}
          <Field label="Имя" value={draft.name} onChangeText={(name) => setDraft({ ...draft, name })} maxLength={40} placeholder="Дежурный" />
          <Txt kind="label">модель</Txt>
          <Row gap={6} style={{ flexWrap: "wrap" }}>
            <Btn small title="как в чате" kind={!draft.model ? "primary" : "ghost"} onPress={() => setDraft({ ...draft, model: "" })} />
            {models.map((m) => <Btn key={m} small title={m.split(":").pop()!} kind={draft.model === m ? "primary" : "ghost"} onPress={() => setDraft({ ...draft, model: m })} />)}
          </Row>
          <Txt kind="label">доступы</Txt>
          <Row gap={6} style={{ flexWrap: "wrap" }}>
            {TOOLS.map(([t, title]) => {
              const on = draft.tools.includes(t);
              return <Btn key={t} small title={title} kind={on ? "primary" : "ghost"} onPress={() => setDraft({ ...draft, tools: on ? draft.tools.filter((x) => x !== t) : [...draft.tools, t] })} />;
            })}
          </Row>
          <Txt kind="label">подтверждения по умолчанию</Txt>
          <Row gap={6} style={{ flexWrap: "wrap" }}>
            {APPROVALS.map(([v, title]) => <Btn key={v || "server"} small title={title} kind={draft.approvals === v ? "primary" : "ghost"} onPress={() => setDraft({ ...draft, approvals: v })} />)}
          </Row>
          <Txt kind="small" color={draft.approvals === "none" || draft.approvals === "tap" ? p.warn : undefined}>
            {APPROVALS.find(([v]) => v === draft.approvals)?.[2]}.
          </Txt>
          <Txt kind="label">правила для отдельных действий</Txt>
          <Txt kind="small">Эти правила заменяют общий режим только для выбранного действия. «Кнопка» просит «Разрешить» без биометрии; «автоматически» выполняет действие сразу.</Txt>
          {automatic ? <Notice kind="warn" text="Часть действий будет выполняться без вашего участия. Проверьте доступы агента: автоматический коммит может менять основную ветку и удалять файлы." /> : null}
          {APPROVAL_ACTIONS.filter((action) => !action.access || draft.tools.includes(action.access)).map((action) => (
            <Card key={action.id} style={{ padding: 12, backgroundColor: p.bg2 }} accent={draft.approval_rules[action.id] === "none" ? p.warn : undefined}>
              <Txt style={{ fontWeight: "600" }}>{action.title}</Txt>
              <Txt kind="small">{action.description}</Txt>
              <Row gap={5} style={{ flexWrap: "wrap" }}>
                {APPROVAL_MODES.map(([value, title]) => {
                  const selected = (draft.approval_rules[action.id] ?? "") === value;
                  return <Btn key={value || "inherit"} small title={title} kind={selected ? value === "none" ? "danger" : "primary" : "ghost"} onPress={() => setRule(action.id, value)} />;
                })}
              </Row>
            </Card>
          ))}
          <Notice kind="info" text="Команды на серверах и создание или изменение агентов всегда требуют подписи — отдельные правила не могут их отключить." />
          <Field label="Инструкции" value={draft.instructions} onChangeText={(instructions) => setDraft({ ...draft, instructions })} multiline
            style={{ minHeight: 100, textAlignVertical: "top" }} placeholder="Ты дежурный: смотри журналы и состояние, ничего не меняй без просьбы." />
          {draft.tools.includes("skills") ? (
            <Field label="Скилы (через запятую; * — все)" value={draft.skills} onChangeText={(skills) => setDraft({ ...draft, skills })} />
          ) : null}
          {badId ? <Txt kind="small" color={p.warn}>{badId}</Txt> : null}
          <Row>
            <Btn title="Сохранить" onPress={save} busy={busy === "save"} disabled={!!badId || !draft.name.trim()} style={{ flex: 1 }} />
            <Btn title="Отмена" kind="ghost" onPress={() => setDraft(null)} style={{ flex: 1 }} />
          </Row>
        </Card>
      ) : canEdit ? <Btn title="+ Агент" kind="ghost" onPress={() => edit()} /> : null}
      {data?.map((a) => {
        const rules = Object.values(a.approval_rules ?? {}).filter(Boolean);
        const auto = rules.filter((v) => v === "none").length;
        return (
          <Card key={a.id} onPress={canEdit ? () => edit(a) : undefined}>
            <Row style={{ justifyContent: "space-between" }}>
              <Txt style={{ fontWeight: "600", flex: 1 }}>{a.name} <Txt kind="mono" color={p.dim}>{a.id}</Txt></Txt>
              {a.id === "fugu" ? <Chip text="по умолчанию" color={p.accent} /> : null}
            </Row>
            <Txt kind="small">{a.model ? a.model.split(":").pop() : "модель чата"} · {a.tools.length ? TOOLS.filter(([t]) => a.tools.includes(t)).map(([, n]) => n.toLowerCase()).join(", ") : "без доступов"}
              {a.approvals ? ` · подтверждения: ${APPROVALS.find(([v]) => v === a.approvals)?.[1]}` : ""}
              {rules.length ? ` · отдельных правил: ${rules.length}` : ""}{auto ? ` · авто: ${auto}` : ""}</Txt>
            {a.instructions ? <Txt kind="dim" numberOfLines={2}>{a.instructions}</Txt> : null}
            {canEdit && a.id !== "fugu" ? (
              armed === a.id ? (
                <Row style={{ flexWrap: "wrap" }}>
                  <Btn title="Да, удалить" small kind="danger" onPress={() => run(`rm:${a.id}`, async () => { await api.deleteAgent(a.id); return `Агент ${a.name} удалён; его чаты ведёт Fugu`; })} busy={busy === `rm:${a.id}`} />
                  <Btn title="Отмена" small kind="ghost" onPress={() => setArmed(null)} />
                </Row>
              ) : <Btn title="Удалить" small kind="ghost" onPress={() => setArmed(a.id)} style={{ alignSelf: "flex-start" }} />
            ) : null}
          </Card>
        );
      })}
      <Txt kind="small">Права агента на серверах — на экране серверов: у каждого агента свои.</Txt>
    </>
  );
}
