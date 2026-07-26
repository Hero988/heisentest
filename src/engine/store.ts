/**
 * Columnar row store.
 *
 * Raw line bytes live in append-only 8 MB blocks (memory ≈ file size, one
 * copy, no giant strings). Every row is a handful of typed-array entries;
 * message strings are materialized only for visible rows and search hits.
 *
 * Multi-line entries (stack traces) fold into their opening row: the row's
 * byte range simply extends, so the trace travels with its error.
 *
 * Ordering: rows carry an "effective" timestamp — their own, or the last
 * seen one in the same file — clamped monotone per file. That makes the
 * global merge across files exact and O(n), at the cost of ordering the
 * rare backwards-timestamped line at its neighbour's position. Display
 * timestamps are never altered.
 */

import { splitDelimited, type CsvDialect } from "./csv";
import { GrowableF64, GrowableU32, GrowableU8, GrowableI32 } from "./growable";
import { Level } from "./levels";
import {
  LineKind,
  parseLine,
  isContinuation,
  jsonFields,
  logfmtFields,
  accessFields,
} from "./parse";

const BLOCK_SIZE = 8 * 1024 * 1024;
const MAX_FOLD_BYTES = 1 << 20; // 1 MB per logical row
const NO_SERVICE = -1;

export interface RowView {
  id: number;
  ts: number | null;
  level: Level;
  service: string | null;
  file: string;
  fileId: number;
  lineNo: number;
  message: string;
  foldedLines: number;
}

export interface FilterSpec {
  query?: string;
  levels?: ReadonlySet<Level>;
  fileIds?: ReadonlySet<number>;
  serviceIds?: ReadonlySet<number>;
  /** [fromMs, toMs] inclusive over effective timestamps. */
  timeRange?: readonly [number, number];
}

export interface HistogramResult {
  bucketMs: number;
  startMs: number;
  /** Every row in the store — the stable context. */
  total: Uint32Array;
  /** Rows matching the current filters. */
  matched: Uint32Array;
  /** Errors / warns within the matched set. */
  errors: Uint32Array;
  warns: Uint32Array;
}

export class LogStore {
  private blocks: Uint8Array[] = [new Uint8Array(BLOCK_SIZE)];
  private cursor = 0;
  private usedBytes = 0;

  private readonly tsMs = new GrowableF64(); // NaN = none
  private readonly effTs = new GrowableF64();
  private readonly level = new GrowableU8();
  private readonly kind = new GrowableU8();
  private readonly svcId = new GrowableI32();
  private readonly fileId = new GrowableU8();
  private readonly blockIdx = new GrowableU32();
  private readonly offset = new GrowableU32();
  private readonly byteLen = new GrowableU32();
  private readonly lineNo = new GrowableU32();
  private readonly folded = new GrowableU32();

  private readonly services: string[] = [];
  private readonly serviceIds = new Map<string, number>();
  readonly files: {
    name: string;
    rows: number;
    firstTs: number | null;
    lastTs: number | null;
    csv?: CsvDialect;
    /** Field extractor for rows ingested under a custom pattern format. */
    customFields?: (line: string) => Record<string, string>;
  }[] = [];

  private messages = new Map<number, string>();
  private sorted: Uint32Array | null = null;

  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

  private lastEffTsPerFile: number[] = [];
  private lastRowPerFile: number[] = [];
  private lineNoPerFile: number[] = [];

  get rowCount(): number {
    return this.tsMs.length;
  }

  get serviceNames(): readonly string[] {
    return this.services;
  }

  addFile(name: string): number {
    this.files.push({ name, rows: 0, firstTs: null, lastTs: null });
    this.lastEffTsPerFile.push(NaN);
    this.lastRowPerFile.push(-1);
    this.lineNoPerFile.push(0);
    this.sorted = null;
    return this.files.length - 1;
  }

