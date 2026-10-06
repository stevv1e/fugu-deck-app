/** PRF-секрет последнего входа держим в памяти до создания хранилища ключей (не дольше). */
let pending: Uint8Array | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function setPendingPrf(p: Uint8Array | null) {
  pending = p;
  clearTimeout(timer);
  if (p) timer = setTimeout(() => (pending = null), 10 * 60 * 1000);
}

export function takePendingPrf(): Uint8Array | null {
  const p = pending;
  pending = null;
  return p;
}
