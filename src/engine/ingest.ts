/**
 * Ingestion router. Buffers the head of an incoming file, sniffs its shape
 * (delimited export vs line-based log), then streams the rest through the
 * matching path into the store.
 *
 * A user-supplied FormatSpec overrides the automatic behaviour: a "pattern"
 * spec forces line mode through the user's regexes; a "csv" spec overrides
 * the inferred column roles.
 */

import {
  CsvRecordReader,
  inferColumnRoles,
  parseCsvRecord,
  sniffCsv,
  type ColumnRoles,
  type CsvDialect,
} from "./csv";
import {
  applyCsvSpec,
  compilePatternFormat,
  fileSignature,
  type CompiledPatternFormat,
  type FormatSpec,
} from "./custom";
import type { CompiledTimeFormat } from "./strptime";
import { LineSplitter } from "./lines";
import { LineKind } from "./parse";
import type { LogStore } from "./store";

const SNIFF_BYTES = 64 * 1024;
const ROLE_SAMPLE_RECORDS = 24;

export class Ingester {
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private readonly encoder = new TextEncoder();
  private head = "";
  private decided = false;
  private firstLine: string | null = null;

  // line mode
  private splitter: LineSplitter | null = null;

  // csv mode
  private reader: CsvRecordReader | null = null;
  private dialect: CsvDialect | null = null;
  private roles: ColumnRoles | null = null;
  private timeFormat: CompiledTimeFormat | null = null;
  private headerSkipped = false;
  private pendingRecords: { raw: string; fields: string[] }[] = [];

  // custom pattern mode
  private custom: CompiledPatternFormat | null = null;

  private sig: string | null = null;

  constructor(
    private readonly store: LogStore,
    private readonly fileId: number,
    private readonly explicitSpec: FormatSpec | null = null,
    private readonly lookup: (signature: string) => FormatSpec | null = () => null,
  ) {}

  /** Signature of the ingested file (available after the head is seen). */
  signature(): string | null {
    return this.sig;
  }

  push(chunk: Uint8Array): void {
    if (this.decided) {
      this.feed(this.decoder.decode(chunk, { stream: true }));
      return;
    }
    this.head += this.decoder.decode(chunk, { stream: true });
    if (this.head.length >= SNIFF_BYTES) this.decide();
  }

  end(): void {
    if (!this.decided) this.decide();
    const tail = this.decoder.decode(); // flush the decoder
    if (tail.length > 0) this.feed(tail);
    if (this.reader) {
      this.reader.end();
      this.flushRoleBuffer(true);
    } else if (this.splitter) {
      this.splitter.end();
    }
  }

  private consumeHead(): string {
    const h = this.head;
    this.head = "";
    return h;
  }

  private spec: FormatSpec | null = null;

  private decide(): void {
    this.decided = true;
    // Strip a UTF-8 BOM — otherwise the first header cell becomes
    // "﻿TimeUTC" and every downstream lookup silently misses.
    if (this.head.charCodeAt(0) === 0xfeff) this.head = this.head.slice(1);
    const nl = this.head.indexOf("\n");
    this.firstLine = (nl >= 0 ? this.head.slice(0, nl) : this.head).replace(/\r$/, "");

    // Sniff first: the signature depends on the shape, and the spec (explicit
    // or saved-and-recognized) depends on the signature.
    const sniffed = sniffCsv(this.head.slice(0, SNIFF_BYTES));
    this.sig = fileSignature(sniffed?.headerLine ?? null, this.firstLine);
    this.spec = this.explicitSpec ?? this.lookup(this.sig);

    // A pattern spec forces line mode through the user's regexes.
    if (this.spec?.kind === "pattern") {
      const compiled = compilePatternFormat(this.spec);
      if (compiled.ok) {
        this.custom = compiled.format;
        this.store.files[this.fileId]!.customFields = (line) => compiled.format.parse(line).fields;
      }
    }

    const dialect = this.custom ? null : sniffed;
    if (dialect) {
      this.dialect = dialect;
      this.store.files[this.fileId]!.csv = dialect;
      this.reader = new CsvRecordReader(dialect.delimiter, {
        record: (raw, fields) => this.onRecord(raw, fields),
      });
      this.reader.push(this.consumeHead());
    } else {
      this.splitter = new LineSplitter({
        line: (bytes, text) => this.onLine(bytes, text),
      });
      const text = this.consumeHead();
      if (text.length > 0) this.splitter.push(this.encoder.encode(text));
    }
  }

  private feed(text: string): void {
    if (this.reader) {
      this.reader.push(text);
      this.flushRoleBuffer(false);
    } else if (this.splitter && text.length > 0) {
      this.splitter.push(this.encoder.encode(text));
    }
  }

  private onLine(bytes: Uint8Array, text: string): void {
    if (this.custom) {
      const parsed = this.custom.parse(text);
      if (!parsed.matched && this.custom.foldUnmatched && this.store.tryFold(this.fileId, bytes)) {
        return;
      }
      this.store.appendParsed(this.fileId, bytes, text, LineKind.Custom, {
        ts: parsed.ts,
        level: parsed.level,
        service: parsed.service,
        message: parsed.message,
      });
      return;
    }
    this.store.appendLine(this.fileId, bytes, text);
  }

  private onRecord(raw: string, fields: string[]): void {
    if (!this.headerSkipped) {
      this.headerSkipped = true;
      return; // the header row is metadata, not a log entry
    }
    if (this.roles === null) {
      this.pendingRecords.push({ raw, fields });
      if (this.pendingRecords.length >= ROLE_SAMPLE_RECORDS) this.flushRoleBuffer(true);
      return;
    }
    this.append(raw, fields);
  }

  private flushRoleBuffer(force: boolean): void {
    if (this.roles !== null || this.dialect === null) return;
    if (!force && this.pendingRecords.length < ROLE_SAMPLE_RECORDS) return;
    const samples = this.pendingRecords.map((r) => r.fields);
    if (this.spec?.kind === "csv") {
      const applied = applyCsvSpec(this.spec, this.dialect, samples);
      this.roles = applied.roles;
      this.timeFormat = applied.timeFormat;
    } else {
      this.roles = inferColumnRoles(this.dialect.header, samples);
    }
    for (const r of this.pendingRecords) this.append(r.raw, r.fields);
    this.pendingRecords = [];
  }

  private append(raw: string, fields: string[]): void {
    const parsed = parseCsvRecord(fields, this.roles!, this.timeFormat);
    this.store.appendParsed(this.fileId, this.encoder.encode(raw), raw, LineKind.Csv, parsed);
  }
}
