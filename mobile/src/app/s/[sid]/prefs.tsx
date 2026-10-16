/** Настройки пространства: модели (какие доступны по вашим ключам и почём) и репозитории (где какой используется). */
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Linking } from "react-native";

import type { RepoInfo } from "@/core/api";
import { clusterOfSid } from "@/state/cluster";
import { useApi, useLoad } from "@/state/hooks";
import { Btn, Card, Chip, Empty, Field, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { AgentsEditor } from "@/ui/AgentsEditor";
import { useTheme } from "@/ui/theme";

const PROVIDERS: Record<string, string> = { sakana: "Sakana", anthropic: "Claude (Anthropic)", deepseek: "DeepSeek", openai: "OpenAI" };
const GIT: Record<string, string> = { github: "GitHub", gitlab: "GitLab" };

export default function SpacePrefs() {
  const { p } = useTheme();
  const { sid } = useLocalSearchParams<{ sid: string }>();
  const { api, error: apiError } = useApi(sid);
  const [tab, setTab] = useState<"models" | "repos" | "agents">("models");
  const cfg = useLoad(useCallback(() => api?.config() ?? null, [api]));
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const repos = useLoad(useCallback(() => (api && tab === "repos" ? api.repos(query) : null), [api, tab, query]));
  const projects = useLoad(useCallback(() => (api && tab === "repos" ? api.projects() : null), [api, tab]));
  const cluster = clusterOfSid(sid);
  const keysScreen = (kind: "llm" | "git") => cluster && router.push({ pathname: "/keys/[cid]", params: { cid: cluster, kind } });

  const usedIn = (provider: string, r: RepoInfo) =>
    (projects.data ?? []).filter((pr) => pr.repos?.some((x) => x.provider === provider && x.repo.toLowerCase() === r.full_name.toLowerCase())).map((pr) => pr.name);

  const models = cfg.data?.models ?? [];
  const ready = cfg.data?.llm_ready ?? [];
  const pricing = (cfg.data?.pricing ?? {}) as Record<string, number[]>;
  const groups = [...new Set(models.map((m) => m.split(":")[0]))];

  return (
    <Screen title="Модели, репозитории, агенты">
      {apiError ? <Notice text={apiError} /> : null}
      <Row gap={8}>
        <Btn title="Модели" kind={tab === "models" ? "primary" : "ghost"} onPress={() => setTab("models")} style={{ flex: 1 }} />
        <Btn title="Репозитории" kind={tab === "repos" ? "primary" : "ghost"} onPress={() => setTab("repos")} style={{ flex: 1 }} />
        <Btn title="Агенты" kind={tab === "agents" ? "primary" : "ghost"} onPress={() => setTab("agents")} style={{ flex: 1 }} />
      </Row>
      {tab === "agents" && api ? (
        <AgentsEditor api={api} models={cfg.data?.models ?? []}
          canEdit={(cfg.data?.me as { role?: string } | undefined)?.role === "owner"} />
      ) : null}

      {tab === "agents" ? null : tab === "models" ? (
        <>
          {!cfg.data && !cfg.error ? <Loading /> : null}
          {cfg.error ? <Notice text={cfg.error} /> : null}
          {groups.map((g) => (
            <Card key={g} accent={ready.includes(g) ? p.ok : p.line2}>
              <Row style={{ justifyContent: "space-between" }}>
                <Txt kind="h2">{PROVIDERS[g] ?? g}</Txt>
                <Chip text={ready.includes(g) ? "ключ есть" : "нет ключа"} color={ready.includes(g) ? p.ok : undefined} />
              </Row>
              {models.filter((m) => m.startsWith(g + ":")).map((m) => {
                const pr = pricing[m];
                return (
                  <Row key={m} style={{ justifyContent: "space-between" }}>
                    <Txt kind="mono" numberOfLines={1} style={{ flex: 1, fontSize: 12.5 }}>{m.split(":")[1]}{m === cfg.data?.default_model ? " · по умолчанию" : ""}</Txt>
                    {pr ? <Txt kind="small">${pr[0]} / ${pr[1]} за 1M</Txt> : null}
                  </Row>
                );
              })}
              {!ready.includes(g) && cluster ? <Btn small kind="ghost" title="Ввести ключ" onPress={() => keysScreen("llm")} style={{ alignSelf: "flex-start" }} /> : null}
            </Card>
          ))}
          <Txt kind="small">Цена — за миллион токенов: ввод / вывод. Модель выбирается в чате; доступны те, для чьего провайдера введён ключ.</Txt>
        </>
      ) : (
        <>
          <Field label="Поиск" value={q} onChangeText={setQ} placeholder="имя репозитория" onSubmitEditing={() => setQuery(q.trim())} returnKeyType="search" />
          {!repos.data && !repos.error ? <Loading text="спрашиваем GitHub и GitLab…" /> : null}
          {repos.error ? <Notice text={repos.error} /> : null}
          {repos.data && Object.keys(repos.data).length === 0 ? (
            <Empty title="Git не подключён" text="Добавьте токен GitHub или GitLab — здесь появятся ваши репозитории.">
              {cluster ? <Btn title="Git-токены" onPress={() => keysScreen("git")} /> : null}
            </Empty>
          ) : null}
          {Object.entries(repos.data ?? {}).map(([prov, r]) => (
            <Card key={prov}>
              <Txt kind="h2">{GIT[prov] ?? prov}</Txt>
              {!r.ok ? <Notice kind="warn" text={`Токен не работает: ${r.error ?? "ошибка"}`} /> : null}
              {r.ok && !r.repos?.length ? <Txt kind="small">Репозиториев не найдено.</Txt> : null}
              {r.repos?.map((x) => {
                const used = usedIn(prov, x);
                return (
                  <Card key={x.full_name} onPress={x.url ? () => Linking.openURL(x.url!) : undefined} accent={used.length ? p.accent : undefined}>
                    <Row style={{ justifyContent: "space-between" }}>
                      <Txt kind="mono" numberOfLines={1} style={{ flex: 1, fontSize: 12.5 }}>{x.full_name}</Txt>
                      {x.private ? <Chip text="приватный" /> : null}
                    </Row>
                    {x.description ? <Txt kind="small" numberOfLines={2}>{x.description}</Txt> : null}
                    {used.length ? <Txt kind="small" color={p.accent}>в проектах: {used.join(", ")}</Txt> : null}
                  </Card>
                );
              })}
            </Card>
          ))}
          <Txt kind="small">Какие репозитории в работе у проекта — на экране проекта. Агент добавляет туда и созданные им.</Txt>
        </>
      )}
    </Screen>
  );
}
