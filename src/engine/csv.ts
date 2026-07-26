/**
 * CSV/TSV log support.
 *
 * Platform log exports (Vercel, CloudWatch, Cloudflare, Datadog…) arrive as
 * CSV with a header row, quoted fields that contain commas and even
 * newlines — a shape the plain line splitter structurally cannot handle.
 *
 * Three pieces:
 *   - sniffCsv: decide whether a file is delimited data and with what dialect
 *   - CsvRecordReader: streaming RFC-4180 state machine (cross-chunk safe)
 *   - inferColumnRoles / parseCsvRecord: map columns onto the log model
 */

import { Level, levelFromNumber, levelFromText } from "./levels";
import { findTimestamp, parseFieldTimestamp } from "./timestamps";

export interface CsvDialect {
  delimiter: string;
  header: string[];
  /** Raw header line, so re-parses can skip it. */
  headerLine: string;
}

export interface ColumnRoles {
  /** Index of the timestamp column (highest-resolution wins). */
  time: number;
  /** Explicit level column, if any. */
  level: number;
  /** HTTP-status column used to derive level when `level` is empty/missing. */
  status: number;
  /** Explicit message column, if any. */
  message: number;
  service: number;
  /** Columns composed into a synthetic message when `message` is empty. */
  compose: number[];
}

const NONE = -1;

/* ---------------- dialect sniffing ---------------- */

const DELIMITERS = [",", "\t", ";", "|"];