  /** Append one raw line belonging to `fileId`. Returns the row id, or -1 if folded. */
  appendLine(fileId: number, bytes: Uint8Array, text: string, referenceYear?: number): number {
    const file = this.files[fileId];
    if (!file) throw new Error(`unknown file ${fileId}`);
    this.lineNoPerFile[fileId]!++;

    if (isContinuation(text) && this.tryFold(fileId, bytes)) return -1;

    const parsed = parseLine(text, referenceYear);
    return this.appendRow(fileId, bytes, text, parsed.kind, parsed);
  }

  /**
   * Fold `bytes` into the file's previous row (stack traces, custom-format
   * unmatched lines). Returns false when folding isn't possible.
   */
  tryFold(fileId: number, bytes: Uint8Array): boolean {
    const lastRow = this.lastRowPerFile[fileId]!;
    if (lastRow < 0) return false;
    const currentLen = this.byteLen.get(lastRow);
    if (currentLen + bytes.length + 1 > MAX_FOLD_BYTES || !this.canExtend(lastRow)) return false;
    this.extendRow(lastRow, bytes);
    this.folded.set(lastRow, this.folded.get(lastRow) + 1);
    return true;
  }

  /** Append a pre-parsed record (CSV path, custom formats). */
  appendParsed(
    fileId: number,
    bytes: Uint8Array,
    rawText: string,
    kind: LineKind,
    parsed: { ts: number | null; level: Level; service: string | null; message: string },
  ): number {
    const file = this.files[fileId];
    if (!file) throw new Error(`unknown file ${fileId}`);
    this.lineNoPerFile[fileId]!++;
    return this.appendRow(fileId, bytes, rawText, kind, parsed);
  }

  private appendRow(
    fileId: number,
    bytes: Uint8Array,
    text: string,
    kind: LineKind,
    parsed: { ts: number | null; level: Level; service: string | null; message: string },
  ): number {
    const file = this.files[fileId]!;
    const stored = this.storeBytes(bytes);

    let svc = NO_SERVICE;
    if (parsed.service !== null) {
      const existing = this.serviceIds.get(parsed.service);
      if (existing !== undefined) {
        svc = existing;
      } else if (this.services.length < 512) {
        svc = this.services.length;
        this.services.push(parsed.service);
        this.serviceIds.set(parsed.service, svc);
      }
    }

    const prevEff = this.lastEffTsPerFile[fileId]!;
    let eff: number;
    if (parsed.ts !== null) {
      eff = Number.isNaN(prevEff) ? parsed.ts : Math.max(prevEff, parsed.ts);
    } else {
      eff = prevEff; // may be NaN before the first timestamp
    }
    this.lastEffTsPerFile[fileId] = eff;

    const id = this.tsMs.push(parsed.ts ?? NaN);
    this.effTs.push(eff);
    this.level.push(parsed.level);
    this.kind.push(kind);
    this.svcId.push(svc);
    this.fileId.push(fileId);
    this.blockIdx.push(stored.block);
    this.offset.push(stored.offset);
    this.byteLen.push(bytes.length);
    this.lineNo.push(this.lineNoPerFile[fileId]!);
    this.folded.push(0);

    if (parsed.message !== text) this.messages.set(id, parsed.message);

    file.rows++;
    if (parsed.ts !== null) {
      if (file.firstTs === null || parsed.ts < file.firstTs) file.firstTs = parsed.ts;
      if (file.lastTs === null || parsed.ts > file.lastTs) file.lastTs = parsed.ts;
    }
    this.lastRowPerFile[fileId] = id;
    this.sorted = null;
    return id;
  }

  private canExtend(row: number): boolean {
    // A row can only grow while it is the last thing written to the byte log.
    const block = this.blockIdx.get(row);
    const end = this.offset.get(row) + this.byteLen.get(row);
    return block === this.blocks.length - 1 && end === this.cursor;
  }

