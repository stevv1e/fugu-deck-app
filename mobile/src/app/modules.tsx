import { useCallback, useEffect, useState } from "react";
import { Linking, View } from "react-native";

import {
  installModule,
  loadOfficialCatalog,
  modulePermissions,
  OFFICIAL_MODULES,
  parseGitSource,
  type GitSource,
  type InstalledModule,
  type ModuleIndex,
} from "@/core/modules";
import { recordModuleEvent } from "@/platform/moduleAudit";
import { prefs } from "@/platform/storage";
import { BrandMark } from "@/ui/BrandMark";
import { Btn, Card, Chip, Empty, errText, Field, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { ModuleBackup } from "@/ui/ModuleBackup";
import { ModuleRunner } from "@/ui/ModuleRunner";
import { ModuleSecurity } from "@/ui/ModuleSecurity";
import { ModuleStudio } from "@/ui/ModuleStudio";
import { SectionHeading } from "@/ui/SectionHeading";
import { useTheme } from "@/ui/theme";

const STORE = "fd:installed-modules";
type Section = "catalog" | "studio" | "security" | "backup";

export default function Modules() {
  const { p } = useTheme();
  const [section, setSection] = useState<Section>("catalog");
  const [installed, setInstalled] = useState<InstalledModule[] | null>(null);
  const [catalog, setCatalog] = useState<{ commit: string; entries: ModuleIndex["modules"]; sources: Record<string, GitSource> } | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [query, setQuery] = useState("");
  const [candidate, setCandidate] = useState<InstalledModule | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState({ url: "", ref: "main", path: "", token: "" });

  useEffect(() => { void prefs.get<InstalledModule[]>(STORE, []).then((items) => setInstalled(items)); }, []);
  const loadCatalog = useCallback(async () => {
    setCatalogError(""); setBusy("catalog");
    try { setCatalog(await loadOfficialCatalog()); }
    catch (e) { setCatalogError(errText(e)); }
    finally { setBusy(""); }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => { void loadCatalog(); }, 0);
    return () => clearTimeout(timer);
  }, [loadCatalog]);

  const save = async (items: InstalledModule[]) => {
    setInstalled(items);
    await prefs.set(STORE, items);
  };
  const prepare = async (tag: string, source: GitSource, token = "") => {
    setBusy(tag); setError(""); setNote(""); setCandidate(null);
    try { setCandidate(await installModule(source, token)); }
    catch (e) {
      setError(errText(e));
      await recordModuleEvent({ module: source.path || source.repo, action: "install", ok: false, details: errText(e) });
    } finally { setBusy(""); }
  };
  const confirm = async () => {
    if (!candidate || !installed) return;
    const previous = installed.find((item) => item.manifest.id === candidate.manifest.id);
    const next = [...installed.filter((item) => item.manifest.id !== candidate.manifest.id), candidate];
    await save(next);
    await recordModuleEvent({ module: candidate.manifest.id, action: previous ? "update" : "install", ok: true, details: `${candidate.manifest.version} · ${candidate.commit}` });
    setSelected(candidate.manifest.id);
    setCandidate(null);
    setNote(previous ? `Обновлено: ${previous.manifest.version} → ${candidate.manifest.version}` : `Модуль «${candidate.manifest.name}» установлен на commit ${candidate.commit.slice(0, 8)}`);
  };
  const patch = async (id: string, enabled: boolean) => {
    if (!installed) return;
    await save(installed.map((item) => item.manifest.id === id ? { ...item, enabled } : item));
    await recordModuleEvent({ module: id, action: enabled ? "enable" : "disable", ok: true, details: enabled ? "выполнение разрешено" : "выполнение заблокировано" });
    if (!enabled && selected === id) setSelected("");
  };
  const remove = async (id: string) => {
    if (!installed) return;
    await save(installed.filter((item) => item.manifest.id !== id));
    await recordModuleEvent({ module: id, action: "remove", ok: true, details: "модуль удалён с устройства" });
    if (selected === id) setSelected("");
  };
  const entries = catalog?.entries.filter((item) => `${item.name} ${item.description} ${item.category || ""}`.toLowerCase().includes(query.toLowerCase())) || [];
  const current = installed?.find((item) => item.manifest.id === selected && item.enabled);
  const previous = candidate && installed?.find((item) => item.manifest.id === candidate.manifest.id);
  const candidateOfficial = candidate && catalog?.sources[candidate.manifest.id]?.ref === candidate.commit;

  return <Screen title="Git-модули">
    <SectionHeading eyebrow="расширяемая платформа" title="Возможности из Git" text="Установка по точному commit, проверка подписи каталога и SHA-256, конструктор, аудит и перенос между устройствами." right={<BrandMark size={50} />} />
    <Row gap={6} style={{ flexWrap: "wrap" }}>
      {([["catalog", "Каталог"], ["studio", "Конструктор"], ["security", "Безопасность"], ["backup", "Перенос"]] as const).map(([id, title]) => <Btn key={id} small kind={section === id ? "primary" : "ghost"} title={title} onPress={() => setSection(id)} />)}
    </Row>
    {section === "studio" ? <ModuleStudio /> : null}
    {section === "security" ? installed ? <ModuleSecurity installed={installed} onToggle={patch} /> : <Loading /> : null}
    {section === "backup" ? installed ? <ModuleBackup installed={installed} onImport={save} /> : <Loading /> : null}
    {section === "catalog" ? <>
      {error ? <Notice text={error} /> : null}
      {note ? <Notice kind="ok" text={note} /> : null}
      <Card accent={p.accent}>
        <Row style={{ justifyContent: "space-between", flexWrap: "wrap" }}><View style={{ flex: 1 }}><Txt kind="label">основной источник</Txt><Txt kind="mono" color={p.accent}>github.com/stevv1e/fugu-modules</Txt></View><Chip text={catalog ? `подписан · ${catalog.commit.slice(0, 8)}` : "offline"} color={catalog ? p.ok : p.warn} /></Row>
        <Txt kind="small">index.json + Ed25519 → manifest → entry.js + SHA-256. Код выполняется без доступа к API-ключам, нативным библиотекам и основному контексту приложения.</Txt>
        <Btn small kind="ghost" title="Открыть репозиторий ↗" onPress={() => Linking.openURL(OFFICIAL_MODULES)} style={{ alignSelf: "flex-start" }} />
      </Card>
      {candidate ? <Card accent={p.warn}>
        <Row style={{ justifyContent: "space-between", flexWrap: "wrap" }}><Txt kind="label">{previous ? "подтверждение обновления" : "подтверждение установки"}</Txt><Chip text={candidateOfficial ? "подписанный каталог" : "сторонний Git"} color={candidateOfficial ? p.ok : p.warn} /></Row>
        <Txt kind="h2">{candidate.manifest.name} · {candidate.manifest.version}</Txt>
        <Txt>{candidate.manifest.description}</Txt>
        <Txt kind="mono">{candidate.repository}/tree/{candidate.commit}/{candidate.path}</Txt>
        <Txt kind="small">SHA-256 проверен: {candidate.manifest.sha256}</Txt>
        {!candidateOfficial ? <Notice kind="warn" text="Пользовательский Git-источник не подписан официальным ключом. Доверие к автору репозитория проверяете вы." /> : null}
        <Txt kind="label">разрешения</Txt>
        {modulePermissions(candidate.manifest).map((permission) => <Txt key={permission}>• {permission}</Txt>)}
        {previous ? <Txt kind="small">Текущая версия {previous.manifest.version} · commit {previous.commit.slice(0, 8)}. Обновление заменит её только после подтверждения.</Txt> : null}
        <Row><Btn kind="ghost" title="Отмена" onPress={() => setCandidate(null)} style={{ flex: 1 }} /><Btn title={previous ? "Обновить" : "Установить"} onPress={confirm} style={{ flex: 1 }} /></Row>
      </Card> : null}

      <Txt kind="label">установленные</Txt>
      {!installed ? <Loading /> : null}
      {installed?.map((module) => <Card key={module.manifest.id} accent={module.enabled ? p.ok : p.line2}>
        <Row style={{ justifyContent: "space-between" }}><Txt kind="h2" style={{ flex: 1 }}>{module.manifest.name}</Txt><Chip text={module.manifest.version} color={p.accent} /></Row>
        <Txt kind="small">{module.manifest.id} · commit {module.commit.slice(0, 8)} · {module.enabled ? "включён" : "выключен"}</Txt>
        <Row gap={6} style={{ flexWrap: "wrap" }}>
          <Btn small title="Открыть" kind="ghost" disabled={!module.enabled} onPress={() => setSelected(module.manifest.id)} />
          <Btn small title={module.enabled ? "Выключить" : "Включить"} kind="ghost" onPress={() => patch(module.manifest.id, !module.enabled)} />
          <Btn small title="Проверить обновление" kind="ghost" disabled={!!busy} onPress={() => {
            const source = catalog?.sources[module.manifest.id] || parseGitSource(`${module.repository}/tree/${module.commit}/${module.path}`);
            void prepare(`update:${module.manifest.id}`, source);
          }} />
          <Btn small title="Удалить" kind="danger" onPress={() => remove(module.manifest.id)} />
        </Row>
      </Card>)}
      {installed && !installed.length ? <Empty title="Модулей пока нет" text="Выберите модуль из подписанного каталога или создайте свой в конструкторе." /> : null}
      {current ? <ModuleRunner module={current} onError={setError} /> : null}

      <Row style={{ justifyContent: "space-between" }}><Txt kind="label">официальный каталог</Txt><Btn small kind="ghost" title="Обновить" busy={busy === "catalog"} onPress={loadCatalog} /></Row>
      <Field label="Поиск" value={query} onChangeText={setQuery} placeholder="Название, описание, категория" />
      {catalogError ? <Notice kind="warn" text={`Каталог недоступен: ${catalogError}. Установленные модули продолжают работать offline.`} /> : null}
      {!catalog && !catalogError ? <Loading text="Загружаем и проверяем подпись каталога…" /> : null}
      {entries.map((module) => {
        const existing = installed?.find((item) => item.manifest.id === module.id);
        return <Card key={module.id}>
          <Row style={{ justifyContent: "space-between" }}><Txt kind="h2" style={{ flex: 1 }}>{module.name}</Txt><Chip text={module.category || "tool"} color={p.accent} /></Row>
          <Txt kind="small">{module.description}</Txt>
          <Txt kind="mono">v{module.version} · {module.id}</Txt>
          <Btn small title={existing ? "Посмотреть новую версию" : "Установить…"} onPress={() => prepare(module.id, catalog!.sources[module.id])} busy={busy === module.id} disabled={!!busy} style={{ alignSelf: "flex-start" }} />
        </Card>;
      })}

      <Card>
        <Row style={{ justifyContent: "space-between" }}><Txt kind="h2">Добавить из Git</Txt><Btn small kind="ghost" title={customOpen ? "Закрыть" : "Показать"} onPress={() => setCustomOpen(!customOpen)} /></Row>
        {customOpen ? <>
          <Notice kind="info" text="Пользовательские источники поддерживают публичные и приватные GitHub-репозитории. Они отдельно маркируются и не получают доверие официальной подписи." />
          <Field label="GitHub URL репозитория или папки" value={custom.url} onChangeText={(url) => setCustom({ ...custom, url })} placeholder="https://github.com/user/module" />
          <Field label="Ветка / тег / commit" value={custom.ref} onChangeText={(ref) => setCustom({ ...custom, ref })} />
          <Field label="Папка модуля (если ссылка на корень)" value={custom.path} onChangeText={(path) => setCustom({ ...custom, path })} placeholder="modules/my-module" />
          <Field label="GitHub token для приватного репозитория (не сохраняется)" value={custom.token} onChangeText={(token) => setCustom({ ...custom, token })} secureTextEntry />
          <Btn title="Проверить манифест и SHA-256" busy={busy === "custom"} disabled={!custom.url.trim() || !!busy} onPress={() => {
            try { void prepare("custom", parseGitSource(custom.url, custom.ref, custom.path), custom.token); }
            catch (e) { setError(errText(e)); }
          }} />
        </> : <Txt kind="small">Поддерживаются module.json формата fugu-module/1 и JS entry до 256 КБ. Доступны только storage и явно перечисленные HTTPS-домены.</Txt>}
      </Card>
      <Card><Txt kind="label">модель безопасности</Txt><Txt kind="small">✓ Изолированный WebView/iframe без same-origin доступа</Txt><Txt kind="small">✓ Нет прямого fetch у модуля: сеть проходит через host RPC и allowlist</Txt><Txt kind="small">✓ Нет нативных .so/.dll и Node.js; Git/SSH и серверное выполнение — следующий отдельный этап</Txt><Txt kind="small">✓ Обновления вручную с версией, commit и повторным показом разрешений</Txt></Card>
    </> : null}
  </Screen>;
}
