import { useEffect, useMemo, useState } from "react";
import type { FileInfo } from "../engine/client";
import {
  compilePatternFormat,
  type CsvFormatSpec,
  type FormatSpec,
  type PatternFormatSpec,
} from "../engine/custom";
import { levelName } from "../engine/levels";
import { fmtTime } from "./format";
import { removeFormat, saveFormat, savedFormat } from "./formatStore";
import type { Engine } from "./useEngine";

interface Props {
  engine: Engine;
  fileId: number;
  fileName: string;
  onClose: () => void;
}

type Tab = "columns" | "pattern";

const ROLE_LABELS: [keyof Omit<CsvFormatSpec, "kind" | "timestampFormat">, string][] = [
  ["time", "Timestamp"],
  ["level", "Level"],
  ["status", "HTTP status → level"],
  ["message", "Message"],
  ["service", "Service"],
];

export function FormatDialog({ engine, fileId, fileName, onClose }: Props) {
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [tab, setTab] = useState<Tab>("pattern");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // pattern spec state
  const [patternText, setPatternText] = useState("");
  const [timeFormatText, setTimeFormatText] = useState("");
  const [levelMapText, setLevelMapText] = useState("");

  // csv spec state
  const [columns, setColumns] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    void engine.fileInfo(fileId).then((i) => {
      if (!alive) return;
      setInfo(i);
      setTab(i.csvHeader ? "columns" : "pattern");
      const saved = savedFormat(i.signature);
      if (saved?.kind === "pattern") {
        setPatternText(saved.patterns.join("\n"));
        setTimeFormatText((saved.timestampFormats ?? []).join(", "));
        setLevelMapText(
          Object.entries(saved.levels ?? {})
            .map(([k, v]) => `${k}=${(v ?? []).join(",")}`)
            .join(" "),
        );
        setTab("pattern");
      } else if (saved?.kind === "csv") {
        const next: Record<string, string> = {};
        for (const [role] of ROLE_LABELS) {
          const v = saved[role];
          if (typeof v === "string") next[role] = v;
        }
        if (saved.timestampFormat) next["timestampFormat"] = saved.timestampFormat;
        setColumns(next);
        setTab("columns");
      }
    });
    return () => {
      alive = false;
    };
  }, [engine, fileId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  const patternSpec: PatternFormatSpec = useMemo(() => {
    // "error=KABOOM,FATAL warn=MEH" → { error: ["KABOOM","FATAL"], warn: ["MEH"] }
    const levels: PatternFormatSpec["levels"] = {};
    for (const clause of levelMapText.split(/\s+/).filter(Boolean)) {
      const eq = clause.indexOf("=");
      if (eq <= 0) continue;
      const key = clause.slice(0, eq).toLowerCase() as keyof NonNullable<
        PatternFormatSpec["levels"]
      >;
      if (!["error", "warn", "info", "debug", "trace"].includes(key)) continue;
      levels[key] = clause
        .slice(eq + 1)
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
    return {
      kind: "pattern",
      patterns: patternText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
      timestampFormats: timeFormatText
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean),
      levels,
    };
  }, [patternText, timeFormatText, levelMapText]);

  // Live preview: compile in the UI thread and parse the sample lines.
  const preview = useMemo(() => {
    if (tab !== "pattern" || info === null || patternSpec.patterns.length === 0) return null;
    const compiled = compilePatternFormat(patternSpec);
    if (!compiled.ok) return { error: compiled.error, rows: [] };
    const sampleLines = info.csvHeader ? info.headLines.slice(1) : info.headLines;
    const rows = sampleLines.slice(0, 8).map((line) => {
      const r = compiled.format.parse(line);
      return { line, matched: r.matched, ts: r.ts, level: r.level, message: r.message };
    });
    return { error: null, rows };
  }, [tab, info, patternSpec]);

  const matchedCount = preview?.rows.filter((r) => r.matched).length ?? 0;

  const buildSpec = (): FormatSpec | null => {
    if (tab === "pattern") {
      if (patternSpec.patterns.length === 0) return null;
      return patternSpec;
    }
    const spec: CsvFormatSpec = { kind: "csv" };
    for (const [role] of ROLE_LABELS) {
      const v = columns[role];
      if (v !== undefined && v !== "" && v !== "(auto)") {
        spec[role] = v;
      }
    }
    const tf = columns["timestampFormat"];
    if (tf) spec.timestampFormat = tf;
    return spec;
  };

  const apply = async () => {
    const spec = buildSpec();
    if (spec === null) {
      setError("nothing to apply — add a pattern or pick columns");
      return;
    }
    if (spec.kind === "pattern") {
      const compiled = compilePatternFormat(spec);
      if (!compiled.ok) {
        setError(compiled.error);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      await engine.reparse(fileId, spec);
      if (info?.signature) saveFormat(info.signature, spec);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const resetToAuto = async () => {
    setBusy(true);
    setError(null);
    try {
      await engine.reparse(fileId, null);
      if (info?.signature) removeFormat(info.signature);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="fmt-overlay" role="dialog" aria-modal="true" aria-label={`Adjust parsing for ${fileName}`}>
      <div className="fmt">
        <header className="fmt-head">
          <h2>
            Adjust parsing — <span className="mono">{fileName}</span>
          </h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {info === null ? (
          <p className="fmt-loading">reading file…</p>
        ) : (
          <>
            <div className="fmt-tabs" role="tablist">
              {info.csvHeader && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "columns"}
                  onClick={() => setTab("columns")}
                >
                  Columns
                </button>
              )}
              <button
                type="button"
                role="tab"
                aria-selected={tab === "pattern"}
                onClick={() => setTab("pattern")}
              >
                Pattern
              </button>
            </div>

            {tab === "columns" && info.csvHeader && (
              <div className="fmt-body">
                <p className="fmt-hint">
                  Columns were detected automatically — override any that were guessed wrong.
                </p>
                <div className="fmt-grid">
                  {ROLE_LABELS.map(([role, label]) => (
                    <label key={role}>
                      <span>{label}</span>
                      <select
                        value={columns[role] ?? "(auto)"}
                        onChange={(e) => setColumns({ ...columns, [role]: e.currentTarget.value })}
                      >
                        <option>(auto)</option>
                        <option>(none)</option>
                        {info.csvHeader!.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <label>
                    <span>Timestamp format (strptime, optional)</span>
                    <input
                      className="mono"
                      placeholder="auto — or e.g. %Y-%m-%d %H:%M:%S"
                      value={columns["timestampFormat"] ?? ""}
                      onChange={(e) =>
                        setColumns({ ...columns, timestampFormat: e.currentTarget.value })
                      }
                    />
                  </label>
                </div>
              </div>
            )}

            {tab === "pattern" && (
              <div className="fmt-body">
                <p className="fmt-hint">
                  One regex per line, first match wins. Named groups become the structure:{" "}
                  <code>(?&lt;timestamp&gt;…)</code> <code>(?&lt;level&gt;…)</code>{" "}
                  <code>(?&lt;service&gt;…)</code> <code>(?&lt;message&gt;…)</code> — any other
                  name becomes a field. Lines matching nothing fold into the row above
                  (stack traces).
                </p>
                <textarea
                  className="mono fmt-pattern"
                  rows={3}
                  spellCheck={false}
                  placeholder={String.raw`^(?<timestamp>\S+ \S+) \| (?<level>\w+) \| (?<message>.*)$`}
                  value={patternText}
                  onChange={(e) => setPatternText(e.currentTarget.value)}
                />
                <label className="fmt-tsfmt">
                  <span>Timestamp format(s), strptime, comma-separated — empty = auto</span>
                  <input
                    className="mono"
                    placeholder="%Y-%m-%d %H:%M:%S,%L"
                    value={timeFormatText}
                    onChange={(e) => setTimeFormatText(e.currentTarget.value)}
                  />
                </label>
                <label className="fmt-tsfmt">
                  <span>
                    Level words (optional) — map your severity tokens onto
                    error/warn/info/debug/trace
                  </span>
                  <input
                    className="mono"
                    placeholder="error=KABOOM,FATAL warn=MEH info=OKAY"
                    value={levelMapText}
                    onChange={(e) => setLevelMapText(e.currentTarget.value)}
                  />
                </label>

                {preview !== null && (
                  <div className="fmt-preview">
                    <p className="fmt-preview-head">
                      {preview.error !== null ? (
                        <span className="fmt-err">{preview.error}</span>
                      ) : (
                        <>
                          Preview — {matchedCount}/{preview.rows.length} sample lines match
                        </>
                      )}
                    </p>
                    {preview.error === null &&
                      preview.rows.map((r, i) => (
                        <div key={i} className={`fmt-sample${r.matched ? "" : " is-miss"}`}>
                          <span className={`fmt-badge ${r.matched ? "ok" : "miss"}`}>
                            {r.matched ? "match" : "no match"}
                          </span>
                          {r.matched ? (
                            <span className="mono fmt-parsed">
                              <span className="fmt-ts">{fmtTime(r.ts)}</span>{" "}
                              <span className="fmt-lv">{levelName(r.level)}</span>{" "}
                              {r.message.slice(0, 90)}
                            </span>
                          ) : (
                            <span className="mono fmt-parsed fmt-raw">{r.line.slice(0, 100)}</span>
                          )}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}

            {error !== null && <p className="fmt-err">{error}</p>}

            <footer className="fmt-foot">
              <button type="button" className="fmt-secondary" onClick={() => void resetToAuto()} disabled={busy}>
                Reset to automatic
              </button>
              <span className="fmt-note">Saved formats re-apply automatically to matching files.</span>
              <button type="button" className="fmt-apply" onClick={() => void apply()} disabled={busy}>
                {busy ? "Re-parsing…" : "Apply"}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