  private extendRow(row: number, bytes: Uint8Array): void {
    const block = this.blocks[this.blocks.length - 1]!;
    if (this.cursor + bytes.length + 1 > block.length) {
      // Move the row's bytes to a fresh block big enough for the fold.
      const existing = this.rowBytes(row);
      const needed = existing.length + bytes.length + 1;
      const size = Math.max(BLOCK_SIZE, needed);
      const fresh = new Uint8Array(size);
      fresh.set(existing, 0);
      this.blocks.push(fresh);
      this.blockIdx.set(row, this.blocks.length - 1);
      this.offset.set(row, 0);
      this.cursor = existing.length;
    }
    const target = this.blocks[this.blocks.length - 1]!;
    target[this.cursor] = 0x0a;
    target.set(bytes, this.cursor + 1);
    this.cursor += bytes.length + 1;
    this.usedBytes += bytes.length + 1;
    this.byteLen.set(row, this.byteLen.get(row) + bytes.length + 1);
  }

  private storeBytes(bytes: Uint8Array): { block: number; offset: number } {
    let block = this.blocks[this.blocks.length - 1]!;
    if (this.cursor + bytes.length > block.length) {
      block = new Uint8Array(Math.max(BLOCK_SIZE, bytes.length));
      this.blocks.push(block);
      this.cursor = 0;
    }
    block.set(bytes, this.cursor);
    const offset = this.cursor;
    this.cursor += bytes.length;
    this.usedBytes += bytes.length;
    return { block: this.blocks.length - 1, offset };
  }

  private rowBytes(row: number): Uint8Array {
    const block = this.blocks[this.blockIdx.get(row)]!;
    const start = this.offset.get(row);
    return block.subarray(start, start + this.byteLen.get(row));
  }

  /** Global display order: files merged by monotone effective timestamp. */
  order(): Uint32Array {
    if (this.sorted) return this.sorted;
    const n = this.rowCount;
    const out = new Uint32Array(n);
    const eff = this.effTs.view();
    const fid = this.fileId.view();

    if (this.files.length <= 1) {
      for (let i = 0; i < n; i++) out[i] = i;
      this.sorted = out;
      return out;
    }

    // Collect per-file row id lists (append order — already monotone in effTs).
    const perFile: Uint32Array[] = this.files.map(
      (f) => new Uint32Array(f.rows + /* untimestamped safety */ 0),
    );
    const fill = this.files.map(() => 0);
    for (let i = 0; i < n; i++) {
      const f = fid[i]!;
      perFile[f]![fill[f]!++] = i;
    }

    // K-way merge; rows with NaN effTs (before any timestamp) go first, in file order.
    const heads = this.files.map(() => 0);
    let cursor = 0;
    for (let f = 0; f < perFile.length; f++) {
      const list = perFile[f]!;
      while (heads[f]! < list.length && Number.isNaN(eff[list[heads[f]!]!]!)) {
        out[cursor++] = list[heads[f]!]!;
        heads[f]!++;
      }
    }
    while (cursor < n) {
      let best = -1;
      let bestTs = Infinity;
      for (let f = 0; f < perFile.length; f++) {
        const h = heads[f]!;
        const list = perFile[f]!;
        if (h < list.length) {
          const ts = eff[list[h]!]!;
          if (ts < bestTs) {
            bestTs = ts;
            best = f;
          }
        }
      }
      if (best < 0) break;
      out[cursor++] = perFile[best]![heads[best]!]!;
      heads[best]!++;
    }
    this.sorted = out;
    return out;
  }

