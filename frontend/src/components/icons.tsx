const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
export const IconMenu = () => (<svg viewBox="0 0 24 24" {...p}><path d="M4 7h16M4 12h10M4 17h16" /></svg>);
export const IconSend = () => (<svg viewBox="0 0 24 24" {...p} strokeWidth={2.2}><path d="M5 12h13M13 6l6 6-6 6" /></svg>);
export const IconStop = () => (<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" /></svg>);
export const IconClip = () => (<svg viewBox="0 0 24 24" {...p}><path d="M20 11.5l-8.1 8.1a5 5 0 01-7.1-7.1l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.4 8.4a1.7 1.7 0 01-2.4-2.4l7.7-7.7" /></svg>);
export const IconPlus = () => (<svg viewBox="0 0 24 24" {...p}><path d="M12 5v14M5 12h14" /></svg>);
export const IconX = () => (<svg viewBox="0 0 24 24" {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>);
export const IconTrash = () => (<svg viewBox="0 0 24 24" {...p}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>);

export const IconChat = () => (<svg viewBox="0 0 24 24" {...p}><path d="M4 5h16v11H9l-5 4z" /></svg>);
export const IconBrain = () => (<svg viewBox="0 0 24 24" {...p}><path d="M9 4a3 3 0 00-3 3 3 3 0 00-2 5 3 3 0 002 5 3 3 0 006 1V5a2 2 0 00-3-1zM15 4a3 3 0 013 3 3 3 0 012 5 3 3 0 01-2 5 3 3 0 01-6 1" /></svg>);
export const IconBolt = () => (<svg viewBox="0 0 24 24" {...p}><path d="M13 3L5 14h6l-1 7 8-11h-6z" /></svg>);
export const IconFolder = () => (<svg viewBox="0 0 24 24" {...p}><path d="M3 6h7l2 2h9v11H3z" /></svg>);
export const IconGear = () => (<svg viewBox="0 0 24 24" {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></svg>);
export const IconPin = () => (<svg viewBox="0 0 24 24" {...p}><path d="M9 3h6l-1 6 4 4H6l4-4zM12 13v8" /></svg>);
export const IconSearch = () => (<svg viewBox="0 0 24 24" {...p}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></svg>);
export const IconChevron = () => (<svg viewBox="0 0 24 24" {...p}><path d="M7 10l5 5 5-5" /></svg>);
export const IconEdit = () => (<svg viewBox="0 0 24 24" {...p}><path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4" /></svg>);
export const IconLink = () => (<svg viewBox="0 0 24 24" {...p}><path d="M10 14a4 4 0 006 0l3-3a4 4 0 00-6-6l-1 1M14 10a4 4 0 00-6 0l-3 3a4 4 0 006 6l1-1" /></svg>);
export const IconUsers = () => (<svg viewBox="0 0 24 24" {...p}><circle cx="9" cy="8" r="3.5" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 010 7M18 14c2 .6 3 2.8 3 6" /></svg>);
export const IconBack = () => (<svg viewBox="0 0 24 24" {...p}><path d="M15 6l-6 6 6 6" /></svg>);

/** Оригинальный знак приложения: колючая «рыба-шар» из геометрии. */
export const Logo = ({ size = 28 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
    <g style={{ stroke: "var(--cyan)" }} strokeWidth="3" fill="none" strokeLinecap="square">
      {Array.from({ length: 12 }).map((_, i) => {
        const a = (i / 12) * Math.PI * 2;
        return <line key={i} x1={32 + Math.cos(a) * 19} y1={32 + Math.sin(a) * 19} x2={32 + Math.cos(a) * 27} y2={32 + Math.sin(a) * 27} />;
      })}
      <circle cx="32" cy="32" r="15" />
    </g>
    <rect x="35" y="25" width="5" height="5" style={{ fill: "var(--magenta)" }} />
  </svg>
);
