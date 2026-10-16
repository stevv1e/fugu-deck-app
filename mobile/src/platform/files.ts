/**
 * Файлы вложений на телефоне: чтение кусками для загрузки, скачивание в кэш (открыть в другом приложении)
 * и сохранение в выбранную папку. base64 считает нативный код: в JS 50 МБ разбирались бы минутами.
 */
import { Directory, File, Paths } from "expo-file-system";
import { readAsStringAsync } from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";

import { desk, isDesktop } from "./desktop";

/** Кусок файла [position, position+length) в base64. */
export const readChunk = (uri: string, position: number, length: number) =>
  isDesktop ? desk<string>("read_chunk", { path: uri, position, length }) : readAsStringAsync(uri, { encoding: "base64", position, length });

export const readAll = async (uri: string) =>
  isDesktop ? readChunk(uri, 0, await desk<number>("file_size", { path: uri })) : readAsStringAsync(uri, { encoding: "base64" });

/** Windows: скачать куски сервера в файл по пути (кэш вложений или выбранный в «Сохранить как»). */
async function pumpDesktop(path: string, next: ChunkSource, onProgress?: (done: number, total: number) => void) {
  let off = 0;
  let first = true;
  for (;;) {
    const c = await next(off);
    await desk("write_file", { path, data: c.data, append: !first });
    first = false;
    off += Math.floor((c.data.length * 3) / 4) - (c.data.endsWith("==") ? 2 : c.data.endsWith("=") ? 1 : 0);
    onProgress?.(off, c.size);
    if (c.eof) return;
  }
}

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
export async function downloadToCache(id: string, name: string, size: number, next: ChunkSource, onProgress?: (d: number, t: number) => void): Promise<{ uri: string }> {
  if (isDesktop) {
    const path = await desk<string>("cache_path", { name: `${id}_${safe(name)}` });
    if ((await desk<number>("file_size", { path }).catch(() => -1)) === size) return { uri: path };
    try {
      await pumpDesktop(path, next, onProgress);
    } catch (e) {
      await desk("remove_file", { path }).catch(() => {});
      throw e;
    }
    return { uri: path };
  }
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
export async function openWithOtherApp(f: { uri: string }, mime: string, title: string) {
  if (isDesktop) return desk<void>("open_file", { path: f.uri }); // программой по умолчанию
  if (!(await Sharing.isAvailableAsync())) throw new Error("На этом устройстве нельзя передать файл другому приложению");
  await Sharing.shareAsync(f.uri, { mimeType: mime || undefined, dialogTitle: title });
}

/** Сохранить в папку, которую человек выберет. false — папку не выбрали. */
export async function saveToFolder(name: string, mime: string, next: ChunkSource, onProgress?: (d: number, t: number) => void): Promise<boolean> {
  if (isDesktop) {
    const path = await desk<string | null>("save_dialog", { name: safe(name) });
    if (!path) return false;
    await pumpDesktop(path, next, onProgress);
    return true;
  }
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
  if (isDesktop) return 0; // на Windows размер сообщает окно выбора
  try {
    return new File(uri).size ?? 0;
  } catch {
    return 0;
  }
}
