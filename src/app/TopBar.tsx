import { useEffect, useState } from "react";
import { fmtCount } from "./format";
import type { Engine } from "./useEngine";

interface Props {
  engine: Engine;
}

export function TopBar({ engine }: Props) {
  const [text, setText] = useState(engine.filters.query);

  // Debounce typing into the worker query.
  useEffect(() => {
    const handle = setTimeout(() => {
      if (text !== engine.filters.query) {
        engine.setFilters({ ...engine.filters, query: text });
      }
    }, 180);
    return () => clearTimeout(handle);
  }, [text, engine]);

  const filtered =
    engine.snapshot !== null && engine.snapshot.count !== engine.snapshot.totalRows;

  return (
    <header className="topbar">
      <a className="brand" href="/" onClick={(e) => { e.preventDefault(); void engine.reset(); }}>
        <span className="brand-name">heisentest</span>
        <span className="brand-tag">logs, analyzed in your tab</span>
      </a>
      <div className="searchbox">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          value={text}
          placeholder="Filter lines as you type — try error, timeout, a request id…"
          aria-label="Filter log lines"
          onChange={(e) => setText(e.currentTarget.value)}
        />
        {filtered && engine.snapshot !== null && (
          <span className="search-count mono">
            {fmtCount(engine.snapshot.count)} / {fmtCount(engine.snapshot.totalRows)}
          </span>
        )}
      </div>
      <button
        type="button"
        className="topbar-reset"
        onClick={() => void engine.reset()}
        title="Close all files and start over"
      >
        New session
      </button>
    </header>
  );
}
