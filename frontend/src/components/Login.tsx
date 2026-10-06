import { useEffect, useState } from "react";
import { api } from "../api";
import { Logo } from "./icons";

export function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState(() => { try { return localStorage.getItem("fd:user") || ""; } catch { return ""; } });
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.authInfo().then((i) => setNeedTotp(i.owner_totp)).catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await api.login(username.trim(), password, totp || undefined);
      try { localStorage.setItem("fd:user", username.trim()); } catch {}
      onDone();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card cut" onSubmit={submit}>
        <Logo size={44} />
        <h1>
          FUGU<span>/</span>DECK
        </h1>
        <p>Агент для ваших репозиториев и команды. Вход по приглашению.</p>
        <div className="field">
          <label className="label" htmlFor="user">логин <small>(пусто — владелец)</small></label>
          <input id="user" className="input" autoComplete="username" autoCapitalize="none"
            value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="pw">пароль</label>
          <input id="pw" className="input" type="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {needTotp && (
          <div className="field">
            <label className="label" htmlFor="totp">код 2fa <small>(для владельца)</small></label>
            <input id="totp" className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))} />
          </div>
        )}
        {err && <div className="err">✕ {err}</div>}
        <button className="btn primary" style={{ width: "100%", height: 46 }} disabled={busy || !password}>
          {busy ? "проверка…" : "войти"}
        </button>
      </form>
    </div>
  );
}
