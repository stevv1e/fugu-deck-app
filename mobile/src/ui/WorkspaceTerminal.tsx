import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";

import type { ApprovalRequest, DeckApi } from "@/core/api";
import { argsHash } from "@/core/crypto";
import type { RunEvent } from "@/core/types";
import { prefs } from "@/platform/storage";
import { useLoad } from "@/state/hooks";
import { Btn, Card, Chip, Empty, errText, Field, Notice, Row, Txt } from "@/ui/kit";
import { MONO, useTheme } from "@/ui/theme";

export function WorkspaceTerminal({ api, cid }: { api: DeckApi; cid: string }) {
  const { p } = useTheme();
  const servers = useLoad(useCallback(() => api.terminalServers(cid), [api, cid]));
  const [server, setServer] = useState("");
  const [command, setCommand] = useState("");
  const [why, setWhy] = useState("");
  const [preview, setPreview] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [runId, setRunId] = useState("");
  const [pending, setPending] = useState<ApprovalRequest | null>(null);
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");
  const stream = useRef<{ close(): void } | null>(null);
  useEffect(() => { void prefs.get<string[]>(`fd:terminal-history:${cid}`, []).then(setHistory); }, [cid]);
  useEffect(() => () => stream.current?.close(), []);
  const effectiveServer = server || servers.data?.servers[0]?.id || "";

  const follow = (rid: string) => {
    setRunId(rid);
    stream.current = api.followRun(rid, (event: RunEvent) => {
      if (event.type === "approval_request") setPending(event);
      if (event.type === "approval_resolved") setPending(null);
      if (event.type === "terminal_result") {
        const result = event.result;
        setOutput(result.error || [result.stdout, result.stderr].filter(Boolean).join("\n"));
      }
      if (event.type === "error") setError(event.message);
    }, { onEnd: (err) => {
      setRunId("");
      setPending(null);
      stream.current = null;
      if (err) setError(errText(err));
      (globalThis as typeof globalThis & { fuguDesktop?: { notify?(title: string, body: string): void } }).fuguDesktop?.notify?.("Fugu Deck · терминал", "Команда завершена");
    } });
  };
  const execute = async () => {
    if (!effectiveServer || !command.trim() || runId) return;
    setError(""); setOutput(""); setPending(null);
    try {
      const next = [command.trim(), ...history.filter((x) => x !== command.trim())].slice(0, 20);
      setHistory(next); await prefs.set(`fd:terminal-history:${cid}`, next);
      const result = await api.terminalExec({ cid, server: effectiveServer, command: command.trim(), why: why.trim(), preview: preview.trim() || undefined });
      follow(result.run_id);
    } catch (e) { setError(errText(e)); }
  };
  const decide = async (approve: boolean) => {
    if (!pending) return;
    try { await api.approve(pending, approve, "", typed.trim()); setPending(null); }
    catch (e) { setError(errText(e)); }
  };
  const danger = pending?.sign?.type === "ssh_danger";
  const hashOk = !pending?.args_sha256 || pending.args_sha256 === argsHash(pending.args);

  return <View style={{ gap: 14 }}>
    <Card accent={p.accent}>
      <Txt kind="label">ssh gateway · одна команда за раз</Txt>
      <Txt kind="small">Чтение может идти без подтверждения, если владелец разрешил. Изменяющие и опасные команды требуют подписи именно этой команды ключом устройства.</Txt>
    </Card>
    {servers.error ? <Notice text={servers.error} /> : null}
    {servers.data && !servers.data.servers.length ? <Empty title="Нет доступных серверов" text="Выдайте агенту доступ в настройках серверов пространства." /> : null}
    <Row gap={6} style={{ flexWrap: "wrap" }}>{servers.data?.servers.map((item) => <Btn key={item.id} small kind={item.id === effectiveServer ? "primary" : "ghost"} title={item.name || item.id} onPress={() => setServer(item.id)} />)}</Row>
    <Field label="Команда" value={command} onChangeText={setCommand} placeholder="systemctl status my-service" multiline style={{ fontFamily: MONO }} />
    <Field label="Зачем (видно при подтверждении)" value={why} onChangeText={setWhy} placeholder="Проверить состояние сервиса" />
    <Field label="Безопасный пробный прогон (необязательно)" value={preview} onChangeText={setPreview} placeholder="Например, terraform plan" />
    <Row><Btn title="Выполнить через SSH Gateway" onPress={execute} disabled={!effectiveServer || !command.trim() || !!runId} style={{ flex: 1 }} />
      {runId ? <Btn kind="danger" title="Стоп" onPress={() => api.cancel(runId).catch((e) => setError(errText(e)))} /> : null}</Row>
    {pending ? <Card accent={p.warn}>
      <Row style={{ justifyContent: "space-between" }}><Txt kind="h2">Подтверждение команды</Txt><Chip text={danger ? "опасно" : "изменение"} color={danger ? p.accent2 : p.warn} /></Row>
      <Txt selectable style={{ fontFamily: MONO }}>{pending.sign?.command || String(pending.args.command || "")}</Txt>
      <Txt kind="small">Сервер: {pending.sign?.server} · аргументы: {hashOk ? "хэш совпадает" : "НЕ совпадают"}</Txt>
      {danger ? <Field label={`Введите имя сервера: ${pending.sign?.server}`} value={typed} onChangeText={setTyped} /> : null}
      <Row><Btn kind="ghost" title="Отклонить" onPress={() => decide(false)} style={{ flex: 1 }} /><Btn kind={danger ? "danger" : "ok"} title="Разрешить ⌁" onPress={() => decide(true)} disabled={!hashOk || (!!danger && typed.trim() !== pending.sign?.server)} style={{ flex: 1 }} /></Row>
    </Card> : null}
    {error ? <Notice text={error} /> : null}
    <Card><Txt kind="label">вывод</Txt><ScrollView style={{ maxHeight: 420 }}><Txt selectable style={{ fontFamily: MONO, fontSize: 12 }}>{output || (runId ? "Команда выполняется…" : "Вывод появится здесь.")}</Txt></ScrollView></Card>
    {history.length ? <Card><Txt kind="label">история на этом устройстве</Txt><Row gap={6} style={{ flexWrap: "wrap" }}>{history.map((item) => <Btn key={item} small kind="ghost" title={item} onPress={() => setCommand(item)} />)}</Row></Card> : null}
  </View>;
}
