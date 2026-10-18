/**
 * MCP-серверы владельца: их инструменты получает агент личного пространства (доступ «MCP» в настройках агента).
 * Адрес и токен уходят в keyguard подписанным действием; токен шифруется на телефоне и виден только keyguard.
 * Вызовы, которые сервер не пометил «только чтение», агент выполняет после вашего подтверждения.
 */
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";

import { deleteMcp, listMcp, mcpIdFrom, mcpUrlProblem, putMcp, type McpServer } from "@/core/mcp";
import { keyProvider } from "@/platform/keys";
import { getCluster, type ClusterRecord } from "@/state/cluster";
import { openClusterSession } from "@/state/clusterSession";
import { Btn, Card, Chip, errText, Field, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";
import { DEV } from "@/platform/desktop";

export default function Mcp() {
  const { cid } = useLocalSearchParams<{ cid: string }>();
  const { p } = useTheme();
  const [rec, setRec] = useState<ClusterRecord | null>(null);
  const [list, setList] = useState<McpServer[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [armed, setArmed] = useState<string | null>(null);

  const load = useCallback(async (r: ClusterRecord) => {
    try {
      setList((await listMcp(await openClusterSession(r, r.api))).servers);
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
      setList([]);
    }
  }, []);

  useEffect(() => {
    getCluster(cid).then((r) => {
      setRec(r);
      if (r) void load(r);
    });
  }, [cid, load]);

  const keysOf = async (r: ClusterRecord) => {
    const k = await (await keyProvider()).load(r.alias);
    if (!k) throw new Error("Ключи устройства не найдены — зарегистрируйтесь заново по приглашению");
    return k;
  };
  const run = async (tag: string, fn: (r: ClusterRecord) => Promise<string>) => {
    if (!rec) return;
    setBusy(tag);
    setMsg(null);
    try {
      const done = await fn(rec);
      await load(rec);
      setMsg({ kind: "ok", text: done });
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    } finally {
      setBusy(null);
      setArmed(null);
    }
  };

  const urlBad = url.trim() ? mcpUrlProblem(url) : null;
  const add = () => run("add", async (r) => {
    const id = mcpIdFrom(name || new URL(url.trim()).hostname.split(".")[0]);
    const out = await putMcp(await openClusterSession(r, r.api), await keysOf(r), r.hpke, { id, name: name || id, url, token });
    setName("");
    setUrl("");
    setToken("");
    return `Сервер «${out.name}» подключён${out.has_token ? ", токен видит только keyguard" : ""}. Агент увидит его инструменты в новом сообщении.`;
  });
  const remove = (id: string) => run(`rm:${id}`, async (r) => {
    await deleteMcp(await openClusterSession(r, r.api), await keysOf(r), id);
    return "Сервер отключён";
  });

  if (!rec || list === null) return <Screen title="MCP-серверы"><Loading /></Screen>;

  return (
    <Screen title="MCP-серверы">
      <Txt kind="dim">
        Инструменты MCP-серверов (Streamable HTTP) получает агент вашего личного пространства. Запросы идут через keyguard:
        пространство не видит токен и не выходит в интернет само. Изменяющие вызовы агент выполняет только после вашего
        подтверждения.
      </Txt>
      {msg ? <Notice kind={msg.kind} text={msg.text} /> : null}

      {list.length === 0 ? <Txt kind="small">Серверов пока нет.</Txt> : null}
      {list.map((s) => (
        <Card key={s.id} accent={p.ok}>
          <Row style={{ justifyContent: "space-between" }}>
            <Txt style={{ fontWeight: "600", flex: 1 }}>{s.name}</Txt>
            <Chip text={s.has_token ? "с токеном" : "без токена"} color={s.has_token ? p.ok : undefined} />
          </Row>
          <Txt kind="small" selectable>{s.url}</Txt>
          <Txt kind="small">Инструменты у агента: mcp_{s.id}_…</Txt>
          {armed === s.id ? (
            <Row gap={8} style={{ flexWrap: "wrap" }}>
              <Btn title="Отключить ⌁" small kind="danger" onPress={() => remove(s.id)} busy={busy === `rm:${s.id}`} />
              <Btn title="Отмена" small kind="ghost" onPress={() => setArmed(null)} />
            </Row>
          ) : (
            <Btn title="Отключить" small kind="ghost" onPress={() => setArmed(s.id)} style={{ alignSelf: "flex-start" }} />
          )}
        </Card>
      ))}

      <Txt kind="label">подключить сервер</Txt>
      <Field label="Название" value={name} onChangeText={setName} placeholder="Например, Notion" />
      <Field label="Адрес (https)" value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false}
        placeholder="https://mcp.example.com/mcp" hint={urlBad ?? undefined} />
      <Field label="Токен (если сервер требует)" value={token} onChangeText={setToken} secureTextEntry autoCapitalize="none" autoCorrect={false}
        hint={`Уходит как «Authorization: Bearer …». Шифруется на ${DEV.prep} для keyguard.`} />
      <Btn title="Подключить ⌁" onPress={add} busy={busy === "add"} disabled={!url.trim() || !!urlBad || !!busy} />
      <Txt kind="small">Только личные пространства. Не больше 10 серверов. Адрес — https, порт 443, без перенаправлений.</Txt>
    </Screen>
  );
}