/** Split one line by a delimiter, honouring quotes (non-streaming helper). */
export function splitDelimited(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

const HEADER_CELL = /^[A-Za-z_@#][A-Za-z0-9_. @#/()-]{0,63}$/;

/**
 * Sniff the head of a file. Returns a dialect only when the evidence is
 * strong: a plausible header row plus consistent field counts beneath it.
 */
export function sniffCsv(sampleText: string): CsvDialect | null {
  const lines = sampleText.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const headerLine = lines[0]!;
  // JSON lines and friends are not CSV, whatever their commas say.
  if (headerLine.startsWith("{") || headerLine.startsWith("[")) return null;

  let best: { delimiter: string; header: string[]; score: number } | null = null;
  for (const delimiter of DELIMITERS) {
    const header = splitDelimited(headerLine, delimiter);
    if (header.length < 2 || header.length > 256) continue;
    // Every header cell must look like a column name, none like a timestamp.
    if (!header.every((h) => HEADER_CELL.test(h.trim()))) continue;
    if (header.some((h) => findTimestamp(h) !== null)) continue;

    // Data rows must agree on the field count (quoted newlines make some
    // sample "lines" partial records — tolerate those, demand a majority).
    const counts: number[] = [];
    for (const line of lines.slice(1, 21)) {
      counts.push(splitDelimited(line, delimiter).length);
    }
    const matching = counts.filter((c) => c === header.length).length;
    if (matching < Math.max(1, Math.floor(counts.length * 0.6))) continue;

    const score = header.length * 10 + matching;
    if (best === null || score > best.score) best = { delimiter, header, score };
  }
  if (best === null) return null;
  return {
    delimiter: best.delimiter,
    header: best.header.map((h) => h.trim()),
    headerLine,
  };
}

/* ---------------- streaming record reader ---------------- */

export interface CsvRecordSink {
  /** One complete record: its raw text (as written) and parsed fields. */
  record(rawText: string, fields: string[]): void;
}

/**
 * RFC-4180 state machine over decoded text chunks. Quoted fields may contain
 * delimiters, escaped quotes ("") and newlines; state survives chunk
 * boundaries. The header record is delivered like any other — callers skip it.
 */
export class CsvRecordReader {
  private field = "";
  private fields: string[] = [];
  private raw = "";
  private inQuotes = false;
  private fieldHadQuote = false;

  constructor(
    private readonly delimiter: string,
    private readonly sink: CsvRecordSink,
  ) {}

  push(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (this.inQuotes) {
        if (ch === '"') {
          // Might be an escaped quote; the peek can cross a chunk boundary,
          // so mark and resolve on the NEXT character instead of peeking.
          this.inQuotes = false;
          this.fieldHadQuote = true;
          this.raw += ch;
        } else {
          this.field += ch;
          this.raw += ch;
        }
        continue;
      }
      if (this.fieldHadQuote && ch === '"') {
        // "" inside a quoted field → literal quote, still in quotes.
        this.field += '"';
        this.raw += ch;
        this.inQuotes = true;
        this.fieldHadQuote = false;
        continue;
      }
      this.fieldHadQuote = false;
      if (ch === '"' && this.field === "") {
        this.inQuotes = true;
        this.raw += ch;
      } else if (ch === this.delimiter) {
        this.fields.push(this.field);
        this.field = "";
        this.raw += ch;
      } else if (ch === "\n") {
        this.endRecord();
      } else if (ch === "\r") {
        // swallow; \n follows in CRLF, bare \r treated as terminator by \n absence is rare
        if (text[i + 1] !== "\n" && i + 1 <= text.length - 1) {
          this.endRecord();
        }
      } else {
        this.field += ch;
        this.raw += ch;
      }
    }
  }

  end(): void {
    if (this.raw.length > 0 || this.field.length > 0 || this.fields.length > 0) {
      this.endRecord();
    }
  }

  private endRecord(): void {
    this.fields.push(this.field);
    const raw = this.raw;
    const fields = this.fields;
    this.field = "";
    this.fields = [];
    this.raw = "";
    this.fieldHadQuote = false;
    // Ignore blank records (trailing newline etc.)
    if (fields.length === 1 && fields[0] === "") return;
    this.sink.record(raw, fields);
  }
}

/* ---------------- column role inference ---------------- */

const TIME_HEADERS = [
  "timestampinms",
  "timestampms",
  "timestamp_ms",
  "@timestamp",
  "timestamp",
  "timeutc",
  "time_utc",
  "eventtime",
  "event_time",
  "_time",
  "time",
  "datetime",
  "date",
  "created",
  "createdat",
  "created_at",
  "ingesttime",
  "receivedat",
];
const LEVEL_HEADERS = ["level", "severity", "loglevel", "log_level", "levelname", "priority", "status_text"];
const STATUS_HEADERS = [
  "responsestatuscode",
  "response_status_code",
  "statuscode",
  "status_code",
  "httpstatus",
  "http_status",
  "responsestatus",
  "status",
  "edgeresponsestatus",
  "originresponsestatus",
];
const MESSAGE_HEADERS = ["message", "msg", "text", "body", "log", "content", "event", "description", "rawlog", "line"];
const SERVICE_HEADERS = [
  "service",
  "servicename",
  "function",
  "functionname",
  "app",
  "appname",
  "application",
  "source",
  "logger",
  "component",
  "container",
  "containername",
  "type",
  "logstream",
  "log_stream",
];
// Columns worth composing into a synthetic message for request-style exports.
const COMPOSE_HEADERS = [
  "requestmethod",
  "request_method",
  "method",
  "requestpath",
  "request_path",
  "path",
  "url",
  "clientrequesturi",
  "requesturi",
  "durationms",
  "duration_ms",
  "duration",
  "latency",
  "region",
];

function norm(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9@_]/g, "");
}

function findHeader(header: string[], candidates: string[]): number {
  const normalized = header.map(norm);
  for (const want of candidates) {
    const at = normalized.indexOf(want);
    if (at >= 0) return at;
  }
  return NONE;
}

/**
 * Decide what each column means, using header names first and value probing
 * as the tiebreaker/validator over the provided sample records.
 */
