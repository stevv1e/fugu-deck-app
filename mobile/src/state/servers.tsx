/**
 * Серверы пользователя: список, добавление (с проверкой отпечатка), регистрация телефона, сессии.
 * Список — несекретный (адрес, закреплённый ключ сервера, id устройства), ключи — в чипе или Keychain/Keystore.
 */
import { FdSecure } from "fd-secure";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform } from "react-native";

import { DeckApi } from "@/core/api";
import { randomId } from "@/core/bytes";
import { buildCsr } from "@/core/csr";
import { enroll } from "@/core/enroll";
import type { Http } from "@/core/http";
import { normFp } from "@/core/crypto";
import type { KeyProvider } from "@/core/keys";
import { checkExpected, checkPinned, fetchServerInfo } from "@/core/server";
import { DeviceSession } from "@/core/session";
import type { ServerInfo, ServerRecord } from "@/core/types";
import { keyProvider } from "@/platform/keys";
import { mtlsHttp, nativeMtlsAvailable, plainHttp } from "@/platform/http";
import { prefs } from "@/platform/storage";

const KEY = "fd:servers";
const RENEW_BEFORE = 7 * 86400;

export type Capabilities = Awaited<ReturnType<KeyProvider["describe"]>>;

type Ctx = {
  ready: boolean;
  servers: ServerRecord[];
  caps: Capabilities | null;
  get(id: string): ServerRecord | undefined;
  /** Проверить сервер по адресу (и отпечатку из QR) — ещё без сохранения. */
  probe(url: string, expectedFp?: string): Promise<ServerInfo>;
  add(info: ServerInfo, url: string, verifiedBy: "qr" | "manual", name?: string): Promise<ServerRecord>;
  remove(id: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  signIn(id: string, p: { username: string; password: string; totp?: string; deviceName: string }): Promise<void>;
  signOut(id: string): Promise<void>;
  api(id: string): Promise<DeckApi>;
  /** Сообщение о том, что сервер отозвал устройство (показываем на экране входа). */
  notices: Record<string, string>;
};

const ServersContext = createContext<Ctx | null>(null);

export function useServers(): Ctx {
  const c = useContext(ServersContext);
  if (!c) throw new Error("ServersProvider не подключён");
  return c;
}

const http0 = plainHttp();

function httpFor(rec: ServerRecord): Http {
  const d = rec.device;
  if (d?.certPem && rec.mtls !== "off" && nativeMtlsAvailable()) return mtlsHttp(d.keyAlias + ".s");
  return http0;
}

export function ServersProvider({ children }: { children: ReactNode }) {
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [ready, setReady] = useState(false);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const ref = useRef<ServerRecord[]>([]);
  const apis = useRef(new Map<string, Promise<DeckApi>>());

  useEffect(() => {
    (async () => {
      const list = await prefs.get<ServerRecord[]>(KEY, []);
      ref.current = list;
      setServers(list);
      setCaps(await (await keyProvider()).describe());
      setReady(true);
    })();
  }, []);

  const save = useCallback(async (list: ServerRecord[]) => {
    ref.current = list;
    setServers(list);
    await prefs.set(KEY, list);
  }, []);

  const patch = useCallback(
    async (id: string, p: Partial<ServerRecord>) => {
      await save(ref.current.map((s) => (s.id === id ? { ...s, ...p } : s)));
    },
    [save],
  );

  const get = useCallback((id: string) => ref.current.find((s) => s.id === id), []);

  const probe = useCallback(async (url: string, expectedFp?: string) => {
    const info = await fetchServerInfo(http0, url);
    checkExpected(info, expectedFp);
    return info;
  }, []);

  const add = useCallback(
    async (info: ServerInfo, url: string, verifiedBy: "qr" | "manual", name?: string) => {
      const fp = normFp(info.identity.fingerprint);
      const same = ref.current.find((s) => s.url === url && s.fingerprint === fp);
      if (same) return same;
      const rec: ServerRecord = {
        id: randomId(9),
        url,
        name: (name || info.name || url).slice(0, 60),
        identityKey: info.identity.key,
        fingerprint: fp,
        verifiedBy,
        addedAt: Date.now(),
        mtls: info.devices.mtls,
      };
      await save([...ref.current, rec]);
      return rec;
    },
    [save],
  );

  const dropDevice = useCallback(
    async (id: string, note?: string) => {
      const rec = ref.current.find((s) => s.id === id);
      apis.current.delete(id);
      if (rec?.device) await (await keyProvider()).remove(rec.device.keyAlias);
      await patch(id, { device: undefined });
      if (note) setNotices((n) => ({ ...n, [id]: note }));
    },
    [patch],
  );

  const remove = useCallback(
    async (id: string) => {
      await dropDevice(id);
      await save(ref.current.filter((s) => s.id !== id));
    },
    [dropDevice, save],
  );

  const rename = useCallback((id: string, name: string) => patch(id, { name: name.slice(0, 60) }), [patch]);

  const makeSession = useCallback(
    (rec: ServerRecord, keys: Awaited<ReturnType<KeyProvider["create"]>>) =>
      new DeviceSession(httpFor(rec), rec, keys, {
        onRevoked: (why) => {
          dropDevice(rec.id, `Сервер больше не принимает это устройство: ${why}. Войдите заново.`);
        },
      }),
    [dropDevice],
  );

  const signIn = useCallback<Ctx["signIn"]>(
    async (id, p) => {
      const rec = ref.current.find((s) => s.id === id);
      if (!rec) throw new Error("Сервер не найден");
      const info = await fetchServerInfo(http0, rec.url);
      checkPinned(info, rec);
      const prov = await keyProvider();
      const alias = `fd.${rec.id}.${randomId(6)}`;
      const wantCert = info.devices.mtls !== "off" && nativeMtlsAvailable();
      if (info.devices.mtls === "required" && !wantCert) {
        throw new Error("Сервер требует mTLS — нужна сборка приложения с модулем fd-secure (не Expo Go и не веб).");
      }
      try {
        const r = await enroll({
          http: http0,
          server: { ...rec, mtls: info.devices.mtls },
          makeKeys: (challenge) => prov.create(alias, challenge),
          username: p.username,
          password: p.password,
          totp: p.totp,
          deviceName: p.deviceName,
          platform: `${Platform.OS} ${String(Platform.Version ?? "")}`.trim(),
          withCert: wantCert,
        });
        if (r.device.certPem && FdSecure) await FdSecure.setClientCertificate(alias + ".s", r.device.certPem);
        const next = { ...rec, mtls: info.devices.mtls, device: r.device };
        await patch(id, { mtls: info.devices.mtls, device: r.device });
        const s = makeSession(next, r.keys);
        s.seed(r.accessToken, r.expiresIn, r.clockOffset);
        apis.current.set(id, Promise.resolve(new DeckApi(s)));
        setNotices((n) => {
          const { [id]: _, ...rest } = n;
          return rest;
        });
      } catch (e) {
        await prov.remove(alias);
        throw e;
      }
    },
    [makeSession, patch],
  );

  const api = useCallback(
    (id: string) => {
      const cached = apis.current.get(id);
      if (cached) return cached;
      const p = (async () => {
        const rec = ref.current.find((s) => s.id === id);
        if (!rec?.device) throw new Error("Сначала войдите на этот сервер");
        const info = await fetchServerInfo(http0, rec.url);
        checkPinned(info, rec);
        const keys = await (await keyProvider()).load(rec.device.keyAlias);
        if (!keys) {
          await dropDevice(id, "Ключи устройства не найдены (переустановка приложения или смена биометрии). Войдите заново.");
          throw new Error("Ключи устройства не найдены");
        }
        const a = new DeckApi(makeSession({ ...rec, mtls: info.devices.mtls }, keys));
        // сертификат mTLS продлеваем заранее — с самого устройства, подписью ключа сессии
        const d = rec.device;
        if (d.certPem && d.certExpires && d.certExpires - Date.now() / 1000 < RENEW_BEFORE) {
          try {
            const r = await a.renewCert(await buildCsr(keys.session, "fugu-deck device"));
            if (FdSecure) await FdSecure.setClientCertificate(d.keyAlias + ".s", r.cert_pem);
            await patch(id, { device: { ...d, certPem: r.cert_pem, caPem: r.ca_pem, certExpires: r.expires } });
          } catch {}
        }
        return a;
      })();
      apis.current.set(id, p);
      p.catch(() => apis.current.delete(id));
      return p;
    },
    [dropDevice, makeSession, patch],
  );

  const signOut = useCallback(
    async (id: string) => {
      const rec = ref.current.find((s) => s.id === id);
      if (rec?.device) {
        try {
          const a = await api(id);
          await a.revokeDevice(rec.device.id, "это устройство");
        } catch {
          // сервер недоступен или отмена биометрии — ключи всё равно удаляем; устройство можно отозвать с другого
        }
      }
      await dropDevice(id);
    },
    [api, dropDevice],
  );

  const value = useMemo<Ctx>(
    () => ({ ready, servers, caps, get, probe, add, remove, rename, signIn, signOut, api, notices }),
    [ready, servers, caps, get, probe, add, remove, rename, signIn, signOut, api, notices],
  );
  return <ServersContext.Provider value={value}>{children}</ServersContext.Provider>;
}
