/** Выбор фото или файла для вложения. Содержимое читается целиком в память (base64) — поэтому есть предел размера. */
import * as DocumentPicker from "expo-document-picker";
import { readAsStringAsync, StorageAccessFramework, writeAsStringAsync } from "expo-file-system/legacy";
import { Platform } from "react-native";
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

/** Снимок камерой. Разрешение на камеру спрашивается при первом снимке; отказ — понятная ошибка. */
export async function takePhoto(): Promise<PickedFile | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error("Нет доступа к камере: разрешите его приложению в настройках телефона");
  const r = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.7, exif: false });
  const a = r.canceled ? null : r.assets?.[0];
  if (!a) return null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return read(a.uri, `camera-${stamp}.jpg`, a.mimeType || "image/jpeg", a.fileSize);
}

/** Любой файл через системное окно выбора. */
export async function pickFile(): Promise<PickedFile | null> {
  const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
  const a = r.canceled ? null : r.assets?.[0];
  if (!a) return null;
  return read(a.uri, a.name || "file", a.mimeType || "", a.size);
}

/** Текстовый файл через системное окно выбора (импорт проекта). null — человек передумал. */
export async function pickText(maxBytes = 20 * 1024 * 1024): Promise<{ name: string; text: string } | null> {
  const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false, type: ["application/json", "text/*", "*/*"] });
  const a = r.canceled ? null : r.assets?.[0];
  if (!a) return null;
  if (a.size && a.size > maxBytes) throw new Error("Файл слишком большой");
  return { name: a.name || "file", text: await readAsStringAsync(a.uri) };
}

/**
 * Сохранить текст в файл в папке, которую человек выберет (Android: системное окно выбора папки).
 * false — человек не выбрал папку.
 */
export async function saveText(name: string, mime: string, text: string): Promise<boolean> {
  if (Platform.OS !== "android") throw new Error("Сохранение в файл пока есть только на Android");
  const perm = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!perm.granted) return false;
  const uri = await StorageAccessFramework.createFileAsync(perm.directoryUri, name, mime);
  await writeAsStringAsync(uri, text);
  return true;
}