export function inferColumnRoles(header: string[], samples: string[][]): ColumnRoles {
  const normalized = header.map(norm);

  // Timestamp: collect every header-name candidate, validate against values,
  // prefer the highest resolution (millisecond epochs beat second strings).
  let time = NONE;
  let bestResolution = -1;
  for (let i = 0; i < header.length; i++) {
    const name = normalized[i]!;
    const isCandidate = TIME_HEADERS.includes(name) || name.includes("time") || name.includes("date");
    if (!isCandidate) continue;
    const values = samples.map((r) => r[i] ?? "").filter((v) => v !== "");
    if (values.length === 0) continue;
    const parsed = values.map((v) => parseFieldTimestamp(v));
    const good = parsed.filter((p) => p !== null).length;
    if (good < Math.max(1, Math.ceil(values.length * 0.8))) continue;
    // Resolution: millisecond-precision numeric epochs win over second strings.
    const resolution = values.every((v) => /^\d{13}$/.test(v.trim()))
      ? 2
      : values.some((v) => /[.,]\d{3}/.test(v))
        ? 1
        : 0;
    if (resolution > bestResolution) {
      bestResolution = resolution;
      time = i;
    }
  }

  // Level: must actually contain recognizable level words in the samples
  // (Vercel exports have a `level` column that is usually empty).
  let level = findHeader(header, LEVEL_HEADERS);
  if (level !== NONE) {
    const values = samples.map((r) => r[level] ?? "").filter((v) => v !== "");
    const recognized = values.filter((v) => levelFromText(v) !== Level.Unknown).length;
    if (values.length > 0 && recognized === 0) level = NONE;
  }

  const status = findHeader(header, STATUS_HEADERS);

  // Keep the message column even if sample values are empty — later rows may
  // fill it (Vercel: request rows have no message, function logs do). The
  // per-record parser falls back to composition when the value is empty.
  const message = findHeader(header, MESSAGE_HEADERS);

  const service = findHeader(header, SERVICE_HEADERS);

  const compose: number[] = [];
  for (const want of COMPOSE_HEADERS) {
    const at = normalized.indexOf(want);
    if (at >= 0 && !compose.includes(at)) compose.push(at);
  }
  if (status !== NONE && !compose.includes(status)) compose.unshift(status);

  return { time, level, status, message, service, compose };
}

/* ---------------- record → log row ---------------- */

export interface CsvParsed {
  ts: number | null;
  level: Level;
  service: string | null;
  message: string;
}

export function parseCsvRecord(fields: string[], roles: ColumnRoles): CsvParsed {
  let ts: number | null = null;
  if (roles.time !== NONE) {
    const v = fields[roles.time];
    if (v !== undefined && v !== "") ts = parseFieldTimestamp(v);
  }
  if (ts === null) {
    // Fall back to scanning the whole record for anything timestamp-shaped.
    for (const f of fields) {
      if (f === "") continue;
      const m = findTimestamp(f);
      if (m) {
        ts = m.ts;
        break;
      }
    }
  }

  let level = Level.Unknown;
  if (roles.level !== NONE) {
    const v = fields[roles.level];
    if (v !== undefined && v !== "") level = levelFromText(v);
  }
  if (level === Level.Unknown && roles.status !== NONE) {
    const v = Number(fields[roles.status]);
    if (Number.isFinite(v) && v >= 100 && v < 600) {
      level = v >= 500 ? Level.Error : v >= 400 ? Level.Warn : Level.Info;
    }
  }
  let service: string | null = null;
  if (roles.service !== NONE) {
    const v = fields[roles.service];
    if (v !== undefined && v !== "" && v.length <= 128) service = v;
  }

  let message = "";
  if (roles.message !== NONE) {
    message = fields[roles.message] ?? "";
  }
  if (message === "") {
    const parts: string[] = [];
    for (const i of roles.compose) {
      const v = fields[i];
      if (v !== undefined && v !== "") parts.push(v);
      if (parts.length >= 5) break;
    }
    message = parts.join(" ");
  }
  if (message === "") {
    message = fields.filter((f) => f !== "").slice(0, 4).join(" · ");
  }

  return { ts, level, service, message };
}
