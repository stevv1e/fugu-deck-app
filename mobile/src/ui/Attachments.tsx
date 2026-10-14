/** Вложения в ленте чата: картинки — миниатюрами (нажатие — на весь экран), остальные файлы — строкой. */
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { DeckApi } from "@/core/api";
import { cachedPreview, isImage, rememberPreview, sizeText } from "@/core/attachments";
import type { Attachment } from "@/core/types";

import { Txt } from "./kit";
import { useTheme } from "./theme";

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

export function AttachmentList({ items, api }: { items: Attachment[]; api: DeckApi | null }) {
  const { p } = useTheme();
  const [open, setOpen] = useState<string | null>(null);
  const images = items.filter((a) => isImage(a.mime));
  const files = items.filter((a) => !isImage(a.mime));
  return (
    <View style={{ gap: 6 }}>
      {images.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {images.map((a) => <Thumb key={a.id} a={a} api={api} onOpen={setOpen} />)}
        </View>
      ) : null}
      {files.map((a) => <Txt key={a.id} kind="small">📎 {a.filename}{a.size ? ` · ${sizeText(a.size)}` : ""}</Txt>)}
      <Modal visible={!!open} transparent animationType="fade" onRequestClose={() => setOpen(null)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.94)" }}>
          <Pressable style={{ flex: 1 }} onPress={() => setOpen(null)} accessibilityLabel="Закрыть">
            {open ? <Image source={{ uri: open }} style={{ flex: 1 }} resizeMode="contain" /> : null}
            <Txt kind="small" color={p.dim} style={{ textAlign: "center", padding: 12 }}>нажмите, чтобы закрыть</Txt>
          </Pressable>
        </SafeAreaView>
      </Modal>
    </View>
  );
}
