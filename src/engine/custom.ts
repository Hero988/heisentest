/**
 * User-defined formats — the escape hatch that makes heisentest work with
 * formats that haven't been invented yet.
 *
 * Two spec kinds, one canonical model (the industry-convergent triple:
 * named-group regex + strptime timestamps + level token map):
 *
 *   - "pattern": a JS regex with named groups. Reserved names: `timestamp`,
 *     `level`, `service`, `message`. Every other named group becomes a field.
 *   - "csv": column-role overrides for delimited files, when the automatic
 *     inference guessed wrong (or the headers are in another language).
 *
 * Specs are validated by compiling; a spec that doesn't compile is rejected
 * with a reason, never silently ignored.
 */

import { inferColumnRoles, type ColumnRoles, type CsvDialect } from "./csv";
import { Level, levelFromText } from "./levels";
import { findTimestamp } from "./timestamps";
import { compileTimeFormat, type CompiledTimeFormat } from "./strptime";

export interface PatternFormatSpec {
  kind: "pattern";
  /** JS regex source with named groups; applied per line, first match wins. */
  patterns: string[];
  /** strptime format(s) for the `timestamp` group; empty → auto-detect. */
  timestampFormats?: string[];
  /** Extra level tokens: canonical level name → tokens (case-insensitive). */
  levels?: Partial<Record<"error" | "warn" | "info" | "debug" | "trace", string[]>>;
  /** Lines matching no pattern fold into the previous row (default true). */
  foldUnmatched?: boolean;
}

export interface CsvFormatSpec {
  kind: "csv";
  /** Column HEADER NAMES for each role; unset roles fall back to inference. */
  time?: string;
  level?: string;
  status?: string;
  message?: string;
  service?: string;
  /** strptime format for the time column; empty → auto-detect. */
  timestampFormat?: string;
}

export type FormatSpec = PatternFormatSpec | CsvFormatSpec;

export interface CompiledPatternFormat {
  kind: "pattern";
  regexes: RegExp[];
  timeFormats: CompiledTimeFormat[];
  levelMap: Map<string, Level>;
  foldUnmatched: boolean;
  parse(line: string): {
    matched: boolean;
    ts: number | null;
    level: Level;
    service: string | null;
    message: string;
    fields: Record<string, string>;
  };
}

const CANONICAL: Record<string, Level> = {
  error: Level.Error,
  warn: Level.Warn,
  info: Level.Info,
  debug: Level.Debug,
  trace: Level.Trace,
};

export function compilePatternFormat(
  spec: PatternFormatSpec,
): { ok: true; format: CompiledPatternFormat } | { ok: false; error: string } {
  if (spec.patterns.length === 0) return { ok: false, error: "add at least one pattern" };
  const regexes: RegExp[] = [];
  for (const source of spec.patterns) {
    if (source.trim() === "") return { ok: false, error: "a pattern is empty" };
    try {
      regexes.push(new RegExp(source));
    } catch (err) {
      return { ok: false, error: `invalid regex: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const timeFormats: CompiledTimeFormat[] = [];
  for (const f of spec.timestampFormats ?? []) {
    if (f.trim() === "") continue;
    const compiled = compileTimeFormat(f);
    if (!compiled) return { ok: false, error: `invalid timestamp format "${f}"` };
    timeFormats.push(compiled);
  }
  const levelMap = new Map<string, Level>();
  for (const [canonical, tokens] of Object.entries(spec.levels ?? {})) {
    const level = CANONICAL[canonical];
    if (level === undefined) return { ok: false, error: `unknown level "${canonical}"` };
    for (const token of tokens ?? []) levelMap.set(token.toLowerCase(), level);
  }

  const format: CompiledPatternFormat = {
    kind: "pattern",
    regexes,
    timeFormats,
    levelMap,
    foldUnmatched: spec.foldUnmatched ?? true,
    parse(line: string) {
      for (const re of regexes) {
        const m = re.exec(line);
        if (!m) continue;
        const groups = m.groups ?? {};
        const fields: Record<string, string> = {};
        for (const [key, value] of Object.entries(groups)) {
          if (value !== undefined) fields[key] = value;
        }

        let ts: number | null = null;
        const tsRaw = groups["timestamp"];
        if (tsRaw !== undefined && tsRaw !== "") {
          for (const tf of timeFormats) {
            ts = tf.parse(tsRaw);
            if (ts !== null) break;
          }
          if (ts === null && timeFormats.length === 0) {
            const auto = findTimestamp(tsRaw);
            ts = auto ? auto.ts : null;
          }
        }

        let level = Level.Unknown;
        const levelRaw = groups["level"];
        if (levelRaw !== undefined && levelRaw !== "") {
          level = levelMap.get(levelRaw.toLowerCase()) ?? levelFromText(levelRaw);
        }

        const service = groups["service"] ?? null;
        const message = groups["message"] ?? line;
        return { matched: true, ts, level, service, message, fields };
      }
      return {
        matched: false,
        ts: null,
        level: Level.Unknown,
        service: null,
        message: line,
        fields: {},
      };
    },
  };
  return { ok: true, format };
}

/** Resolve a CSV spec against a real header into concrete column roles. */
export function applyCsvSpec(
  spec: CsvFormatSpec,
  dialect: CsvDialect,
  samples: string[][],
): { roles: ColumnRoles; timeFormat: CompiledTimeFormat | null } {
  const inferred = inferColumnRoles(dialect.header, samples);
  const byName = (name: string | undefined): number => {
    if (name === undefined || name === "") return -2; // "not specified" → auto
    if (name === "(none)") return -1; // explicit "no column plays this role"
    const at = dialect.header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    return at; // -1 also covers "named column not found"
  };
  const pick = (override: number, fallback: number): number =>
    override === -2 ? fallback : override;

  const roles: ColumnRoles = {
    time: pick(byName(spec.time), inferred.time),
    level: pick(byName(spec.level), inferred.level),
    status: pick(byName(spec.status), inferred.status),
    message: pick(byName(spec.message), inferred.message),
    service: pick(byName(spec.service), inferred.service),
    compose: inferred.compose,
  };
  let timeFormat: CompiledTimeFormat | null = null;
  if (spec.timestampFormat && spec.timestampFormat.trim() !== "") {
    timeFormat = compileTimeFormat(spec.timestampFormat);
  }
  return { roles, timeFormat };
}

/** Stable signature used to auto-apply saved specs to recognizable files. */
export function fileSignature(csvHeaderLine: string | null, firstLine: string): string {
  if (csvHeaderLine !== null) return `csv:${csvHeaderLine}`;
  // For line logs: the first line with digits collapsed is a decent shape key.
  return `line:${firstLine.replace(/\d+/g, "#").slice(0, 200)}`;
}
