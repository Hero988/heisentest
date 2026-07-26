/**
 * Per-line format detection and parsing.
 *
 * Real log files are messy: JSON lines interleaved with stray prints, access
 * logs with the odd startup banner, stack traces breaking every pattern.
 * Detection therefore runs per line, cheapest checks first, and every line
 * that matches nothing still becomes a row — the tool never refuses input.
 */

import { Level, levelFromNumber, levelFromText } from "./levels";
import { findTimestamp, parseFieldTimestamp } from "./timestamps";

export const enum LineKind {
  Json = 0,
  Logfmt = 1,
  Access = 2,
  Syslog = 3,
  Generic = 4,
  Raw = 5,
  Continuation = 6,
  Csv = 7,
}

export interface ParsedLine {
  kind: LineKind;
  ts: number | null;
  level: Level;
  /** Service / logger / source name, when the format carries one. */
  service: string | null;
  /** Human message — falls back to the whole line. */
  message: string;
}

/* ---------- JSON lines ---------- */

const TIME_KEYS = ["time", "timestamp", "ts", "@timestamp", "datetime", "date", "t", "asctime"];
const LEVEL_KEYS = ["level", "severity", "lvl", "loglevel", "log.level", "levelname"];
const MSG_KEYS = ["msg", "message", "event", "text", "body"];
const SERVICE_KEYS = ["service", "logger", "name", "app", "component", "module", "source", "container"];

export function parseJsonLine(text: string): ParsedLine | null {
  const first = text.charCodeAt(0);
  if (first !== 0x7b /* { */) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;

  let ts: number | null = null;
  for (const k of TIME_KEYS) {
    if (k in rec) {
      ts = parseFieldTimestamp(rec[k]);
      if (ts !== null) break;
    }
  }

  let level = Level.Unknown;
  for (const k of LEVEL_KEYS) {
    const v = rec[k];
    if (typeof v === "string") {
      level = levelFromText(v);
      if (level !== Level.Unknown) break;
    } else if (typeof v === "number") {
      level = levelFromNumber(v);
      if (level !== Level.Unknown) break;
    }
  }

  let message = "";
  for (const k of MSG_KEYS) {
    const v = rec[k];
    if (typeof v === "string" && v.length > 0) {
      message = v;
      break;
    }
  }
  if (message === "") message = text;

  let service: string | null = null;
  for (const k of SERVICE_KEYS) {
    const v = rec[k];
    if (typeof v === "string" && v.length > 0 && v.length <= 128) {
      service = v;
      break;
    }
  }

  return { kind: LineKind.Json, ts, level, service, message };
}

/** Re-parse a JSON line into its full field map (detail view; on demand). */
export function jsonFields(text: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(text);
    if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/* ---------- logfmt ---------- */

const RE_LOGFMT_PAIR = /([A-Za-z0-9_.@-]+)=("(?:[^"\\]|\\.)*"|\S*)/g;

export function parseLogfmt(text: string): ParsedLine | null {
  if (!text.includes("=")) return null;
  RE_LOGFMT_PAIR.lastIndex = 0;
  const fields: Record<string, string> = {};
  let pairs = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_LOGFMT_PAIR.exec(text)) !== null && pairs < 64) {
    const key = m[1]!;
    let value = m[2]!;
    if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, "$1");
    fields[key] = value;
    pairs++;
  }
  // Demand real structure, not "an equals sign appeared in prose".
  if (pairs < 2) return null;
  const structured = Object.keys(fields).filter((k) => fields[k] !== "").length;
  if (structured < 2) return null;

  let ts: number | null = null;
  for (const k of TIME_KEYS) {
    const v = fields[k];
    if (v !== undefined) {
      ts = parseFieldTimestamp(v);
      if (ts !== null) break;
    }
  }
  if (ts === null) {
    const anywhere = findTimestamp(text);
    ts = anywhere ? anywhere.ts : null;
  }

  let level = Level.Unknown;
  for (const k of LEVEL_KEYS) {
    const v = fields[k];
    if (v !== undefined) {
      level = levelFromText(v);
      if (level !== Level.Unknown) break;
    }
  }

  let message = "";
  for (const k of MSG_KEYS) {
    const v = fields[k];
    if (v !== undefined && v.length > 0) {
      message = v;
      break;
    }
  }
  if (message === "") message = text;

  let service: string | null = null;
  for (const k of SERVICE_KEYS) {
    const v = fields[k];
    if (v !== undefined && v.length > 0 && v.length <= 128) {
      service = v;
      break;
    }
  }

  return { kind: LineKind.Logfmt, ts, level, service, message };
}

/** Full logfmt field map (detail view; on demand). */
export function logfmtFields(text: string): Record<string, string> {
  RE_LOGFMT_PAIR.lastIndex = 0;
  const fields: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = RE_LOGFMT_PAIR.exec(text)) !== null) {
    let value = m[2]!;
    if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, "$1");
    fields[m[1]!] = value;
  }
  return fields;
}

/* ---------- nginx / apache access logs ---------- */