  /**
   * Filter rows; returns row ids in display order.
   * Chunked so a caller can keep a worker responsive and cancel mid-scan.
   */
  filter(spec: FilterSpec, onChunk?: (done: number, total: number) => boolean): Uint32Array {
    const order = this.order();
    const n = order.length;
    const out = new GrowableU32(Math.min(4096, Math.max(16, n)));

    const wantLevels = spec.levels && spec.levels.size > 0 ? spec.levels : null;
    const wantFiles = spec.fileIds && spec.fileIds.size > 0 ? spec.fileIds : null;
    const wantSvcs = spec.serviceIds && spec.serviceIds.size > 0 ? spec.serviceIds : null;
    const range = spec.timeRange ?? null;
    const needle = spec.query && spec.query.length > 0 ? spec.query.toLowerCase() : null;
    const needleBytes = needle ? this.encoder.encode(needle) : null;

    const CHUNK = 262_144;
    for (let i = 0; i < n; i++) {
      const id = order[i]!;
      if (wantLevels && !wantLevels.has(this.level.get(id) as Level)) continue;
      if (wantFiles && !wantFiles.has(this.fileId.get(id))) continue;
      if (wantSvcs && !wantSvcs.has(this.svcId.get(id))) continue;
      if (range) {
        const eff = this.effTs.get(id);
        if (Number.isNaN(eff) || eff < range[0] || eff > range[1]) continue;
      }
      if (needleBytes) {
        const inMsg = this.messages.get(id)?.toLowerCase().includes(needle!) ?? false;
        if (!inMsg && !containsFoldedCase(this.rowBytes(id), needleBytes)) continue;
      }
      out.push(id);
      if (onChunk && i % CHUNK === CHUNK - 1) {
        if (!onChunk(i + 1, n)) return out.view().slice();
      }
    }
    return out.view().slice();
  }

