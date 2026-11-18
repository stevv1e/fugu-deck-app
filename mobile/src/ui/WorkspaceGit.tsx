import { useCallback, useState } from "react";
import { Linking, ScrollView, View } from "react-native";

import type { DeckApi, RepoRef } from "@/core/api";
import { useLoad } from "@/state/hooks";
import { Btn, Card, Chip, Empty, errText, Field, Loading, Notice, Row, Txt } from "@/ui/kit";
import { MONO, useTheme } from "@/ui/theme";

export function WorkspaceGit({ api, repos, mode }: { api: DeckApi; repos: RepoRef[]; mode: "files" | "diff" | "ci" }) {
  const { p } = useTheme();
  const [selected, setSelected] = useState(0);
  const [refDraft, setRefDraft] = useState("");
  const [ref, setRef] = useState("");
  const [path, setPath] = useState("");
  const [base, setBase] = useState("main");
  const [head, setHead] = useState("");
  const [diff, setDiff] = useState<Awaited<ReturnType<DeckApi["workspaceDiff"]>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const repo = repos[Math.min(selected, Math.max(0, repos.length - 1))];
  const selectRepo = (index: number) => {
    setSelected(index); setPath(""); setRef(""); setRefDraft(""); setDiff(null); setError("");
  };
  const files = useLoad(useCallback(() => api && repo && mode === "files" ? api.workspaceFiles(repo.provider, repo.repo, ref, path) : null, [api, repo, ref, path, mode]));
  const ci = useLoad(useCallback(() => api && repo && mode === "ci" ? api.workspaceCi(repo.provider, repo.repo, ref) : null, [api, repo, ref, mode]));

  if (!repos.length) return <Empty title="Нет привязанных репозиториев" text="Добавьте GitHub или GitLab в настройках проекта. Workspace читает их через существующие токены и Keyguard." />;
  const loadDiff = async () => {
    if (!repo || !base.trim() || !head.trim()) return;
    setBusy(true); setError("");
    try { setDiff(await api.workspaceDiff(repo.provider, repo.repo, base.trim(), head.trim())); }
    catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <View style={{ flex: 1, gap: 14 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7 }}>
        {repos.map((item, index) => <Btn key={`${item.provider}:${item.repo}`} small kind={index === selected ? "primary" : "ghost"} title={item.repo} onPress={() => selectRepo(index)} />)}
      </ScrollView>
      <Row gap={8} style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
        <View style={{ flex: 1, minWidth: 220 }}><Field label="Ветка / commit" value={refDraft} onChangeText={setRefDraft} placeholder="Основная ветка" /></View>
        <Btn small title="Применить" onPress={() => setRef(refDraft.trim())} />
        {mode === "files" ? <View style={{ flex: 1, minWidth: 220 }}><Field label="Подпапка" value={path} onChangeText={setPath} placeholder="Весь репозиторий" /></View> : null}
      </Row>
      {error ? <Notice text={error} /> : null}
      {mode === "files" ? <FileBrowser key={`${repo.provider}:${repo.repo}:${ref}:${files.data?.files.length}:${files.data?.files[0]}`} api={api} repo={repo} refName={ref} files={files.data?.files || []} loading={!files.data && !files.error} error={files.error} /> : null}
      {mode === "diff" ? <>
        <Row gap={8} style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
          <View style={{ flex: 1, minWidth: 180 }}><Field label="Base" value={base} onChangeText={setBase} /></View>
          <View style={{ flex: 1, minWidth: 180 }}><Field label="Head" value={head} onChangeText={setHead} placeholder="feature-branch" /></View>
          <Btn title="Сравнить" onPress={loadDiff} busy={busy} disabled={!base.trim() || !head.trim()} />
        </Row>
        {diff ? <Card><Row style={{ justifyContent: "space-between" }}><Txt kind="h2">{diff.base} → {diff.head}</Txt><Chip text={`+${diff.ahead_by} / −${diff.behind_by}`} color={p.accent} /></Row>
          <Txt kind="small">{diff.files.length} изменённых файлов</Txt></Card> : null}
        {diff?.files.map((file) => <Card key={file.path}><Row style={{ justifyContent: "space-between" }}><Txt kind="mono" style={{ flex: 1 }}>{file.path}</Txt><Chip text={file.status} color={file.status === "added" ? p.ok : file.status === "removed" ? p.accent2 : p.warn} /></Row>
          <ScrollView style={{ maxHeight: 420 }}><Txt selectable style={{ fontFamily: MONO, fontSize: 12, lineHeight: 19 }}>{file.patch || "Изменение без текстового patch (возможно, бинарный файл)."}</Txt></ScrollView>
        </Card>)}
        {diff && !diff.files.length ? <Empty title="Нет текстовых изменений" /> : null}
      </> : null}
      {mode === "ci" ? <>
        {!ci.data && !ci.error ? <Loading text="Загружаем последние запуски…" /> : null}
        {ci.error ? <Notice text={ci.error} /> : null}
        {ci.data?.map((run, index) => <Card key={`${run.url}:${index}`} onPress={() => Linking.openURL(run.url)}>
          <Row style={{ justifyContent: "space-between" }}><Txt kind="h2" style={{ flex: 1 }}>{run.name}</Txt><Chip text={run.conclusion || run.status} color={run.conclusion === "success" || run.status === "success" ? p.ok : run.status === "completed" ? p.dim : p.warn} /></Row>
          <Txt kind="small">{run.branch || "—"} · {new Date(run.created_at).toLocaleString("ru-RU")}</Txt>
        </Card>)}
        {ci.data && !ci.data.length ? <Empty title="Запусков не найдено" /> : null}
      </> : null}
    </View>
  );
}

function FileBrowser({ api, repo, refName, files, loading, error }: {
  api: DeckApi; repo: RepoRef; refName: string; files: string[]; loading: boolean; error: string | null;
}) {
  const { p } = useTheme();
  const [selected, setSelected] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [fileError, setFileError] = useState("");
  const open = async (file: string) => {
    setSelected(file); setBusy(true); setFileError("");
    try { setContent((await api.workspaceFile(repo.provider, repo.repo, file, refName)).content); }
    catch (e) { setFileError(errText(e)); } finally { setBusy(false); }
  };
  return <View style={{ flexDirection: "row", gap: 12, minHeight: 360, flexWrap: "wrap" }}>
    <Card style={{ flex: 1, minWidth: 260, maxHeight: 650 }}>
      <Txt kind="label">файлы · {files.length}</Txt>
      <ScrollView nestedScrollEnabled>{files.map((file) => <Btn key={file} small kind="ghost" title={file} onPress={() => open(file)} style={{ alignItems: "flex-start", backgroundColor: file === selected ? p.panel2 : p.panel }} />)}</ScrollView>
      {loading ? <Loading /> : null}
      {error ? <Notice text={error} /> : null}
      {!loading && !files.length ? <Txt kind="small">Файлы не найдены.</Txt> : null}
    </Card>
    <Card style={{ flex: 1.4, minWidth: 320, maxHeight: 650 }}>
      <Txt kind="mono" numberOfLines={1}>{selected || "Выберите файл"}</Txt>
      {busy ? <Loading /> : null}
      {fileError ? <Notice text={fileError} /> : null}
      <ScrollView nestedScrollEnabled><Txt selectable style={{ fontFamily: MONO, fontSize: 12, lineHeight: 19 }}>{content}</Txt></ScrollView>
    </Card>
  </View>;
}
