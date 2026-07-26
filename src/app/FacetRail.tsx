import { useRef } from "react";
import { Level, LEVELS, levelFromText } from "../engine/levels";
import type { QuerySnapshot } from "../engine/protocol";
import { fmtBytes, fmtCount } from "./format";
import type { Engine, Filters } from "./useEngine";

interface Props {
  engine: Engine;
  snapshot: QuerySnapshot;
}

function toggle<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function FacetRail({ engine, snapshot }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const { filters, setFilters } = engine;

  const setPartial = (partial: Partial<Filters>) => setFilters({ ...filters, ...partial });

  return (
    <aside className="rail">
      <section>
        <h3>Files</h3>
        <div className="chips">
          {snapshot.facets.files.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`chip thread-chip thread-${f.id % 6}`}
              aria-pressed={filters.fileIds.has(f.id)}
              onClick={() => setPartial({ fileIds: toggle(filters.fileIds, f.id) })}
              title={f.name}
            >
              <span className="chip-dot" aria-hidden="true" />
              <span className="chip-label">{f.name}</span>
              <span className="chip-count">{fmtCount(f.rows)}</span>
            </button>
          ))}
        </div>
        <button type="button" className="rail-add" onClick={() => fileInput.current?.click()}>
          + add another file to the timeline
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const list = e.currentTarget.files;
            if (list && list.length > 0) void engine.addFiles([...list]);
            e.currentTarget.value = "";
          }}
        />
      </section>

      <section>
        <h3>Level</h3>
        <div className="chips">
          {LEVELS.map((name) => {
            const level = levelFromText(name) as Level;
            const count = snapshot.facets.levels[level] ?? 0;
            if (count === 0 && !filters.levels.has(level)) return null;
            return (
              <button
                key={name}
                type="button"
                className={`chip level-chip level-chip-${name.toLowerCase()}`}
                aria-pressed={filters.levels.has(level)}
                onClick={() => setPartial({ levels: toggle(filters.levels, level) })}
              >
                <span className="chip-dot" aria-hidden="true" />
                <span className="chip-label">{name}</span>
                <span className="chip-count">{fmtCount(count)}</span>
              </button>
            );
          })}
        </div>
      </section>

      {snapshot.facets.services.length > 0 && (
        <section>
          <h3>Service</h3>
          <div className="chips">
            {snapshot.facets.services.slice(0, 14).map((s) => (
              <button
                key={s.id}
                type="button"
                className="chip"
                aria-pressed={filters.serviceIds.has(s.id)}
                onClick={() => setPartial({ serviceIds: toggle(filters.serviceIds, s.id) })}
              >
                <span className="chip-label">{s.name}</span>
                <span className="chip-count">{fmtCount(s.count)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="rail-note">
        <p>
          <strong>{fmtCount(snapshot.totalRows)}</strong> lines · {fmtBytes(snapshot.approxBytes)}{" "}
          parsed locally
          {engine.loadMs !== null
            ? ` in ${engine.loadMs < 1000 ? `${engine.loadMs} ms` : `${(engine.loadMs / 1000).toFixed(1)} s`}`
            : ""}
          .
        </p>
        <p className="rail-privacy">Nothing leaves this tab — it works with wifi off.</p>
      </section>
    </aside>
  );
}
