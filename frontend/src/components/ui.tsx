import type { ReactNode } from "react";
import type { Online } from "../api";
import { IconBack, IconMenu } from "./icons";

const HUES = [186, 330, 48, 140, 265, 20, 210, 95];
export function hue(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

export function Avatar({ name, size = 22, title }: { name: string; size?: number; title?: string }) {
  const h = hue(name);
  return (
    <span className="avatar" title={title || name}
      style={{ width: size, height: size, fontSize: size * 0.46, background: `hsl(${h} 90% 60% / .16)`,
        color: `hsl(${h} 95% 70%)`, borderColor: `hsl(${h} 90% 60% / .55)` }}>
      {name.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

export function OnlineStack({ online, meId, max = 4 }: { online: Online[]; meId?: string; max?: number }) {
  const others = online.filter((o) => o.user_id !== meId);
  if (!others.length) return null;
  return (
    <span className="online-stack" title={others.map((o) => o.name).join(", ")}>
      {others.slice(0, max).map((o) => <Avatar key={o.user_id} name={o.name} size={22} />)}
      {others.length > max && <span className="more">+{others.length - max}</span>}
    </span>
  );
}

export function TopBar(props: { title: ReactNode; sub?: ReactNode; onMenu: () => void; onBack?: () => void; right?: ReactNode }) {
  return (
    <header className="topbar">
      {props.onBack ? (
        <button className="icon-btn" onClick={props.onBack} aria-label="Назад"><IconBack /></button>
      ) : (
        <button className="icon-btn only-mobile" onClick={props.onMenu} aria-label="Меню"><IconMenu /></button>
      )}
      <div className="title">
        {props.title}
        {props.sub && <small>{props.sub}</small>}
      </div>
      {props.right}
    </header>
  );
}

export function Seg<T extends string>({ value, options, onChange }: {
  value: T; options: [T, ReactNode][]; onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map(([v, label]) => (
        <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)} type="button">{label}</button>
      ))}
    </div>
  );
}

export function Section({ title, hint, children, right }: { title: string; hint?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>{title}</h3>
        {right}
      </div>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  );
}

export const ROLE_LABEL: Record<string, string> = { viewer: "читатель", editor: "редактор", owner: "владелец" };

export function ago(ts: number) {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return "только что";
  if (d < 3600) return `${Math.floor(d / 60)} мин назад`;
  if (d < 86400) return `${Math.floor(d / 3600)} ч назад`;
  return new Date(ts * 1000).toLocaleDateString();
}
