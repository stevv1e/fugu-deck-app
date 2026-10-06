import { useEffect, useState } from "react";
import { api, type Config, type UserRow } from "../api";
import { applyTheme, getTheme, THEMES } from "../themes";
import { AuditModal } from "./AuditModal";
import { Avatar, Section, TopBar } from "./ui";
import { useCluster } from "../cluster/context";
import { KeysSection } from "../cluster/KeysView";
import { cp } from "../cp";

export function ThemePreview({ id }: { id: string }) {
  return (
    <div className="theme-preview" data-theme={id}>
      <div className="tp-bar"><i /><span /><b>MAX</b></div>
      <div className="tp-user">сделай ревью PR</div>
      <div className="tp-ai"><span /><span /><span className="short" /></div>
      <div className="tp-tool"><span>Коммит</span><em>ok</em></div>
      <div className="tp-approve"><span className="no">отклонить</span><span className="yes">разрешить</span></div>
    </div>
  );
}

export function SettingsView(props: {
  config: Config;
  onMenu: () => void;
  toast: (m: string) => void;
  onLogout: () => void;
  onMeChanged: () => void;
}) {
  const cluster = useCluster();
  const me = props.config.me;
  const isOwner = !cluster && me.role === "owner"; // в кластере пользователями управляет control-plane
  const [codes, setCodes] = useState<any[] | null>(null);
  const [theme, setTheme] = useState(getTheme());
  const [displayName, setDisplayName] = useState(me.display_name);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [nu, setNu] = useState({ username: "", display_name: "", password: "" });
  const [audit, setAudit] = useState(false);

  const loadUsers = () => isOwner && api.users().then(setUsers).catch(() => {});
  useEffect(() => {
    loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (id: string) => {
    applyTheme(id);
    setTheme(id);
  };

  return (
    <div className="main">
      <TopBar onMenu={props.onMenu} title="Настройки" sub={`// ${me.display_name} · ${isOwner ? "владелец" : "участник"}`} />
      <div className="feed">
        <div className="page">
          <Section title="Оформление" hint="Тема сохраняется на этом устройстве. Нажмите, чтобы примерить.">
            <div className="themes">
              {THEMES.map((t) => (
                <button key={t.id} className={`theme-card ${theme === t.id ? "on" : ""}`} onClick={() => pick(t.id)}>
                  <ThemePreview id={t.id} />
                  <span className="theme-name">{t.name}</span>
                  <span className="theme-note">{t.note}</span>
                </button>
              ))}
            </div>
          </Section>

          {cluster && <KeysSection toast={props.toast} onSaved={() => cluster.pushKeys()} />}

          {cluster?.user.is_admin && (
            <Section title="Приглашения в сервис" hint="Код действует 72 часа и один раз. Отправьте человеку ссылку — он создаст passkey и получит своё пространство."
              right={<button className="btn slim primary" onClick={async () => {
                const c = await cp.newCode().catch((e) => { props.toast(e.message); return null; });
                if (c) setCodes([{ code: c.code, fresh: true }, ...(codes || [])]);
              }}>новый код</button>}>
              {codes === null ? (
                <button className="btn slim" onClick={() => cp.codes().then(setCodes).catch((e) => props.toast(e.message))}>показать коды</button>
              ) : (
                <div className="members">
                  {codes.map((c) => (
                    <div className="member" key={c.code}>
                      <span className="mono grow">{c.code}</span>
                      {c.used_by_nick ? <span className="chip">@{c.used_by_nick}</span> : (
                        <button className="btn slim" onClick={() => {
                          navigator.clipboard?.writeText(`${location.origin}/?invite=${c.code}`);
                          props.toast("Ссылка скопирована");
                        }}>ссылка</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>
          )}

          <Section title="Профиль">
            <div className="field">
              <label className="label">имя, которое видят другие</label>
              <div className="row">
                <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                <button className="btn" disabled={!displayName.trim() || displayName === me.display_name}
                  onClick={async () => {
                    if (cluster) await cp.patchMe(displayName.trim()).catch((e) => props.toast(e.message));
                    else await api.updateMe({ display_name: displayName.trim() }).catch((e) => props.toast(e.message));
                    props.onMeChanged();
                    props.toast("Сохранено");
                  }}>ok</button>
              </div>
            </div>
            {cluster && <p className="hint">Ник: <b className="mono">@{cluster.user.nick}</b>. Вход — по passkey, паролей нет.</p>}
            {!isOwner && !cluster && (
              <div className="field">
                <label className="label">смена пароля</label>
                <input className="input" type="password" placeholder="текущий пароль" value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
                <input className="input" type="password" placeholder="новый пароль (от 10 символов)" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
                <div className="row-end">
                  <button className="btn" disabled={!oldPw || newPw.length < 10} onClick={async () => {
                    try {
                      await api.updateMe({ old_password: oldPw, new_password: newPw });
                      setOldPw(""); setNewPw("");
                      props.toast("Пароль изменён");
                    } catch (e: any) { props.toast(e.message); }
                  }}>сменить</button>
                </div>
              </div>
            )}
            {isOwner && <p className="hint">Пароль и 2FA владельца задаются на сервере (APP_PASSWORD, TOTP_SECRET).</p>}
          </Section>

          {isOwner && (
            <Section title="Пользователи" hint="Создайте аккаунт и добавьте человека в нужные проекты (страница проекта → Участники).">
              <div className="members">
                {users.filter((u) => u.role !== "owner").map((u) => (
                  <div className={`member ${u.disabled ? "off" : ""}`} key={u.id}>
                    <Avatar name={u.display_name} />
                    <span className="grow">{u.display_name} <small className="dim">@{u.username}</small></span>
                    <button className="btn slim" onClick={async () => {
                      const pw = prompt(`Новый пароль для @${u.username} (от 10 символов):`);
                      if (!pw) return;
                      await api.patchUser(u.id, { password: pw }).then(() => props.toast("Пароль обновлён")).catch((e) => props.toast(e.message));
                    }}>пароль</button>
                    <button className="btn slim" onClick={async () => {
                      await api.patchUser(u.id, { disabled: !u.disabled }).catch((e) => props.toast(e.message));
                      loadUsers();
                    }}>{u.disabled ? "включить" : "отключить"}</button>
                    <button className="btn slim danger" onClick={async () => {
                      if (!confirm(`Удалить @${u.username}?`)) return;
                      await api.deleteUser(u.id).catch((e) => props.toast(e.message));
                      loadUsers();
                    }}>×</button>
                  </div>
                ))}
              </div>
              <div className="grid3">
                <input className="input" placeholder="логин" value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} />
                <input className="input" placeholder="имя" value={nu.display_name} onChange={(e) => setNu({ ...nu, display_name: e.target.value })} />
                <input className="input" placeholder="пароль (от 10)" type="password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
              </div>
              <div className="row-end">
                <button className="btn primary" disabled={!nu.username || !nu.display_name || nu.password.length < 10}
                  onClick={async () => {
                    try {
                      await api.createUser(nu.username, nu.display_name, nu.password);
                      setNu({ username: "", display_name: "", password: "" });
                      loadUsers();
                      props.toast("Пользователь создан");
                    } catch (e: any) { props.toast(e.message); }
                  }}>создать</button>
              </div>
            </Section>
          )}

          <Section title="Сервер">
            <dl className="kv">
              <dt>модели</dt><dd>{props.config.models.join(", ")}</dd>
              <dt>подтверждения</dt><dd>{props.config.approval_mode}</dd>
              {Object.entries(props.config.providers).map(([k, v]) => (
                <FragmentRow key={k} k={k} v={v.ok ? `@${v.login}` : "ошибка токена"} />
              ))}
            </dl>
            <div className="row-end">
              {isOwner && <button className="btn" onClick={() => setAudit(true)}>журнал действий</button>}
              <button className="btn danger" onClick={props.onLogout}>выйти</button>
            </div>
          </Section>
        </div>
      </div>
      {audit && <AuditModal onClose={() => setAudit(false)} />}
    </div>
  );
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return (<><dt>{k}</dt><dd>{v}</dd></>);
}
