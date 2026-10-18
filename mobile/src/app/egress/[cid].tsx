/**
 * Домены для агента: с них агент личного пространства читает страницы (инструмент web_fetch, доступ «Сайты»).
 * Запросы идут через keyguard; список меняется только подписанным действием — агент сам его не расширит.
 */
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";

import { domainFrom, listEgress, MAX_DOMAINS, setEgress } from "@/core/egress";
import { keyProvider } from "@/platform/keys";
import { getCluster, type ClusterRecord } from "@/state/cluster";
import { openClusterSession } from "@/state/clusterSession";
import { Btn, Card, errText, Field, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";

export default function Egress() {
  const { cid } = useLocalSearchParams<{ cid: string }>();
  const { p } = useTheme();
  const [rec, setRec] = useState<ClusterRecord | null>(null);
  const [saved, setSaved] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);

  const load = useCallback(async (r: ClusterRecord) => {
    try {
      const d = (await listEgress(await openClusterSession(r, r.api))).domains;
      setSaved(d);
      setDraft(d);
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
      setSaved([]);
    }
  }, []);

  useEffect(() => {
    getCluster(cid).then((r) => {
      setRec(r);
      if (r) void load(r);
    });
  }, [cid, load]);

  const parsed = input.trim() ? domainFrom(input) : null;
  const add = () => {
    if (!parsed || draft.includes(parsed)) return;
    setDraft([...draft, parsed].sort());
    setInput("");
  };
  const changed = saved !== null && (saved.length !== draft.length || saved.some((d, i) => d !== draft[i]));

  const save = async () => {
    if (!rec) return;
    setBusy(true);
    setMsg(null);
    try {
      const k = await (await keyProvider()).load(rec.alias);
      if (!k) throw new Error("Ключи устройства не найдены — зарегистрируйтесь заново по приглашению");
      const out = await setEgress(await openClusterSession(rec, rec.api), k, draft);
      setSaved(out);
      setDraft(out);
      setMsg({ kind: "ok", text: out.length ? `Сохранено: ${out.length}. Агент увидит список в новом сообщении.` : "Список пуст — агент не читает сайты." });
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!rec || saved === null) return <Screen title="Домены для агента"><Loading /></Screen>;

  return (
    <Screen title="Домены для агента">
      <Txt kind="dim">
        С этих сайтов агент вашего личного пространства может читать страницы (только чтение, GET). Запросы идут через
        keyguard; любой другой адрес он отклонит. Домен — точное имя: docs.python.org не открывает python.org и наоборот.
      </Txt>
      {msg ? <Notice kind={msg.kind} text={msg.text} /> : null}

      {draft.length === 0 ? <Txt kind="small">Доменов нет — агент не читает сайты.</Txt> : null}
      {draft.map((d) => (
        <Card key={d} accent={saved.includes(d) ? p.ok : p.warn}>
          <Row style={{ justifyContent: "space-between" }}>
            <Txt selectable style={{ flex: 1 }}>{d}</Txt>
            <Btn title="Убрать" small kind="ghost" onPress={() => setDraft(draft.filter((x) => x !== d))} />
          </Row>
        </Card>
      ))}

      <Field label="Добавить домен или адрес" value={input} onChangeText={setInput} autoCapitalize="none" autoCorrect={false}
        placeholder="docs.python.org" onSubmitEditing={add}
        hint={input.trim() && !parsed ? "Имя домена: строчные латинские буквы, цифры, точки; без * и IP" : parsed && parsed !== input.trim() ? `Будет добавлен: ${parsed}` : undefined} />
      <Row gap={8} style={{ flexWrap: "wrap" }}>
        <Btn title="Добавить" kind="ghost" onPress={add} disabled={!parsed || draft.includes(parsed) || draft.length >= MAX_DOMAINS} />
        <Btn title="Сохранить ⌁" onPress={save} busy={busy} disabled={!changed || busy} />
      </Row>
      <Txt kind="small">Не больше {MAX_DOMAINS} доменов. Только личные пространства. Сохранение — одна подпись на весь список.</Txt>
    </Screen>
  );
}
