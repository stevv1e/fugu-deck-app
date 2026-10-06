import { useEffect, useState } from "react";
import { api } from "../api";
import { IconX } from "./icons";

export function AuditModal({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    api.audit().then(setRows).catch(() => setRows([]));
  }, []);
  return (
    <div className="modal">
      <div className="scrim" style={{ display: "block" }} onClick={onClose} />
      <div className="modal-card">
        <div className="modal-head">
          <h3>// журнал действий</h3>
          <button className="icon-btn" onClick={onClose}><IconX /></button>
        </div>
        <div className="modal-body">
          {rows === null && <div className="label">загрузка…</div>}
          {rows?.length === 0 && <div className="label">пусто</div>}
          {rows?.map((r) => (
            <div className="audit-row" key={r.id}>
              <div className="top">
                <b>{r.tool}</b>
                <span className={`st ${r.ok ? "ok" : r.approved === 0 ? "denied" : "error"}`}>
                  {r.ok ? "ok" : r.approved === 0 ? "отклонено" : "ошибка"}
                </span>
              </div>
              <div className="when">{new Date(r.ts * 1000).toLocaleString()}</div>
              <div className="sum">
                {[r.args.repo || r.args.name, r.args.branch].filter(Boolean).join(" · ")}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
