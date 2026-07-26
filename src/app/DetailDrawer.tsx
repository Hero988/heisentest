import { useEffect, useState } from "react";
import type { DetailResult } from "../engine/client";
import { levelName } from "../engine/levels";
import type { RowView } from "../engine/store";
import { fmtDateTime } from "./format";
import type { Engine } from "./useEngine";

interface Props {
  engine: Engine;
  row: RowView;
  onClose: () => void;
}

export function DetailDrawer({ engine, row, onClose }: Props) {
  const [detail, setDetail] = useState<DetailResult | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    void engine.detail(row.id).then((d) => {
      if (alive) setDetail(d);
    });
    return () => {
      alive = false;
    };
  }, [engine, row.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  const fields = detail?.fields ?? null;

  return (
    <section className="drawer" aria-label="Line detail">
      <div className="drawer-head">
        <span className={`log-level lv-${levelName(row.level).toLowerCase().replace("—", "none")}`}>
          {levelName(row.level)}
        </span>
        <span className="mono drawer-meta">
          {row.ts !== null ? `${fmtDateTime(row.ts)} UTC` : "no timestamp"} · {row.file}:
          {row.lineNo}
          {row.foldedLines > 0 ? ` · ${row.foldedLines + 1} lines` : ""}
        </span>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="Close detail">
          ✕
        </button>
      </div>
      {fields !== null && Object.keys(fields).length > 0 && (
        <dl className="drawer-fields mono">
          {Object.entries(fields).slice(0, 40).map(([key, value]) => (
            <div key={key} className="drawer-field">
              <dt>{key}</dt>
              <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      <pre className="drawer-raw mono">{detail?.fullText ?? "…"}</pre>
    </section>
  );
}
