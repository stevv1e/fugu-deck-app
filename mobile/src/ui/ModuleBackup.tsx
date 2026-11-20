import { useState } from "react";
import { Platform } from "react-native";

import { decryptBackup, encryptBackup, isEncryptedBackup, parseBackup, serializeBackup } from "@/core/backup";
import type { InstalledModule } from "@/core/modules";
import { pickText, saveText } from "@/platform/pick";
import { recordModuleEvent } from "@/platform/moduleAudit";
import { useServers } from "@/state/servers";
import { Btn, Card, Chip, errText, Field, Notice, Row, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";

async function exportText(name: string, text: string): Promise<boolean> {
  if (Platform.OS === "web") {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
  return saveText(name, "application/json", text);
}

export function ModuleBackup({ installed, onImport }: { installed: InstalledModule[]; onImport(items: InstalledModule[]): Promise<void> }) {
  const { p } = useTheme();
  const { servers, api } = useServers();
  const connected = servers.filter((server) => server.device);
  const [sid, setSid] = useState("");
  const selected = connected.find((server) => server.id === sid) || connected[0];
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const run = async (tag: string, action: () => Promise<void>) => {
    setBusy(tag); setError(""); setNote("");
    try { await action(); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(""); }
  };
  const merge = async (items: InstalledModule[]) => {
    const merged = [...installed];
    for (const item of items) {
      const at = merged.findIndex((current) => current.manifest.id === item.manifest.id);
      if (at >= 0) merged[at] = item; else merged.push(item);
    }
    await onImport(merged);
    await recordModuleEvent({ module: "standalone", action: "import", ok: true, details: `${items.length} модулей` });
    setNote(`Импортировано модулей: ${items.length}. API-ключи и устройства в копию не входят.`);
  };
  const encrypted = async () => {
    if (passphrase.length < 10) throw new Error("Введите парольную фразу не короче 10 символов");
    return encryptBackup(installed, passphrase);
  };

  return <>
    <Card accent={p.accent}>
      <Row style={{ justifyContent: "space-between", flexWrap: "wrap" }}><Txt kind="h2">Автономность и перенос</Txt><Chip text="без API-ключей" color={p.ok} /></Row>
      <Txt kind="small">Экспорт содержит манифесты, код и источники установленных модулей. Серверы, ключи устройств, GitHub tokens и ключи моделей не экспортируются.</Txt>
    </Card>
    {error ? <Notice text={error} /> : null}
    {note ? <Notice kind="ok" text={note} /> : null}
    <Card>
      <Txt kind="h2">Файл резервной копии</Txt>
      <Field label="Парольная фраза для E2EE (не сохраняется)" value={passphrase} onChangeText={setPassphrase} secureTextEntry hint="Минимум 10 символов. Без неё восстановить зашифрованную копию невозможно." />
      <Row style={{ flexWrap: "wrap" }}>
        <Btn small kind="ghost" title="Экспорт JSON" busy={busy === "plain"} onPress={() => run("plain", async () => { await exportText("fugu-modules.json", serializeBackup(installed)); setNote("Открытая копия JSON создана."); })} />
        <Btn small title="Экспорт E2EE" busy={busy === "encrypted"} onPress={() => run("encrypted", async () => { await exportText("fugu-modules-e2ee.json", await encrypted()); setNote("Зашифрованная копия создана."); })} />
        <Btn small kind="ghost" title="Импорт файла" busy={busy === "import"} onPress={() => run("import", async () => {
          const file = await pickText(8_000_000);
          if (!file) return;
          const items = isEncryptedBackup(file.text) ? await decryptBackup(file.text, passphrase) : parseBackup(file.text);
          await merge(items);
        })} />
      </Row>
    </Card>
    <Card>
      <Txt kind="h2">E2EE-синхронизация телефона и ПК</Txt>
      <Txt kind="small">Шифрование происходит на устройстве. Сервер хранит один непрозрачный конверт; загрузка и скачивание выполняются вручную, конфликт версий не перезаписывается.</Txt>
      {connected.length > 1 ? <Row style={{ flexWrap: "wrap" }}>{connected.map((server) => <Btn key={server.id} small kind={selected?.id === server.id ? "primary" : "ghost"} title={server.name} onPress={() => setSid(server.id)} />)}</Row> : null}
      {selected ? <>
        <Txt kind="mono">{selected.name} · {selected.device?.user.username}</Txt>
        <Row style={{ flexWrap: "wrap" }}>
          <Btn small title="Зашифровать и отправить" busy={busy === "upload"} onPress={() => run("upload", async () => {
            const client = await api(selected.id);
            const current = await client.sync();
            const result = await client.putSync(await encrypted(), current.data ? current.updated_at : null);
            setNote(`Синхронизация отправлена: ${new Date(result.updated_at * 1000).toLocaleString()}.`);
          })} />
          <Btn small kind="ghost" title="Скачать и расшифровать" busy={busy === "download"} onPress={() => run("download", async () => {
            const current = await (await api(selected.id)).sync();
            if (!current.data) throw new Error("На сервере пока нет синхронизации");
            await merge(await decryptBackup(current.data, passphrase));
          })} />
        </Row>
      </> : <Txt kind="dim">Для синхронизации подключите пространство. Файловый экспорт работает и без сервера.</Txt>}
    </Card>
  </>;
}
