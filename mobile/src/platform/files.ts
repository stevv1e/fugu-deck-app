/**
 * Файлы вложений на телефоне: чтение кусками для загрузки, скачивание в кэш (открыть в другом приложении)
 * и сохранение в выбранную папку. base64 считает нативный код: в JS 50 МБ разбирались бы минутами.
 */
import { Directory, File, Paths } from "expo-file-system";
import { readAsStringAsync } from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";

/** Кусок файла [position, position+length) в base64. */
export const readChunk = (uri: string, position: number, length: number) =>
  readAsStringAsync(uri, { encoding: "base64", position, length });

export const readAll = (uri: string) => readAsStringAsync(uri, { encoding: "base64" });

/** Источник кусков файла с сервера: base64 и признак конца. */
export type ChunkSource = (offset: number) => Promise<{ data: string; eof: boolean; size: number }>;

async function pump(dst: File, next: ChunkSource, onProgress?: (done: number, total: number) => void) {
  let off = 0;
  let first = true;
  for (;;) {
    const c = await next(off);
    dst.write(c.data, { encoding: "base64", append: !first });
    first = false;
    off += Math.floor((c.data.length * 3) / 4) - (c.data.endsWith("==") ? 2 : c.data.endsWith("=") ? 1 : 0);
    onProgress?.(off, c.size);
    if (c.eof) return;
  }
}

const safe = (name: string) => name.replace(/[/\\:*?"<>|]+/g, "_").slice(0, 120) || "file";

/** Скачать в кэш приложения (повторно не качает, если файл уже там целиком). */
export async function downloadToCache(id: string, name: string, size: number, next: ChunkSource, onProgress?: (d: number, t: number) => void) {
  const dir = new Directory(Paths.cache, "attachments");
  if (!dir.exists) dir.create({ intermediates: true });
  const f = new File(dir, `${id}_${safe(name)}`);
  if (f.exists && f.size === size) return f;
  if (f.exists) f.delete();
  f.create();
  try {
    await pump(f, next, onProgress);
  } catch (e) {
    if (f.exists) f.delete();
    throw e;
  }
  return f;
}

/** Открыть файл в другом приложении (системное окно «Открыть с помощью / Поделиться»). */
export async function openWithOtherApp(f: File, mime: string, title: string) {
  if (!(await Sharing.isAvailableAsync())) throw new Error("На этом устройстве нельзя передать файл другому приложению");
  await Sharing.shareAsync(f.uri, { mimeType: mime || undefined, dialogTitle: title });
}

/** Сохранить в папку, которую человек выберет. false — папку не выбрали. */
export async function saveToFolder(name: string, mime: string, next: ChunkSource, onProgress?: (d: number, t: number) => void): Promise<boolean> {
  if (Platform.OS !== "android") throw new Error("Сохранение в папку пока есть только на Android — используйте «Открыть»");
  let dir: Directory;
  try {
    dir = await Directory.pickDirectoryAsync();
  } catch {
    return false; // окно выбора закрыто
  }
  const f = dir.createFile(safe(name), mime || "application/octet-stream");
  await pump(f, next, onProgress);
  return true;
}

/** Размер выбранного файла, если система его не сообщила. */
export function sizeOf(uri: string): number {
  try {
    return new File(uri).size ?? 0;
  } catch {
    return 0;
  }
}
