/**
 * Репозитории проекта: с какими работает агент в этом проекте. Человек добавляет и убирает их здесь; агент — сам
 * (project_repo_set), а созданный им репозиторий попадает сюда автоматически.
 */
import { useState } from "react";
import { Pressable, View } from "react-native";

import type { DeckApi, RepoRef, ReposByProvider } from "@/core/api";

import { Btn, Card, errText, Field, Loading, Notice, Row, Txt } from "./kit";
import { MONO, useTheme } from "./theme";

const GIT: Record<string, string> = { github: "GitHub", gitlab: "GitLab" };

export function ProjectRepos({ pid, repos, api, canWrite, onChanged }: {
  pid: string; repos: RepoRef[]; api: DeckApi; canWrite: boolean; onChanged(): void;
}) {
  const { p } = useTheme();
  const [picking, setPicking] = useState(false);
  const [all, setAll] = useState<ReposByProvider | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const same = (a: RepoRef, b: RepoRef) => a.provider === b.provider && a.repo.toLowerCase() === b.repo.toLowerCase();

  const save = async (tag: string, next: RepoRef[]) => {
    setBusy(tag);
    setErr(null);
    try {
      await api.setProjectRepos(pid, next);
      onChanged();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const open = async () => {
    setPicking(true);
    if (all) return;
    try {
      setAll(await api.repos());
    } catch (e) {
      setErr(errText(e));
    }
  };

  const filter = q.trim().toLowerCase();
  return (
    <Card>
      <Row style={{ justifyContent: "space-between" }}>
        <Txt kind="label">репозитории проекта</Txt>
        <Txt kind="small">{repos.length || "нет"}</Txt>
      </Row>
      {repos.map((r) => (
        <Row key={r.provider + r.repo} style={{ justifyContent: "space-between" }}>
          <Txt numberOfLines={1} style={{ flex: 1, fontFamily: MONO, fontSize: 12.5 }}>{GIT[r.provider]} · {r.repo}</Txt>
          {canWrite ? (
            <Pressable hitSlop={10} accessibilityLabel={`Убрать ${r.repo}`} disabled={!!busy}
              onPress={() => save(`rm:${r.repo}`, repos.filter((x) => !same(x, r)))}>
              <Txt kind="small" color={p.accent2}>{busy === `rm:${r.repo}` ? "…" : "убрать"}</Txt>
            </Pressable>
          ) : null}
        </Row>
      ))}
      {!repos.length ? <Txt kind="small">Агент работает с любым вашим репозиторием, но эти держит в голове. Он добавляет сюда и созданные им.</Txt> : null}
      {err ? <Notice text={err} /> : null}
      {canWrite && !picking ? <Btn small kind="ghost" title="＋ Добавить репозиторий" onPress={open} style={{ alignSelf: "flex-start" }} /> : null}
      {picking ? (
        <View style={{ gap: 8 }}>
          <Field label="Найти" value={q} onChangeText={setQ} placeholder="имя репозитория" />
          {!all ? <Loading text="спрашиваем GitHub и GitLab…" /> : null}
          {all && Object.keys(all).length === 0 ? <Txt kind="small">Git не подключён: добавьте токен на экране кластера → «Git-токены».</Txt> : null}
          {Object.entries(all ?? {}).flatMap(([prov, r]) =>
            (r.repos ?? [])
              .filter((x) => !filter || x.full_name.toLowerCase().includes(filter))
              .filter((x) => !repos.some((y) => same(y, { provider: prov as RepoRef["provider"], repo: x.full_name })))
              .slice(0, 30)
              .map((x) => (
                <Btn key={prov + x.full_name} small kind="ghost" title={`${GIT[prov] ?? prov} · ${x.full_name}`} busy={busy === `add:${x.full_name}`} disabled={!!busy}
                  onPress={() => save(`add:${x.full_name}`, [...repos, { provider: prov as RepoRef["provider"], repo: x.full_name }])} />
              )),
          )}
          <Btn small kind="ghost" title="Готово" onPress={() => setPicking(false)} style={{ alignSelf: "flex-start" }} />
        </View>
      ) : null}
    </Card>
  );
}
