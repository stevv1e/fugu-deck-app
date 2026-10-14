/**
 * Вложения в ленте чата: картинки — миниатюрами (нажатие — на весь экран), остальные файлы — строкой с кнопками
 * «Открыть» (в другом приложении) и «Сохранить» (в выбранную папку). Файл скачивается частями.
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { DeckApi } from "@/core/api";
import { cachedPreview, isImage, PREVIEW_MAX, rememberPreview, sizeText } from "@/core/attachments";
import type { Attachment } from "@/core/types";
import { downloadToCache, openWithOtherApp, saveToFolder, type ChunkSource } from "@/platform/files";

import { Btn, errText, Notice, Row, Txt } from "./kit";
import { useTheme } from "./theme";

const hasThumb = (a: Attachment) => isImage(a.mime) && (!a.size || a.size <= PREVIEW_MAX);

function Thumb({ a, api, onOpen }: { a: Attachment; api: DeckApi | null; onOpen(uri: string): void }) {
  const { p } = useTheme();
  const [uri, setUri] = useState<string | undefined>(() => cachedPreview(a.id));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (uri || !api) return;
    let alive = true;
    api.attachment(a.id).then(
      (r) => {
        rememberPreview(a.id, r.mime, r.data);
        if (alive) setUri(cachedPreview(a.id));
      },
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [a.id, api, uri]);
  const box = { width: 96, height: 96, borderRadius: p.radius, borderWidth: 1, borderColor: p.line, backgroundColor: p.bg2 };
  if (failed) {
    return (
      <View style={[box, { alignItems: "center", justifyContent: "center", padding: 6 }]}>
        <Txt kind="small" numberOfLines={3}>🖼 {a.filename}</Txt>
      </View>
    );
  }
  return (
    <Pressable onPress={() => uri && onOpen(uri)} accessibilityLabel={`Открыть ${a.filename}`}>
      {uri ? <Image source={{ uri }} style={box} resizeMode="cover" /> : (
        <View style={[box, { alignItems: "center", justifyContent: "center" }]}><ActivityIndicator color={p.accent} /></View>
      )}
    </Pressable>
  );
}

/** «Открыть» и «Сохранить» для одного вложения, с прогрессом скачивания. */
function FileActions({ a, api }: { a: Attachment; api: DeckApi | null }) {
  const { p } = useTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const src: ChunkSource = (off) => api!.attachmentChunk(a.id, off);
  const progress = (what: string) => (d: number, t: number) => setBusy(`${what} ${t ? Math.round((d / t) * 100) : 0}%`);
  const run = async (tag: string, fn: () => Promise<string | null>) => {
    if (!api || busy) return;
    setBusy(tag);
    setMsg(null);
    try {
      const done = await fn();
      if (done) setMsg({ kind: "ok", text: done });
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    } finally {
      setBusy(null);
    }
  };
  const open = () => run("скачивается", async () => {
    const f = await downloadToCache(a.id, a.filename, a.size, src, progress("скачивается"));
    await openWithOtherApp(f, a.mime, a.filename);
    return null;
  });
  const save = () => run("сохраняется", async () => (await saveToFolder(a.filename, a.mime, src, progress("сохраняется"))) ? `Сохранено: ${a.filename}` : null);
  return (
    <View style={{ gap: 4 }}>
      <Row gap={6} style={{ flexWrap: "wrap" }}>
        <Btn small kind="ghost" title="Открыть" onPress={open} disabled={!!busy} />
        <Btn small kind="ghost" title="Сохранить" onPress={save} disabled={!!busy} />
        {busy ? <Txt kind="small" color={p.accent}>{busy}</Txt> : null}
      </Row>
      {msg ? <Notice kind={msg.kind} text={msg.text} /> : null}
    </View>
  );
}

export function AttachmentList({ items, api }: { items: Attachment[]; api: DeckApi | null }) {
  const { p } = useTheme();
  const [open, setOpen] = useState<{ a: Attachment; uri: string } | null>(null);
  const images = items.filter(hasThumb);
  const files = items.filter((a) => !hasThumb(a));
  return (
    <View style={{ gap: 6 }}>
      {images.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {images.map((a) => <Thumb key={a.id} a={a} api={api} onOpen={(uri) => setOpen({ a, uri })} />)}
        </View>
      ) : null}
      {files.map((a) => (
        <View key={a.id} style={{ gap: 4, borderLeftWidth: 2, borderLeftColor: p.line2, paddingLeft: 8 }}>
          <Txt kind="small" numberOfLines={2}>{isImage(a.mime) ? "🖼" : "📎"} {a.filename}{a.size ? ` · ${sizeText(a.size)}` : ""}</Txt>
          <FileActions a={a} api={api} />
        </View>
      ))}
      <Modal visible={!!open} transparent animationType="fade" onRequestClose={() => setOpen(null)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.94)" }}>
          <Pressable style={{ flex: 1 }} onPress={() => setOpen(null)} accessibilityLabel="Закрыть">
            {open ? <Image source={{ uri: open.uri }} style={{ flex: 1 }} resizeMode="contain" /> : null}
          </Pressable>
          {open ? (
            <View style={{ padding: 12, gap: 6 }}>
              <FileActions a={open.a} api={api} />
              <Txt kind="small" color={p.dim} style={{ textAlign: "center" }}>нажмите на картинку, чтобы закрыть</Txt>
            </View>
          ) : null}
        </SafeAreaView>
      </Modal>
    </View>
  );
}
