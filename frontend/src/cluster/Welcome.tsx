import { useEffect, useState } from "react";
import { cp } from "../cp";
import { Logo } from "../components/icons";
import { createPasskey, getPasskey, webauthnSupported } from "../webauthn";

export type AuthResult = { prf: Uint8Array | null; prfEnabled: boolean; fresh: boolean };

/** Вход и регистрация по passkey. Пароля нет вообще. */
export function Welcome({ onDone }: { onDone: (r: AuthResult) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [bootstrap, setBootstrap] = useState(false);
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get("invite") || "");
  const [nick, setNick] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    cp.detect().then((i) => {
      if (i?.bootstrap) { setBootstrap(true); setMode("register"); }
    });
    if (code) setMode("register");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = async () => {
    setBusy(true); setErr("");
    try {
      const o = await cp.loginOptions();
      const pk = await getPasskey(o.options);
      await cp.loginVerify(o.session_id, pk.credential);
      onDone({ prf: pk.prf, prfEnabled: pk.prfEnabled, fresh: false });
    } catch (e: any) {
      setErr(e?.name === "NotAllowedError" ? "Отменено" : e.message);
    } finally { setBusy(false); }
  };

  const register = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const o = await cp.registerOptions(code, nick.trim().toLowerCase(), name.trim());
      const pk = await createPasskey(o.options);
      await cp.registerVerify(o.session_id, pk.credential);
      onDone({ prf: pk.prf, prfEnabled: pk.prfEnabled, fresh: true });
    } catch (e: any) {
      setErr(e?.name === "NotAllowedError" ? "Отменено" : e.message);
    } finally { setBusy(false); }
  };

  return (
    <div className="login">
      <div className="login-card cut">
        <Logo size={44} />
        <h1>FUGU<span>/</span>DECK</h1>
        <p>{bootstrap ? "Первый запуск: создайте учётную запись администратора." : "Вход по passkey — Face ID, отпечаток или ключ устройства. Паролей нет."}</p>
        {!webauthnSupported() && <div className="err">✕ Браузер не поддерживает passkey</div>}
        {!bootstrap && (
          <div className="seg wide" style={{ marginBottom: 16 }}>
            <button className={mode === "login" ? "on" : ""} onClick={() => setMode("login")} type="button">вход</button>
            <button className={mode === "register" ? "on" : ""} onClick={() => setMode("register")} type="button">по приглашению</button>
          </div>
        )}
        {mode === "login" ? (
          <>
            {err && <div className="err">✕ {err}</div>}
            <button className="btn primary" style={{ width: "100%", height: 50 }} disabled={busy} onClick={login}>
              {busy ? "…" : "войти с passkey"}
            </button>
          </>
        ) : (
          <form onSubmit={register}>
            <div className="field">
              <label className="label" htmlFor="code">{bootstrap ? "код первого запуска (CP_BOOTSTRAP_CODE)" : "код приглашения"}</label>
              <input id="code" className="input" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" />
            </div>
            <div className="field">
              <label className="label" htmlFor="nick">ник <small>(латиница, по нему вас приглашают)</small></label>
              <input id="nick" className="input" value={nick} autoCapitalize="none"
                onChange={(e) => setNick(e.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ""))} />
            </div>
            <div className="field">
              <label className="label" htmlFor="name">имя</label>
              <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            {err && <div className="err">✕ {err}</div>}
            <button className="btn primary" style={{ width: "100%", height: 50 }} disabled={busy || !code || nick.length < 3 || !name.trim()}>
              {busy ? "…" : "создать passkey"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