// 203.0.113.7 - alice [26/Jul/2026:02:14:04 +0000] "GET /api/x HTTP/1.1" 502 552 "-" "UA…"
const RE_ACCESS =
  /^(\S+) \S+ (\S+) \[([^\]]+)\] "([A-Z]+) (\S+)[^"]*" (\d{3}) (\S+)/;

export function parseAccessLog(text: string): ParsedLine | null {
  const m = RE_ACCESS.exec(text);
  if (!m) return null;
  const tsMatch = findTimestamp(m[3]!);
  const status = Number(m[6]!);
  const level = status >= 500 ? Level.Error : status >= 400 ? Level.Warn : Level.Info;
  return {
    kind: LineKind.Access,
    ts: tsMatch ? tsMatch.ts : null,
    level,
    service: null,
    message: `${m[6]} ${m[4]} ${m[5]}`,
  };
}

/** Access-log field map (detail view; on demand). */
export function accessFields(text: string): Record<string, string> | null {
  const m = RE_ACCESS.exec(text);
  if (!m) return null;
  return {
    remote: m[1]!,
    user: m[2]!,
    time: m[3]!,
    method: m[4]!,
    path: m[5]!,
    status: m[6]!,
    bytes: m[7]!,
  };
}

/* ---------- classic syslog ---------- */

// Jul 26 02:14:04 host1 sshd[812]: Accepted publickey for root
const RE_SYSLOG_LINE = /^[A-Za-z]{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} (\S+) ([^:[\s]+)(?:\[(\d+)\])?: ?(.*)$/;

export function parseSyslogLine(text: string, referenceYear?: number): ParsedLine | null {
  const m = RE_SYSLOG_LINE.exec(text);
  if (!m) return null;
  const tsMatch = findTimestamp(text, referenceYear);
  const body = m[4]!;
  const level = inferLevelFromBody(body);
  return {
    kind: LineKind.Syslog,
    ts: tsMatch ? tsMatch.ts : null,
    level: level === Level.Unknown ? Level.Info : level,
    service: m[2]!,
    message: body.length > 0 ? body : text,
  };
}

/* ---------- generic "timestamp LEVEL message" ---------- */

const RE_LEVEL_TOKEN =
  /(?:^|[\s[|(])(FATAL|CRITICAL|SEVERE|ERROR|ERR|WARNING|WARN|NOTICE|INFO|DEBUG|TRACE|FINE|VERBOSE)(?:[\s\]|):,-]|$)/i;

function inferLevelFromBody(text: string): Level {
  const head = text.length > 160 ? text.slice(0, 160) : text;
  const m = RE_LEVEL_TOKEN.exec(head);
  return m ? levelFromText(m[1]!) : Level.Unknown;
}

// "logger.name - message" · "[service] message" · "service: message" heads.
const RE_GENERIC_SERVICE =
  /(?:\]\s*|\s)([A-Za-z][A-Za-z0-9_.$-]{2,64})\s+-\s+|\[([A-Za-z][A-Za-z0-9_.:-]{1,48})\]/;

export function parseGeneric(text: string, referenceYear?: number): ParsedLine {
  const tsMatch = findTimestamp(text, referenceYear);
  const level = inferLevelFromBody(text);
  let service: string | null = null;
  if (tsMatch) {
    const afterTs = text.slice(tsMatch.end, tsMatch.end + 120);
    const sm = RE_GENERIC_SERVICE.exec(afterTs);
    if (sm) {
      const name = sm[1] ?? sm[2] ?? null;
      // Reject level tokens caught by the bracket pattern ("[ERROR]").
      if (name !== null && levelFromText(name) === Level.Unknown) service = name;
    }
  }
  return {
    kind: tsMatch || level !== Level.Unknown ? LineKind.Generic : LineKind.Raw,
    ts: tsMatch ? tsMatch.ts : null,
    level,
    service,
    message: text,
  };
}

/* ---------- continuations (stack traces etc.) ---------- */

const RE_CONTINUATION =
  /^(?:\s+|at\s+\S|Caused by:|\.\.\. \d+ (?:more|common frames)|Traceback \(|goroutine \d|-->|\tat )/;

export function isContinuation(text: string): boolean {
  if (text.length === 0) return true;
  if (RE_CONTINUATION.test(text)) return true;
  return false;
}

/* ---------- the per-line dispatcher ---------- */

export function parseLine(text: string, referenceYear?: number): ParsedLine {
  if (text.charCodeAt(0) === 0x7b) {
    const json = parseJsonLine(text);
    if (json) return json;
  }
  const access = parseAccessLog(text);
  if (access) return access;
  const syslog = parseSyslogLine(text, referenceYear);
  if (syslog) return syslog;
  // Only attempt logfmt when the line looks structured, not prose with '='.
  if (text.includes("=")) {
    const logfmt = parseLogfmt(text);
    // Generic wins when it found a timestamp and logfmt did not.
    if (logfmt && (logfmt.ts !== null || findTimestamp(text) === null)) return logfmt;
  }
  return parseGeneric(text, referenceYear);
}
