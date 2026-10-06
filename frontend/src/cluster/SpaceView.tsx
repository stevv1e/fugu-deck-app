import { useEffect, useRef, useState } from "react";
import { api, type Project } from "../api";
import { cp, spaceTokenFn, type SpaceFull, type SpaceRole } from "../cp";
import { Avatar, ROLE_LABEL, Section, TopBar } from "../components/ui";
import { useCluster } from "./context";
import { UsageSummary } from "../components/UsageSummary";

async function importInto(sid: string, data: any) {
  const tok = await spaceTokenFn(sid)(true);
  const r = await fetch(`/s/${sid}/api/projects/import`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.detail || r.statusText);
}

function NickPicker({ onPick }: { onPick: (nick: string) => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<{ nick: string; display_name: string }[]>([]);
  const [open, setOpen] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(t.current);
    if (q.trim().length < 3) { setItems([]); return; }
    t.current = setTimeout(() => cp.search(q.trim()).then((r) => { setItems(r); setOpen(true); }).catch(() => {}), 200);
  }, [q]);
  return (
    <div className="picker">
      <input className="input" placeholder="ник участника (от 3 букв)" value={q} autoCapitalize="none"
        onChange={(e) => setQ(e.target.value.toLowerCase())} onFocus={() => setOpen(true)} />
      {open && !!items.length && (
        <div className="picker-menu">
          {items.map((u) => (
            <button key={u.nick} type="button" onClick={() => { onPick(u.nick); setQ(u.nick); setOpen(false); }}>
              <Avatar name={u.display_name} size={20} /> <b>@{u.nick}</b> <span className="dim">{u.display_name}</span>
            </button>
          ))}
        </div>
      )}
      {open && q.trim().length >= 3 && !items.length && <div className="picker-menu empty">никого не найдено</div>}
    </div>
  );
}

