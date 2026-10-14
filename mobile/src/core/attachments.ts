/** Вложения чата: что можно приложить и как это уходит на сервер (JSON с base64 — см. сервер, upload_json). */

/** Предел сервера для вложений с телефона. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS = 6;

export type PickedFile = { name: string; mime: string; size: number; base64: string };
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
  if (f.size > MAX_ATTACHMENT_BYTES) return `Файл «${f.name}» — ${sizeText(f.size)}; с телефона можно приложить до ${sizeText(MAX_ATTACHMENT_BYTES)}`;
  return null;
}

export const uploadBody = (f: PickedFile) => ({ filename: f.name.slice(0, 255) || "file", mime: f.mime || "", data: f.base64 });

export const isImage = (mime: string) => /^image\/(png|jpe?g|gif|webp|heic|heif)$/i.test(mime);

/** Картинки для предпросмотра: data:-адреса по id вложения. Свои (только что загруженные) — без повторной загрузки. */
const previews = new Map<string, string>();
const PREVIEW_LIMIT = 40;

export function rememberPreview(id: string, mime: string, base64: string) {
  if (!isImage(mime)) return;
  previews.set(id, `data:${mime};base64,${base64}`);
  while (previews.size > PREVIEW_LIMIT) previews.delete(previews.keys().next().value as string);
}
export const cachedPreview = (id: string) => previews.get(id);
