/** Знакомство с сервером: что он о себе говорит и тот ли это сервер. */
import { fingerprintOf, normFp } from "./crypto";
import { ApiError, errorFrom, type Http } from "./http";
import type { ServerInfo, ServerRecord } from "./types";

export class TrustError extends Error {
  constructor(
    message: string,
    public kind: "mismatch" | "changed" | "invalid",
  ) {
    super(message);
  }
}

export async function getJson<T>(http: Http, url: string, timeoutMs = 15000): Promise<T> {
  const r = await http.request({ method: "GET", url, headers: { accept: "application/json" }, timeoutMs });
  if (r.status !== 200) throw errorFrom(r.status, r.text);
  try {
    return JSON.parse(r.text) as T;
  } catch {
    throw new ApiError(r.status, "Сервер ответил не JSON");
  }
}

/** Получить и проверить карточку сервера. Отпечаток пересчитываем сами из ключа — не верим полю на слово. */
export async function fetchServerInfo(http: Http, url: string): Promise<ServerInfo> {
  let info: ServerInfo;
  try {
    info = await getJson<ServerInfo>(http, url + "/.well-known/fugu-deck", 10000);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      throw new TrustError(
        "По этому адресу нет сервера Fugu Deck. Кластер с входом через Keycloak подключается иначе — эта версия приложения работает с отдельными серверами.",
        "invalid",
      );
    }
    throw e;
  }
  if (info?.app !== "fugu-deck" || !info.identity?.key) throw new TrustError("Это не сервер Fugu Deck", "invalid");
  if (info.protocol !== 1) throw new TrustError(`Сервер говорит на версии протокола ${info.protocol}, приложение — на 1. Обновите приложение.`, "invalid");
  const fp = fingerprintOf(info.identity.key);
  if (normFp(fp) !== normFp(info.identity.fingerprint)) {
    throw new TrustError("Сервер прислал отпечаток, который не соответствует его ключу", "invalid");
  }
  return { ...info, identity: { ...info.identity, fingerprint: fp } };
}

/** Отпечаток из QR должен совпасть с ключом сервера. */
export function checkExpected(info: ServerInfo, expectedFp?: string): void {
  if (expectedFp && normFp(expectedFp) !== normFp(info.identity.fingerprint)) {
    throw new TrustError(
      "Отпечаток сервера не совпадает с приглашением. Возможно, кто-то подменил сервер или адрес. Не подключайтесь и сообщите владельцу.",
      "mismatch",
    );
  }
}

/** Закреплённый ключ уже добавленного сервера не должен меняться. */
export function checkPinned(info: ServerInfo, rec: ServerRecord): void {
  if (info.identity.key !== rec.identityKey) {
    throw new TrustError(
      "Ключ сервера изменился с момента добавления. Это бывает при переустановке сервера — или при подмене. Сверьте новый отпечаток с владельцем и добавьте сервер заново.",
      "changed",
    );
  }
}
