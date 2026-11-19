/**
 * Ключи API и личные расходы в кластере: какие ключи заданы, ввод и удаление ключа, расход за месяц и месячный лимит.
 * Ключ шифруется на телефоне для keyguard (HPKE); ввод, удаление и лимит подписываются биометрией.
 */
import { useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useState } from "react";

import { GIT_PROVIDERS, LLM_PROVIDERS, SERVICE_PROVIDERS, validateApiKey, type KeyProvider } from "@/core/apikeys";
import { deleteKey, driveOAuthStart, driveOAuthStatus, keyStatus, parseLimit, putKey, setSpendLimit, type KeyStatus } from "@/core/personal";
import { keyProvider } from "@/platform/keys";
import { getCluster, type ClusterRecord } from "@/state/cluster";
import { openClusterSession } from "@/state/clusterSession";
import { Btn, Card, Chip, errText, Field, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";

const KEY_TITLES: Record<KeyProvider, string> = {
  sakana: "Sakana", anthropic: "Claude (Anthropic)", openai: "OpenAI", xai: "Grok (xAI)", google: "Google Gemini",
  kimi: "Kimi Code", moonshot: "Kimi (Moonshot Platform)", qwen: "Qwen (Alibaba Cloud)", mistral: "Mistral AI", minimax: "MiniMax", zai: "Z.AI GLM",
  deepseek: "DeepSeek", github: "GitHub", gitlab: "GitLab", google_drive: "Google Drive",
};
const HINTS: Partial<Record<KeyProvider, string>> = {
  sakana: "console.sakana.ai → API Keys",
  anthropic: "console.anthropic.com → API Keys",
  openai: "platform.openai.com → API Keys",
  xai: "console.x.ai → API Keys",
  google: "aistudio.google.com → Get API key",
  kimi: "kimi.ai/code/console → Create API Key (нужна подписка Kimi)",
  moonshot: "platform.moonshot.ai → API Keys (оплата за токены)",
  qwen: "Alibaba Cloud Model Studio → API Key (международный регион)",
  mistral: "console.mistral.ai → API Keys",
  minimax: "platform.minimax.io → API Keys",
  zai: "z.ai → API Keys",
  deepseek: "platform.deepseek.com → API Keys",
  github: "github.com → Settings → Developer settings → токен с доступом к нужным репозиториям",
  gitlab: "gitlab.com → Preferences → Access tokens (api, read_repository, write_repository)",
  google_drive: "Подключение через Google: чтение Drive и загрузка новых файлов; Client ID/Secret задаёт администратор сервера",
};
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export default function Keys() {
  const { cid, kind } = useLocalSearchParams<{ cid: string; kind?: string }>();
  const git = kind === "git";
  const service = kind === "services";
  const list: readonly KeyProvider[] = service ? SERVICE_PROVIDERS : git ? GIT_PROVIDERS : LLM_PROVIDERS;
  const title = service ? "Подключения" : git ? "Git-токены" : "Токены моделей";
  const { p } = useTheme();
  const [rec, setRec] = useState<ClusterRecord | null>(null);
  const [st, setSt] = useState<KeyStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [provider, setProvider] = useState<KeyProvider>(service ? "google_drive" : kind === "git" ? "github" : "sakana");
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
  const connectDrive = () => run("drive-oauth", async (r) => {
    const session = await openClusterSession(r, r.api);
    const oauth = await driveOAuthStart(session);
    await WebBrowser.openBrowserAsync(oauth.url);
    for (let i = 0; i < 20; i++) {
      const status = await driveOAuthStatus(session, oauth.state);
      if (status.connected) return "Google Drive подключён с доступом только на чтение";
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("Google пока не подтвердил подключение. Если вы разрешили доступ, повторите проверку через минуту");
  });
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

      {service ? <Btn title="Подключить через Google" onPress={connectDrive} busy={busy === "drive-oauth"} /> : null}
      {service ? <Txt kind="small">Откроется Google: войдите и разрешите чтение Drive. Refresh token получит keyguard, вводить его вручную не нужно.</Txt> : null}
      <Txt kind="label">{service ? "Резервный вариант: OAuth refresh token" : git ? "добавить или заменить токен" : "от какой ИИ ключ"}</Txt>
      <Row gap={6} style={{ flexWrap: "wrap" }}>{list.map((pv) => (
        <Btn key={pv} small title={KEY_TITLES[pv]} kind={pv === provider ? "primary" : "ghost"} onPress={() => setProvider(pv)} />
      ))}</Row>
      <Field label={`${git || service ? "Токен" : "Ключ"} ${KEY_TITLES[provider]}`} value={apiKey} onChangeText={setApiKey} secureTextEntry autoCapitalize="none" autoCorrect={false}
        hint={HINTS[provider] ? `Где взять: ${HINTS[provider]}` : undefined} />
      <Btn title="Сохранить ключ ⌁" onPress={save} busy={busy === "put"} disabled={!apiKey} />
      <Txt kind="small">Ключ шифруется на этом телефоне для keyguard — ни сервер, ни администратор его не видят. ⌁ — понадобится биометрия.</Txt>
    </Screen>
  );
}
