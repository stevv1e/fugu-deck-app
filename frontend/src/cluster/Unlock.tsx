import { useState } from "react";
import { cp } from "../cp";
import { Logo } from "../components/icons";
import { vault } from "../vault";
import { getPasskey } from "../webauthn";

/** Разблокировка ключей на устройстве: Face ID (PRF) или PIN. */
export function Unlock({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const method = vault.method();

  const faceId = async () => {
    setBusy(true); setErr("");
    try {
      const o = await cp.loginOptions();
      const pk = await getPasskey(o.options);
      await cp.loginVerify(o.session_id, pk.credential);
      if (!pk.prf) throw new Error("Этот passkey не поддерживает PRF — используйте PIN");
      if (!(await vault.unlockWithPrf(pk.prf))) throw new Error("Не удалось расшифровать — другой passkey?");
      onDone();
    } catch (e: any) {
      setErr(e?.name === "NotAllowedError" ? "Отменено" : e.message);
    } finally { setBusy(false); }
  };

  const withPin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr("");
    if (await vault.unlockWithPin(pin)) onDone();
    else setErr("Неверный PIN");
    setBusy(false);
  };

  return (
    <div className="login">
      <div className="login-card cut">
        <Logo size={44} />
        <h1>КЛЮЧИ<span>/</span>LOCKED</h1>
        <p>Ключи API зашифрованы на этом устройстве. Разблокируйте, чтобы агент мог работать.</p>
        {method === "pin" ? (
          <form onSubmit={withPin}>
            <div className="field">
              <label className="label" htmlFor="pin">pin</label>
              <input id="pin" className="input" type="password" inputMode="numeric" autoFocus value={pin}
                onChange={(e) => setPin(e.target.value)} />
            </div>
            {err && <div className="err">✕ {err}</div>}
            <button className="btn primary" style={{ width: "100%", height: 50 }} disabled={busy || pin.length < 4}>разблокировать</button>
          </form>
        ) : (
          <>
            {err && <div className="err">✕ {err}</div>}
            <button className="btn primary" style={{ width: "100%", height: 50 }} disabled={busy} onClick={faceId}>
              {busy ? "…" : "разблокировать passkey"}
            </button>
          </>
        )}
        <button className="btn ghost" style={{ width: "100%", marginTop: 10 }} onClick={onSkip}>без ключей (только просмотр)</button>
      </div>
    </div>
  );
}
