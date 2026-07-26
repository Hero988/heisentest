import { useCallback, useEffect, useRef, useState } from "react";
import { Level, levelName } from "../engine/levels";
import type { RowView } from "../engine/store";
import { fmtTime } from "./format";
import type { Engine } from "./useEngine";

const ROW_H = 26;
const OVERSCAN = 10;

const LEVEL_CLASS: Record<number, string> = {
  [Level.Error]: "lv-error",
  [Level.Warn]: "lv-warn",
  [Level.Info]: "lv-info",
  [Level.Debug]: "lv-debug",
  [Level.Trace]: "lv-trace",
  [Level.Unknown]: "lv-none",
};

interface Props {
  engine: Engine;
  count: number;
  selected: number | null; // position in filtered order
  onSelect: (position: number, row: RowView) => void;
  scrollToPosition: number | null;
  onScrolled: () => void;
}

export function LogTable({ engine, count, selected, onSelect, scrollToPosition, onScrolled }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<[number, number]>([0, 0]);

  const recompute = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const first = Math.max(0, Math.floor(wrap.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(count, Math.ceil((wrap.scrollTop + wrap.clientHeight) / ROW_H) + OVERSCAN);
    setRange([first, last]);
  }, [count]);

  useEffect(() => {
    recompute();
  }, [recompute, engine.cacheVersion]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (wrap && scrollToPosition !== null) {
      wrap.scrollTop = Math.max(0, scrollToPosition * ROW_H - wrap.clientHeight / 3);
      onScrolled();
      recompute();
    }
  }, [scrollToPosition, onScrolled, recompute]);

  const [first, last] = range;
  const rows: (RowView | null)[] = [];
  for (let i = first; i < last; i++) rows.push(engine.rowAt(i));

  const highlight = engine.filters.query.toLowerCase();

  return (
    <div
      className="logwrap"
      ref={wrapRef}
      onScroll={recompute}
      role="listbox"
      aria-label="Log lines"
      tabIndex={0}
    >
      <div className="log-spacer" style={{ height: count * ROW_H }}>
        {rows.map((row, i) => {
          const position = first + i;
          if (row === null) {
            return (
              <div key={position} className="log-row log-loading" style={{ top: position * ROW_H }}>
                <span className="log-shimmer" />
              </div>
            );
          }
          return (
            <div
              key={position}
              role="option"
              aria-selected={position === selected}
              className={`log-row mono thread-${row.fileId % 6}${position === selected ? " is-selected" : ""}`}
              style={{ top: position * ROW_H }}
              onClick={() => onSelect(position, row)}
            >
              <span className="log-time">{fmtTime(row.ts)}</span>
              <span className={`log-level ${LEVEL_CLASS[row.level]}`}>{levelName(row.level)}</span>
              {row.service !== null && <span className="log-svc">{row.service}</span>}
              <span className="log-msg">{emphasize(row.message, highlight)}</span>
              {row.foldedLines > 0 && <span className="log-fold">+{row.foldedLines} lines</span>}
            </div>
          );
        })}
      </div>
      {count === 0 && (
        <p className="log-empty">No lines match the current filters — clear one and try again.</p>
      )}
    </div>
  );
}

function emphasize(text: string, needle: string): React.ReactNode {
  if (!needle) return text;
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}
