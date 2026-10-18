/**
 * Ключи API и личные расходы в кластере: какие ключи заданы, ввод и удаление ключа, расход за месяц и месячный лимит.
 * Ключ шифруется на телефоне для keyguard (HPKE); ввод, удаление и лимит подписываются биометрией.
 */
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";

import { GIT_PROVIDERS, LLM_PROVIDERS, validateApiKey, type KeyProvider } from "@/core/apikeys";
import { deleteKey, keyStatus, parseLimit, putKey, setSpendLimit, type KeyStatus } from "@/core/personal";
import { keyProvider } from "@/platform/keys";
import { getCluster, type ClusterRecord } from "@/state/cluster";
import { openClusterSession } from "@/state/clusterSession";
import { Btn, Card, Chip, errText, Field, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";

const KEY_TITLES: Record<KeyProvider, string> = { anthropic: "Claude (Anthropic)", sakana: "Sakana", deepseek: "DeepSeek", github: "GitHub", gitlab: "GitLab" };
const HINTS: Partial<Record<KeyProvider, string>> = {
  sakana: "console.sakana.ai → API Keys",
  anthropic: "console.anthropic.com → API Keys",
  deepseek: "platform.deepseek.com → API Keys",
  github: "github.com → Settings → Developer settings → токен с доступом к нужным репозиториям",
  gitlab: "gitlab.com → Preferences → Access tokens (api, read_repository, write_repository)",
};
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export default function Keys() {
  const { cid, kind } = useLocalSearchParams<{ cid: string; kind?: string }>();
  const git = kind === "git";
  const list: readonly KeyProvider[] = git ? GIT_PROVIDERS : LLM_PROVIDERS;
  const title = git ? "Git-токены" : "Токены моделей";
  const { p } = useTheme();
  const [rec, setRec] = useState<ClusterRecord | null>(null);
  const [st, setSt] = useState<KeyStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [provider, setProvider] = useState<KeyProvider>(kind === "git" ? "github" : "sakana");
  const [apiKey, setApiKey] = useState("");
  const [armed, setArmed] = useState<KeyProvider | null>(null);
  const [limit, setLimit] = useState("");

  const load = useCallback(async (r: ClusterRecord) => {
    try {
      const s = await keyStatus(await openClusterSession(r, r.api));
      setSt(s);
      setLimit(s.limit_usd_month === null ? "" : String(s.limit_usd_month));
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
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

  const save = () => {
    const bad = validateApiKey(apiKey.trim());
    if (bad) return setMsg({ kind: "error", text: bad });
    void run("put", async (r) => {
      const out = await putKey(await openClusterSession(r, r.api), await keysOf(r), r.hpke, provider, apiKey.trim());
      setApiKey("");
      return `Ключ ${KEY_TITLES[provider]} сохранён: ${out.masked}. Его видит только keyguard.`;
    });
  };
  const remove = (pv: KeyProvider) => run(`rm:${pv}`, async (r) => {
    await deleteKey(await openClusterSession(r, r.api), await keysOf(r), pv);
    return `Ключ ${KEY_TITLES[pv]} удалён`;
  });
  const parsed = parseLimit(limit);
  const saveLimit = () => {
    if ("error" in parsed) return setMsg({ kind: "error", text: parsed.error });
    void run("limit", async (r) => {
      await setSpendLimit(await openClusterSession(r, r.api), await keysOf(r), parsed.value);
      return parsed.value === null ? "Лимит снят" : `Лимит: ${usd(parsed.value)} в месяц`;
    });
  };

  if (!rec || (!st && !msg)) return <Screen title={title}><Loading /></Screen>;
  const limitChanged = !("error" in parsed) && st && parsed.value !== st.limit_usd_month;

  return (
    <Screen title={title}>
      {msg ? <Notice kind={msg.kind} text={msg.text} /> : null}
      {st ? (
        <>
          {!git ? <Card accent={st.limit_usd_month !== null && st.spent_usd_month >= st.limit_usd_month ? p.warn : p.accent}>
            <Txt kind="label">расход на модели своим ключом · {st.month}</Txt>
            <Txt kind="h2">{usd(st.spent_usd_month)}{st.limit_usd_month !== null ? ` из ${usd(st.limit_usd_month)}` : ""}</Txt>
            <Txt kind="small">Всего с начала учёта: {usd(st.spent_usd_total)}. Считает keyguard по ответам провайдера.</Txt>
            <Field label="Лимит в месяц, $" value={limit} onChangeText={setLimit} keyboardType="decimal-pad" placeholder="без лимита"
              hint="Когда лимит исчерпан, агент не сможет вызывать модели до следующего месяца. Пустое поле — без лимита." />
            {limitChanged ? <Btn title={parsed.value === null ? "Снять лимит ⌁" : "Сохранить лимит ⌁"} onPress={saveLimit} busy={busy === "limit"} /> : null}
          </Card> : null}

          <Txt kind="label">{git ? "токены" : "ключи"}</Txt>
          {list.map((pv) => {
            const has = st.providers.includes(pv);
            return (
              <Card key={pv} accent={has ? p.ok : p.line2}>
                <Row style={{ justifyContent: "space-between" }}>
                  <Txt style={{ fontWeight: "600" }}>{KEY_TITLES[pv]}</Txt>
                  <Chip text={has ? "задан" : "нет"} color={has ? p.ok : undefined} />
                </Row>
                {has ? (
                  armed === pv ? (
                    <>
                      <Txt kind="dim">Удалить ключ {KEY_TITLES[pv]}? Агент перестанет им пользоваться сразу; вернуть — только ввести ключ заново.</Txt>
                      <Row>
                        <Btn title="Удалить ⌁" small kind="danger" onPress={() => remove(pv)} busy={busy === `rm:${pv}`} />
                        <Btn title="Отмена" small kind="ghost" onPress={() => setArmed(null)} />
                      </Row>
                    </>
                  ) : (
                    <Btn title="Удалить ключ" small kind="ghost" onPress={() => setArmed(pv)} style={{ alignSelf: "flex-start" }} />
                  )
                ) : null}
              </Card>
            );
          })}
        </>
      ) : null}

      <Txt kind="label">{git ? "добавить или заменить токен" : "от какой ИИ ключ"}</Txt>
      <Row gap={6} style={{ flexWrap: "wrap" }}>{list.map((pv) => (
        <Btn key={pv} small title={KEY_TITLES[pv]} kind={pv === provider ? "primary" : "ghost"} onPress={() => setProvider(pv)} />
      ))}</Row>
      <Field label={`${git ? "Токен" : "Ключ"} ${KEY_TITLES[provider]}`} value={apiKey} onChangeText={setApiKey} secureTextEntry autoCapitalize="none" autoCorrect={false}
        hint={HINTS[provider] ? `Где взять: ${HINTS[provider]}` : undefined} />
      <Btn title="Сохранить ключ ⌁" onPress={save} busy={busy === "put"} disabled={!apiKey} />
      <Txt kind="small">Ключ шифруется на этом телефоне для keyguard — ни сервер, ни администратор его не видят. ⌁ — понадобится биометрия.</Txt>
    </Screen>
  );
}
