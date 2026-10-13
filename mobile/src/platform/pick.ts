/** Выбор фото или файла для вложения. Содержимое читается целиком в память (base64) — поэтому есть предел размера. */
import * as DocumentPicker from "expo-document-picker";
import { readAsStringAsync } from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";

import { base64Bytes, type PickedFile } from "@/core/attachments";

async function read(uri: string, name: string, mime: string, size?: number): Promise<PickedFile> {
  const base64 = await readAsStringAsync(uri, { encoding: "base64" });
  return { name, mime, base64, size: size && size > 0 ? size : base64Bytes(base64) };
}

/** Фото из галереи (системное окно выбора; разрешение на всю галерею не нужно). null — человек передумал. */
export async function pickPhoto(): Promise<PickedFile | null> {
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.85, exif: false });
  const a = r.canceled ? null : r.assets?.[0];
  if (!a) return null;
  const ext = (a.mimeType || "image/jpeg").split("/")[1]?.replace("jpeg", "jpg") || "jpg";
  return read(a.uri, a.fileName || `photo-${Date.now()}.${ext}`, a.mimeType || "image/jpeg", a.fileSize);
}

/** Любой файл через системное окно выбора. */
export async function pickFile(): Promise<PickedFile | null> {
  const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
  const a = r.canceled ? null : r.assets?.[0];
  if (!a) return null;
  return read(a.uri, a.name || "file", a.mimeType || "", a.size);
}
