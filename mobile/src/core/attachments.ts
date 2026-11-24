/**
 * Вложения чата: что можно приложить и как это уходит на сервер. Защищённый канал передаёт тело только текстом,
 * поэтому файл идёт в JSON как base64: маленький — одним запросом, большой — частями по 2 МБ (сервер: uploads).
 */

/** Пределы сервера для обычных вложений и медиа (загрузка частями). */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_MEDIA_ATTACHMENT_BYTES = 2048 * 1024 * 1024;
const MEDIA_EXT = /\.(mp3|wav|flac|ogg|m4a|aac|webm|mp4|mpeg|mov|mkv)$/i;
export const MAX_ATTACHMENTS = 6;
/** До этого размера — одним запросом. */
export const SMALL_UPLOAD = 2 * 1024 * 1024;
/** Миниатюры — для картинок до этого размера (их отдаёт сервер целиком). */
export const PREVIEW_MAX = 8 * 1024 * 1024;

/** Выбранный файл: содержимое не в памяти, читается с диска по uri кусками. */
export type PickedFile = { name: string; mime: string; size: number; uri: string };
export type Uploaded = { id: string; filename: string; mime: string; size: number };

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;
}

/** Размер файла по длине base64 (без чтения самого файла). */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** Почему файл нельзя приложить; null — можно. Проверяется до загрузки: большой файл не гоняем через сеть зря. */
export function attachProblem(f: Pick<PickedFile, "name" | "size">, already: number): string | null {
  if (already >= MAX_ATTACHMENTS) return `К сообщению можно приложить не больше ${MAX_ATTACHMENTS} файлов`;
  if (f.size <= 0) return `Файл «${f.name}» пустой`;
  const limit = MEDIA_EXT.test(f.name) ? MAX_MEDIA_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES;
  if (f.size > limit) return `Файл «${f.name}» — ${sizeText(f.size)}; можно приложить до ${sizeText(limit)}`;
  return null;
}

export const uploadBody = (f: Pick<PickedFile, "name" | "mime">, data: string) => ({ filename: f.name.slice(0, 255) || "file", mime: f.mime || "", data });

type Req = <T>(method: string, path: string, body?: unknown, opts?: { timeoutMs?: number }) => Promise<T>;
/** Чтение файла в base64: целиком или кусок [position, position+length). */
export type FileReader = { all(uri: string, size?: number): Promise<string>; chunk(uri: string, position: number, length: number): Promise<string> };
export type UploadOptions = {
  signal?: AbortSignal;
  resumeId?: string;
  onUploadId?: (id: string | null) => void;
};

function checkUploadAbort(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Загрузка отменена");
  error.name = "AbortError";
  throw error;
}

/** Загрузить файл в чат: маленький — одним запросом, большой — частями; onProgress(загружено, всего). */
export async function uploadFile(req: Req, cid: string, f: PickedFile, read: FileReader, onProgress?: (done: number, total: number) => void, options: UploadOptions = {}): Promise<Uploaded> {
  const enc = encodeURIComponent;
  checkUploadAbort(options.signal);
  if (f.size <= SMALL_UPLOAD) {
    const up = await req<Uploaded>("POST", `/api/conversations/${enc(cid)}/attachments/json`, uploadBody(f, await read.all(f.uri, f.size)), { timeoutMs: 120000 });
    checkUploadAbort(options.signal);
    onProgress?.(f.size, f.size);
    return up;
  }
  let st: { upload_id: string; chunk_bytes: number; got: number; size: number } | null = null;
  if (options.resumeId) {
    try {
      st = await req<{ upload_id: string; chunk_bytes: number; got: number; size: number }>("GET", `/api/uploads/${enc(options.resumeId)}`);
      if (st.size !== f.size || st.got < 0 || st.got > f.size) throw new Error("Сохранённая загрузка не соответствует файлу");
    } catch (e) {
      if ((e as { status?: number })?.status !== 404) throw e;
    }
  }
  if (!st) {
    const started = await req<{ upload_id: string; chunk_bytes: number }>("POST", `/api/conversations/${enc(cid)}/uploads`, { filename: f.name.slice(0, 255) || "file", mime: f.mime || "", size: f.size });
    st = { ...started, got: 0, size: f.size };
  }
  options.onUploadId?.(st.upload_id);
  let got = st.got;
  onProgress?.(got, f.size);
  try {
    for (let tries = 0; got < f.size; ) {
      checkUploadAbort(options.signal);
      const data = await read.chunk(f.uri, got, Math.min(st.chunk_bytes, f.size - got));
      checkUploadAbort(options.signal);
      // файл на телефоне короче, чем было заявлено (или изменился во время загрузки): повторять бессмысленно
      if (!data) throw new Error(`Файл «${f.name}» прочитан не целиком (${got} из ${f.size} байт) — выберите его заново`);
      try {
        const r = await req<{ got: number }>("POST", `/api/uploads/${enc(st!.upload_id)}/chunk`, { offset: got, data }, { timeoutMs: 90000 });
        if (r.got <= got) throw new Error("Сервер не принял часть файла");
        got = r.got;
        tries = 0;
        onProgress?.(got, f.size);
      } catch (e) {
        checkUploadAbort(options.signal);
        // обрыв сети — повторяем ту же часть (сервер повтор уже принятой не задвоит), но не бесконечно
        if (++tries >= 3) throw e;
      }
    }
    checkUploadAbort(options.signal);
    const uploaded = await req<Uploaded>("POST", `/api/uploads/${enc(st.upload_id)}/finish`);
    options.onUploadId?.(null);
    return uploaded;
  } catch (e) {
    if (options.signal?.aborted) {
      await req("DELETE", `/api/uploads/${enc(st.upload_id)}`).catch(() => {});
      options.onUploadId?.(null);
    }
    throw e;
  }
}

export const isImage = (mime: string) => /^image\/(png|jpe?g|gif|webp|heic|heif)$/i.test(mime);

/** Картинки для предпросмотра: data:-адреса по id вложения. Свои (только что загруженные) — без повторной загрузки. */
const previews = new Map<string, string>();
const PREVIEW_LIMIT = 40;

export function rememberPreview(id: string, mime: string, base64: string) {
  rememberPreviewUri(id, mime, `data:${mime};base64,${base64}`);
}

/** Своя картинка (только что загруженная) — показываем прямо с диска телефона. */
export function rememberPreviewUri(id: string, mime: string, uri: string) {
  if (!isImage(mime)) return;
  previews.set(id, uri);
  while (previews.size > PREVIEW_LIMIT) previews.delete(previews.keys().next().value as string);
}
export const cachedPreview = (id: string) => previews.get(id);
