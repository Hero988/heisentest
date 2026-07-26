/** Promise-based client for the engine worker. */

import type { FormatSpec } from "./custom";
import type {
  FileSummary,
  KnownFormat,
  QuerySnapshot,
  SerializableFilter,
  WorkerRequest,
  WorkerResponse,
} from "./protocol";
import type { RowView } from "./store";

export interface FileInfo {
  fileId: number;
  signature: string | null;
  csvHeader: string[] | null;
  headLines: string[];
}

export interface LoadProgress {
  rows: number;
  bytes: number;
}

export interface DetailResult {
  rowId: number;
  fullText: string;
  fields: Record<string, unknown> | null;
}

type Pending = {
  resolve: (value: never) => void;
  reject: (err: Error) => void;
  onProgress?: ((p: LoadProgress) => void) | undefined;
  onFile?: ((f: FileSummary) => void) | undefined;
};

export class EngineClient {
  private readonly worker: Worker;
  private nextReqId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.dispatch(event.data);
  }

  private dispatch(msg: WorkerResponse): void {
    const entry = this.pending.get(msg.reqId);
    if (!entry) return;
    switch (msg.type) {
      case "progress":
        entry.onProgress?.({ rows: msg.rows, bytes: msg.bytes });
        break;
      case "loaded":
        entry.onFile?.(msg.file);
        break;
      case "snapshot":
        this.settle(msg.reqId, msg.snapshot);
        break;
      case "rows":
        this.settle(msg.reqId, { start: msg.start, rows: msg.rows });
        break;
      case "detail":
        this.settle(msg.reqId, { rowId: msg.rowId, fullText: msg.fullText, fields: msg.fields });
        break;
      case "file-info":
        this.settle(msg.reqId, {
          fileId: msg.fileId,
          signature: msg.signature,
          csvHeader: msg.csvHeader,
          headLines: msg.headLines,
        });
        break;
      case "position":
        this.settle(msg.reqId, msg.position);
        break;
      case "done":
        this.settle(msg.reqId, undefined);
        break;
      case "error":
        this.pending.delete(msg.reqId);
        entry.reject(new Error(msg.message));
        break;
    }
  }

  private settle(reqId: number, value: unknown): void {
    const entry = this.pending.get(reqId);
    if (!entry) return;
    this.pending.delete(reqId);
    entry.resolve(value as never);
  }

  private send<T>(
    build: (reqId: number) => WorkerRequest,
    extras?: Pick<Pending, "onProgress" | "onFile">,
  ): Promise<T> {
    const reqId = this.nextReqId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, {
        resolve: resolve as (value: never) => void,
        reject,
        onProgress: extras?.onProgress,
        onFile: extras?.onFile,
      });
      this.worker.postMessage(build(reqId));
    });
  }

  loadSample(onFile?: (f: FileSummary) => void): Promise<void> {
    return this.send((reqId) => ({ type: "load-sample", reqId }), { onFile });
  }

  addFile(
    file: File,
    known?: KnownFormat[],
    onProgress?: (p: LoadProgress) => void,
    onFile?: (f: FileSummary) => void,
  ): Promise<void> {
    return this.send(
      (reqId) => ({ type: "add-file", reqId, name: file.name, file, known: known ?? [] }),
      { onProgress, onFile },
    );
  }

  addText(name: string, text: string, known?: KnownFormat[]): Promise<void> {
    return this.send((reqId) => ({ type: "add-text", reqId, name, text, known: known ?? [] }));
  }

  reparseFile(fileId: number, spec: FormatSpec | null): Promise<void> {
    return this.send((reqId) => ({ type: "reparse-file", reqId, fileId, spec }));
  }

  fileInfo(fileId: number): Promise<FileInfo> {
    return this.send((reqId) => ({ type: "file-info", reqId, fileId }));
  }

  query(spec: SerializableFilter): Promise<QuerySnapshot> {
    return this.send((reqId) => ({ type: "query", reqId, spec }));
  }

  rows(start: number, end: number): Promise<{ start: number; rows: RowView[] }> {
    return this.send((reqId) => ({ type: "rows", reqId, start, end }));
  }

  detail(rowId: number): Promise<DetailResult> {
    return this.send((reqId) => ({ type: "detail", reqId, rowId }));
  }

  positionForTime(ms: number): Promise<number> {
    return this.send((reqId) => ({ type: "position-for-time", reqId, ms }));
  }

  reset(): Promise<void> {
    return this.send((reqId) => ({ type: "reset", reqId }));
  }
}
