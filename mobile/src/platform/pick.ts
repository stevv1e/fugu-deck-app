/** Выбор фото или файла для вложения. Содержимое читается целиком в память (base64) — поэтому есть предел размера. */
import * as DocumentPicker from "expo-document-picker";
import { readAsStringAsync, StorageAccessFramework, writeAsStringAsync } from "expo-file-system/legacy";
import { Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";

import type { PickedFile } from "@/core/attachments";

import { sizeOf } from "./files";

// Размер — у самого файла на диске: галерея сообщает размер исходного фото, а выбранное фото уже пережато
// (quality) и меньше. Поверив галерее, загрузка читала бы за концом файла.
const picked = (uri: string, name: string, mime: string, size?: number | null): PickedFile => {
  const real = sizeOf(uri);
  return { uri, name, mime, size: real > 0 ? real : size && size > 0 ? size : 0 };
};

/** Фото из галереи, можно несколько (системное окно выбора; разрешение на всю галерею не нужно). */
export async function pickPhotos(limit: number): Promise<PickedFile[]> {
  const r = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"], quality: 0.85, exif: false, allowsMultipleSelection: limit > 1, selectionLimit: Math.max(1, limit),
  });
  if (r.canceled) return [];
  return (r.assets ?? []).slice(0, limit).map((a, i) => {
    const ext = (a.mimeType || "image/jpeg").split("/")[1]?.replace("jpeg", "jpg") || "jpg";
    return picked(a.uri, a.fileName || `photo-${Date.now()}-${i + 1}.${ext}`, a.mimeType || "image/jpeg", a.fileSize);
  });
}

/** Снимок камерой. Разрешение на камеру спрашивается при первом снимке; отказ — понятная ошибка. */
export async function takePhoto(): Promise<PickedFile | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error("Нет доступа к камере: разрешите его приложению в настройках телефона");
  const r = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.7, exif: false });
  const a = r.canceled ? null : r.assets?.[0];
  if (!a) return null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return picked(a.uri, `camera-${stamp}.jpg`, a.mimeType || "image/jpeg", a.fileSize);
}

/** Любые файлы через системное окно выбора (архивы, документы…), можно несколько. */
export async function pickFiles(limit: number): Promise<PickedFile[]> {
  const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: limit > 1 });
  if (r.canceled) return [];
  return (r.assets ?? []).slice(0, limit).map((a) => picked(a.uri, a.name || "file", a.mimeType || "", a.size));
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