  /**
   * Histogram whose buckets always span the WHOLE store (stable context),
   * with the filtered rows overlaid. Filtering never rescales the timeline.
   */
  histogram(matchedIds: Uint32Array, targetBuckets = 120): HistogramResult | null {
    const eff = this.effTs.view();
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < eff.length; i++) {
      const t = eff[i]!;
      if (!Number.isNaN(t)) {
        if (t < min) min = t;
        if (t > max) max = t;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    const span = Math.max(1000, max - min);
    const niceSteps = [
      1000, 5000, 10_000, 30_000, 60_000, 300_000, 600_000, 1_800_000, 3_600_000, 21_600_000,
      86_400_000,
    ];
    let bucketMs = niceSteps[niceSteps.length - 1]!;
    for (const step of niceSteps) {
      if (span / step <= targetBuckets) {
        bucketMs = step;
        break;
      }
    }
    const startMs = Math.floor(min / bucketMs) * bucketMs;
    const buckets = Math.max(1, Math.ceil((max - startMs + 1) / bucketMs));
    const total = new Uint32Array(buckets);
    const matched = new Uint32Array(buckets);
    const errors = new Uint32Array(buckets);
    const warns = new Uint32Array(buckets);
    for (let i = 0; i < eff.length; i++) {
      const t = eff[i]!;
      if (Number.isNaN(t)) continue;
      total[Math.min(buckets - 1, Math.floor((t - startMs) / bucketMs))]!++;
    }
    for (let i = 0; i < matchedIds.length; i++) {
      const id = matchedIds[i]!;
      const t = this.effTs.get(id);
      if (Number.isNaN(t)) continue;
      const b = Math.min(buckets - 1, Math.floor((t - startMs) / bucketMs));
      matched[b]!++;
      const lv = this.level.get(id);
      if (lv === Level.Error) errors[b]!++;
      else if (lv === Level.Warn) warns[b]!++;
    }
    return { bucketMs, startMs, total, matched, errors, warns };
  }

  /** Materialize rows for display. */
  getRows(ids: ArrayLike<number>): RowView[] {
    const out: RowView[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const ts = this.tsMs.get(id);
      const svc = this.svcId.get(id);
      out.push({
        id,
        ts: Number.isNaN(ts) ? null : ts,
        level: this.level.get(id) as Level,
        service: svc === NO_SERVICE ? null : (this.services[svc] ?? null),
        file: this.files[this.fileId.get(id)]!.name,
        fileId: this.fileId.get(id),
        lineNo: this.lineNo.get(id),
        message: this.messageFor(id),
        foldedLines: this.folded.get(id),
      });
    }
    return out;
  }

  private messageFor(id: number): string {
    const cached = this.messages.get(id);
    if (cached !== undefined) return cached;
    const bytes = this.rowBytes(id);
    const nl = bytes.indexOf(0x0a);
    const firstLine = nl >= 0 ? bytes.subarray(0, nl) : bytes;
    return this.decoder.decode(firstLine);
  }

  /** Full raw text of a row including folded continuation lines. */
  fullText(id: number): string {
    return this.decoder.decode(this.rowBytes(id));
  }

  /** Structured fields for the detail view, re-parsed on demand. */
  fields(id: number): Record<string, unknown> | null {
    const text = this.fullText(id);
    const firstLine = text.includes("\n") ? text.slice(0, text.indexOf("\n")) : text;
    switch (this.kind.get(id) as LineKind) {
      case LineKind.Json:
        return jsonFields(firstLine);
      case LineKind.Logfmt:
        return logfmtFields(firstLine);
      case LineKind.Access:
        return accessFields(firstLine);
      case LineKind.Csv: {
        const csv = this.files[this.fileId.get(id)]?.csv;
        if (!csv) return null;
        const values = splitDelimited(text, csv.delimiter);
        const out: Record<string, string> = {};
        for (let i = 0; i < csv.header.length; i++) {
          const v = values[i];
          if (v !== undefined && v !== "") out[csv.header[i]!] = v;
        }
        return out;
      }
      case LineKind.Custom: {
        const extract = this.files[this.fileId.get(id)]?.customFields;
        return extract ? extract(firstLine) : null;
      }
      default:
        return null;
    }
  }

  /**
   * Reconstruct a file's full text from stored bytes (folded rows keep their
   * newlines; a CSV header line is restored). Powers re-parsing under a
   * user-supplied format without keeping a second copy of the file.
   */
  extractFileText(fileId: number): string {
    const parts: string[] = [];
    const csv = this.files[fileId]?.csv;
    if (csv) parts.push(csv.headerLine);
    const fid = this.fileId.view();
    for (let id = 0; id < this.rowCount; id++) {
      if (fid[id] === fileId) parts.push(this.fullText(id));
    }
    return parts.join("\n") + "\n";
  }

  /** Position (in display order) of the first row at/after the given time. */
  positionForTime(order: Uint32Array, ms: number): number {
    let lo = 0;
    let hi = order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const eff = this.effTs.get(order[mid]!);
      if (Number.isNaN(eff) || eff < ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  approxBytes(): number {
    return this.usedBytes;
  }

  /** Facet counts over ALL rows — cheap column scans, no materialization. */
  facetCounts(): {
    levels: number[];
    services: { id: number; name: string; count: number }[];
    files: { id: number; name: string; rows: number; firstTs: number | null; lastTs: number | null }[];
  } {
    const levels = new Array<number>(6).fill(0);
    const svc = new Array<number>(this.services.length).fill(0);
    const lv = this.level.view();
    const sv = this.svcId.view();
    for (let i = 0; i < lv.length; i++) {
      levels[lv[i]!]!++;
      const s = sv[i]!;
      if (s >= 0) svc[s]!++;
    }
    return {
      levels,
      services: this.services
        .map((name, id) => ({ id, name, count: svc[id]! }))
        .filter((s) => s.count > 0)
        .sort((a, b) => b.count - a.count),
      files: this.files.map((f, id) => ({
        id,
        name: f.name,
        rows: f.rows,
        firstTs: f.firstTs,
        lastTs: f.lastTs,
      })),
    };
  }

  /** Effective timestamp for a row (NaN when the file had none yet). */
  effectiveTs(id: number): number {
    return this.effTs.get(id);
  }
}

/** Case-insensitive (ASCII) byte search of `needleLower` in `haystack`. */
export function containsFoldedCase(haystack: Uint8Array, needleLower: Uint8Array): boolean {
  const n = needleLower.length;
  if (n === 0) return true;
  const limit = haystack.length - n;
  const first = needleLower[0]!;
  const firstUpper = first >= 0x61 && first <= 0x7a ? first - 0x20 : first;
  outer: for (let i = 0; i <= limit; i++) {
    const c = haystack[i]!;
    if (c !== first && c !== firstUpper) continue;
    for (let j = 1; j < n; j++) {
      let h = haystack[i + j]!;
      if (h >= 0x41 && h <= 0x5a) h += 0x20;
      if (h !== needleLower[j]) continue outer;
    }
    return true;
  }
  return false;
}
