import { useEffect, useState } from "react";
import { cp } from "../cp";
import { Section } from "../components/ui";
import { vault, type Keys } from "../vault";
import { getPasskey } from "../webauthn";
import { takePendingPrf } from "./prf";

const FIELDS: [keyof Keys, string, string][] = [
  ["anthropic", "Claude (Anthropic)", "sk-ant-…"],
  ["sakana", "Sakana Fugu", "ключ из console.sakana.ai"],
  ["github", "GitHub токен", "github_pat_… (fine-grained)"],
  ["gitlab", "GitLab токен", "glpat-…"],
  ["gitlab_url", "GitLab адрес", "https://gitlab.com"],
];

export function KeysSection({ onSaved, toast }: { onSaved: () => void; toast: (m: string) => void }) {
  const [vals, setVals] = useState<Keys>(vault.keys());
  const [show, setShow] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const exists = vault.exists();
  const unlocked = vault.unlocked();

  useEffect(() => vault.subscribe(() => setVals(vault.keys())) as any, []);

  const save = async (method?: "prf" | "pin") => {
    setBusy(true);
    try {
      if (exists) {
        await vault.save(vals);
      } else if (method === "pin") {
        if (pin.length < 6) throw new Error("PIN — минимум 6 цифр");
        await vault.create("pin", pin, vals);
      } else {
        let prf = takePendingPrf();
        if (!prf) {
          const o = await cp.loginOptions();
          const pk = await getPasskey(o.options);
          await cp.loginVerify(o.session_id, pk.credential);
          prf = pk.prf;
        }
        if (!prf) throw new Error("Passkey на этом устройстве не поддерживает PRF — выберите PIN");
        await vault.create("prf", prf, vals);
      }
      toast("Ключи зашифрованы и сохранены на этом устройстве");
      onSaved();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (exists && !unlocked) {
    return (
      <Section title="Ключи API" hint="Ключи зашифрованы на устройстве и сейчас заблокированы.">
        <div className="notice">// откройте приложение заново или нажмите «разблокировать» на главном экране</div>
      </Section>
    );
  }

  return (
    <Section title="Ключи API и доступы"
      hint={<>Хранятся <b>только на этом устройстве</b>, зашифрованы {exists ? (vault.method() === "prf" ? "passkey" : "PIN-кодом") : "passkey или PIN"}.
        На сервер уходят лишь в оперативную память на время работы агента.</>}
      right={<button className="btn slim" onClick={() => setShow(!show)}>{show ? "скрыть" : "показать"}</button>}>
      {FIELDS.map(([k, label, ph]) => (
        <div className="field" key={k}>
          <label className="label">{label}</label>
          <input className="input" type={show || k === "gitlab_url" ? "text" : "password"} placeholder={ph}
            autoComplete="off" spellCheck={false} value={vals[k] || ""}
            onChange={(e) => setVals({ ...vals, [k]: e.target.value })} />
        </div>
      ))}
      {exists ? (
        <div className="row-end">
          <button className="btn danger" onClick={() => { if (confirm("Удалить все ключи с этого устройства?")) { vault.wipe(); onSaved(); } }}>стереть</button>
          <button className="btn primary" disabled={busy} onClick={() => save()}>сохранить</button>
        </div>
      ) : (
        <>
          <div className="row-end">
            <button className="btn primary" disabled={busy} onClick={() => save("prf")}>защитить passkey</button>
          </div>
          <div className="row-end">
            <input className="input slim" type="password" inputMode="numeric" placeholder="или PIN (от 6 цифр)"
              value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
            <button className="btn" disabled={busy || pin.length < 6} onClick={() => save("pin")}>защитить PIN</button>
          </div>
        </>
      )}
    </Section>
  );
}
