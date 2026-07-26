/**
 * Ingestion router. Buffers the head of an incoming file, sniffs its shape
 * (delimited export vs line-based log), then streams the rest through the
 * matching path into the store.
 */

import { CsvRecordReader, inferColumnRoles, parseCsvRecord, sniffCsv, type ColumnRoles, type CsvDialect } from "./csv";
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

  // line mode
  private splitter: LineSplitter | null = null;

  // csv mode
  private reader: CsvRecordReader | null = null;
  private dialect: CsvDialect | null = null;
  private roles: ColumnRoles | null = null;
  private headerSkipped = false;
  private pendingRecords: { raw: string; fields: string[] }[] = [];

  constructor(
    private readonly store: LogStore,
    private readonly fileId: number,
  ) {}

  push(chunk: Uint8Array): void {
    if (this.decided) {
      this.feed(this.decoder.decode(chunk, { stream: true }), chunk);
      return;
    }
    this.head += this.decoder.decode(chunk, { stream: true });
    if (this.head.length >= SNIFF_BYTES) this.decide();
  }

  end(): void {
    if (!this.decided) this.decide();
    this.head += this.decoder.decode(); // flush decoder
    if (this.reader) {
      this.reader.push(this.consumeHead());
      this.flushRoleBuffer(true);
      this.reader.end();
      this.flushRoleBuffer(true);
    } else if (this.splitter) {
      const rest = this.consumeHead();
      if (rest.length > 0) this.splitter.push(this.encoder.encode(rest));
      this.splitter.end();
    }
  }

  private consumeHead(): string {
    const h = this.head;
    this.head = "";
    return h;
  }

  private decide(): void {
    this.decided = true;
    const dialect = sniffCsv(this.head.slice(0, SNIFF_BYTES));
    if (dialect) {
      this.dialect = dialect;
      this.store.files[this.fileId]!.csv = dialect;
      this.reader = new CsvRecordReader(dialect.delimiter, {
        record: (raw, fields) => this.onRecord(raw, fields),
      });
      this.reader.push(this.consumeHead());
    } else {
      this.splitter = new LineSplitter({
        line: (bytes, text) => {
          this.store.appendLine(this.fileId, bytes, text);
        },
      });
      const text = this.consumeHead();
      if (text.length > 0) this.splitter.push(this.encoder.encode(text));
    }
  }

  private feed(text: string, _chunk: Uint8Array): void {
    if (this.reader) {
      this.reader.push(text);
      this.flushRoleBuffer(false);
    } else if (this.splitter && text.length > 0) {
      this.splitter.push(this.encoder.encode(text));
    }
  }

  private onRecord(raw: string, fields: string[]): void {
    if (!this.headerSkipped) {
      this.headerSkipped = true;
      return; // the header row is metadata, not a log entry
    }
    if (this.roles === null) {
      this.pendingRecords.push({ raw, fields });
      return;
    }
    this.append(raw, fields);
  }

  private flushRoleBuffer(force: boolean): void {
    if (this.roles !== null || this.dialect === null) return;
    if (!force && this.pendingRecords.length < ROLE_SAMPLE_RECORDS) return;
    this.roles = inferColumnRoles(
      this.dialect.header,
      this.pendingRecords.map((r) => r.fields),
    );
    for (const r of this.pendingRecords) this.append(r.raw, r.fields);
    this.pendingRecords = [];
  }

  private append(raw: string, fields: string[]): void {
    const parsed = parseCsvRecord(fields, this.roles!);
    this.store.appendParsed(this.fileId, this.encoder.encode(raw), raw, LineKind.Csv, parsed);
  }
}