export function SpaceView(props: { onMenu: () => void; projects: Project[] }) {
  const cl = useCluster()!;
  const sp = cl.space;
  const [full, setFull] = useState<SpaceFull | null>(null);
  const [nick, setNick] = useState("");
  const [role, setRole] = useState<SpaceRole>("editor");
  const [teamName, setTeamName] = useState("");
  const [fromProject, setFromProject] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => cp.space(sp.id).then(setFull).catch((e) => cl.toast(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [sp.id, cl.spaces]);

  const isOwner = sp.role === "owner";
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e: any) { cl.toast(e.message); } finally { setBusy(false); }
  };

  const createTeam = () => run(async () => {
    const name = teamName.trim();
    if (!name) return;
    let data: any = null;
    if (fromProject) data = await api.exportProject(fromProject); // из текущего (личного) пространства
    const team = await cp.createTeam(name);
    if (data) await importInto(team.id, { ...data, name });
    await cl.refresh();
    cl.toast(data ? "Общий проект создан, данные перенесены. Пригласите участников" : "Общий проект создан. Пригласите участников");
    cl.switchSpace(team.id, "space");
  });

  return (
    <div className="main">
      <TopBar onMenu={props.onMenu} title={sp.kind === "team" ? `👥 ${sp.name}` : "Личное пространство"}
        sub={`// ${ROLE_LABEL[sp.role]} · ${sp.kind === "team" ? "общий приватный проект" : "видите только вы"}`} />
      <div className="feed">
        <div className="page">
          {!!cl.invites.length && (
            <Section title="Приглашения">
              {cl.invites.map((i) => (
                <div className="member invite" key={i.id}>
                  <Avatar name={i.from_name} />
                  <span className="grow"><b>{i.from_name}</b> приглашает в «{i.space_name}» · {ROLE_LABEL[i.role]}</span>
                  <button className="btn slim" onClick={() => run(async () => { await cp.answer(i.id, false); await cl.refresh(); })}>нет</button>
                  <button className="btn slim primary" onClick={() => run(async () => {
                    const r = await cp.answer(i.id, true);
                    await cl.refresh();
                    if (r.space_id) cl.switchSpace(r.space_id, "chat");
                  })}>принять</button>
                </div>
              ))}
            </Section>
          )}

          {sp.kind === "team" && full && (
            <Section title="Участники" hint="Все участники видят чаты и память в реальном времени. Каждый запускает агента своими ключами.">
              <div className="members">
                {full.members_list.map((m) => (
                  <div className="member" key={m.id}>
                    <Avatar name={m.display_name} />
                    <span className="grow">{m.display_name} <small className="dim">@{m.nick}</small>{m.id === cl.user.id && <small className="dim"> · вы</small>}</span>
                    {isOwner && m.id !== cl.user.id ? (
                      <>
                        <select className="input slim" value={m.role}
                          onChange={(e) => run(async () => { await cp.setRole(sp.id, m.id, e.target.value as SpaceRole); await load(); })}>
                          <option value="viewer">читатель</option>
                          <option value="editor">редактор</option>
                          <option value="owner">владелец</option>
                        </select>
                        <button className="btn slim danger" title="Удалить из проекта"
                          onClick={() => confirm(`Удалить @${m.nick} из «${sp.name}»? Доступ пропадёт сразу.`) &&
                            run(async () => { await cp.removeMember(sp.id, m.id); await load(); })}>×</button>
                      </>
                    ) : <span className="chip">{ROLE_LABEL[m.role]}</span>}
                  </div>
                ))}
              </div>
              {isOwner && (
                <>
                  <div className="invite-row">
                    <NickPicker onPick={setNick} />
                    <select className="input slim" value={role} onChange={(e) => setRole(e.target.value as SpaceRole)}>
                      <option value="viewer">читатель</option>
                      <option value="editor">редактор</option>
                      <option value="owner">совладелец</option>
                    </select>
                    <button className="btn primary" disabled={busy || nick.length < 3}
                      onClick={() => run(async () => { await cp.invite(sp.id, nick, role); setNick(""); cl.toast(`Приглашение отправлено @${nick}`); await load(); })}>
                      пригласить
                    </button>
                  </div>
                  {!!full.pending?.length && (
                    <div className="members">
                      {full.pending.map((p) => (
                        <div className="member pending" key={p.id}>
                          <Avatar name={p.display_name} />
                          <span className="grow">@{p.nick} <small className="dim">ждёт ответа · {ROLE_LABEL[p.role]}</small></span>
                          <button className="btn slim" onClick={() => run(async () => { await cp.cancelInvite(sp.id, p.id); await load(); })}>отменить</button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </Section>
          )}

          {sp.kind === "personal" && (
            <Section title="Новый общий проект"
              hint="Отдельное закрытое пространство в кластере. Участников добавляете по нику — они получают приглашение и должны принять его.">
              <div className="field">
                <label className="label">название</label>
                <input className="input" value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="Shop" />
              </div>
              <div className="field">
                <label className="label">перенести из личного проекта (копия памяти, инструкций и скилов)</label>
                <select className="input" value={fromProject} onChange={(e) => {
                  setFromProject(e.target.value);
                  const p = props.projects.find((x) => x.id === e.target.value);
                  if (p && !teamName) setTeamName(p.name);
                }}>
                  <option value="">— пустой проект —</option>
                  {props.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="row-end">
                <button className="btn primary" disabled={busy || !teamName.trim()} onClick={createTeam}>
                  {fromProject ? "сделать общим" : "создать"}
                </button>
              </div>
            </Section>
          )}

          <Section title="Расходы">
            <UsageSummary team={sp.kind === "team"} />
          </Section>

          <Section title="Безопасность">
            <ul className="facts">
              <li>Вход в пространство — пропуск на 10 минут от control-plane, роль проверяется при каждом запросе.</li>
              <li>Ключи API не хранятся на сервере: только в памяти на время работы агента.</li>
              {sp.kind === "team" && <li>Удалённый участник теряет доступ сразу, даже с открытым приложением.</li>}
              <li>Неактивность {Math.round((cl as any).purgeHours || 72)} ч — данные удаляются автоматически.</li>
            </ul>
          </Section>

          {sp.kind === "team" && (
            <Section title="Опасная зона">
              <div className="row-end" style={{ justifyContent: "flex-start" }}>
                <button className="btn danger" onClick={() => confirm(`Выйти из «${sp.name}»?`) &&
                  run(async () => { await cp.removeMember(sp.id, cl.user.id); await cl.refresh(); })}>выйти из проекта</button>
                {isOwner && (
                  <button className="btn danger" onClick={() => confirm(`Удалить «${sp.name}» у всех участников?`) &&
                    run(async () => { await cp.deleteSpace(sp.id); await cl.refresh(); })}>удалить проект</button>
                )}
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
