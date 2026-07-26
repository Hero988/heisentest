/// <reference lib="webworker" />
/**
 * The engine worker. Owns the LogStore; the UI thread never touches raw data.
 * Files stream in here chunk by chunk; queries return counts, histograms and
 * facets; the UI asks only for the rows it can see.
 */

import type { FormatSpec } from "./custom";
import { Ingester } from "./ingest";
import {
  serializeHistogram,
  toFilterSpec,
  type KnownFormat,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol";
import { generateSample } from "./sample";
import { LogStore } from "./store";

let store = new LogStore();
let filtered: Uint32Array = new Uint32Array(0);
/** Format spec in force per fileId (explicit or auto-applied). */
const fileSpecs = new Map<number, FormatSpec>();
const fileSignatures = new Map<number, string | null>();

function post(msg: WorkerResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

const encoder = new TextEncoder();

function makeIngester(fileId: number, known: KnownFormat[] | undefined): Ingester {
  const explicit = fileSpecs.get(fileId) ?? null;
  return new Ingester(store, fileId, explicit, (signature) => {
    const hit = known?.find((k) => k.signature === signature);
    if (hit) fileSpecs.set(fileId, hit.spec);
    return hit?.spec ?? null;
  });
}

function addText(fileName: string, text: string, reqId: number, known?: KnownFormat[]): void {
  const fileId = store.addFile(fileName);
  const ingester = makeIngester(fileId, known);
  ingester.push(encoder.encode(text));
  ingester.end();
  fileSignatures.set(fileId, ingester.signature());
  finishFile(fileId, reqId);
}

async function addFile(file: File, reqId: number, known?: KnownFormat[]): Promise<void> {
  const fileId = store.addFile(file.name);
  let bytesRead = 0;
  let lastProgress = 0;
  const ingester = makeIngester(fileId, known);
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    ingester.push(value);
    bytesRead += value.byteLength;
    if (bytesRead - lastProgress > 16 * 1024 * 1024) {
      lastProgress = bytesRead;
      post({ type: "progress", reqId, rows: store.rowCount, bytes: bytesRead });
    }
  }
  ingester.end();
  fileSignatures.set(fileId, ingester.signature());
  finishFile(fileId, reqId);
}

function finishFile(fileId: number, reqId: number): void {
  const f = store.files[fileId]!;
  post({
    type: "loaded",
    reqId,
    file: {
      id: fileId,
      name: f.name,
      rows: f.rows,
      firstTs: f.firstTs,
      lastTs: f.lastTs,
      signature: fileSignatures.get(fileId) ?? null,
      csvHeader: f.csv?.header ?? null,
    },
  });
}

/** Re-ingest every file from stored bytes, applying the current specs. */
function rebuildStore(): void {
  const texts = store.files.map((f, id) => ({ name: f.name, text: store.extractFileText(id) }));
  store = new LogStore();
  filtered = new Uint32Array(0);
  for (const { name, text } of texts) {
    const fileId = store.addFile(name);
    const ingester = new Ingester(store, fileId, fileSpecs.get(fileId) ?? null, () => null);
    ingester.push(encoder.encode(text));
    ingester.end();
    fileSignatures.set(fileId, ingester.signature());
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "load-sample": {
        const sample = generateSample();
        addText(sample.app.name, sample.app.text, msg.reqId);
        addText(sample.gateway.name, sample.gateway.text, msg.reqId);
        post({ type: "done", reqId: msg.reqId });
        break;
      }
      case "add-file":
        await addFile(msg.file, msg.reqId, msg.known);
        post({ type: "done", reqId: msg.reqId });
        break;
      case "add-text":
        addText(msg.name, msg.text, msg.reqId, msg.known);
        post({ type: "done", reqId: msg.reqId });
        break;
      case "reparse-file":
        if (msg.spec === null) fileSpecs.delete(msg.fileId);
        else fileSpecs.set(msg.fileId, msg.spec);
        rebuildStore();
        post({ type: "done", reqId: msg.reqId });
        break;
      case "file-info": {
        const lines: string[] = [];
        const fid = msg.fileId;
        const csv = store.files[fid]?.csv;
        for (let id = 0; id < store.rowCount && lines.length < 12; id++) {
          const rows = store.getRows([id]);
          if (rows[0]!.fileId === fid) {
            const full = store.fullText(id);
            lines.push(full.includes("\n") ? full.slice(0, full.indexOf("\n")) : full);
          }
        }
        post({
          type: "file-info",
          reqId: msg.reqId,
          fileId: fid,
          signature: fileSignatures.get(fid) ?? null,
          csvHeader: csv?.header ?? null,
          headLines: csv ? [csv.headerLine, ...lines] : lines,
        });
        break;
      }
      case "query": {
        filtered = store.filter(toFilterSpec(msg.spec));
        const counts = store.facetCounts();
        post({
          type: "snapshot",
          reqId: msg.reqId,
          snapshot: {
            count: filtered.length,
            totalRows: store.rowCount,
            approxBytes: store.approxBytes(),
            histogram: serializeHistogram(store.histogram(filtered)),
            facets: {
              levels: counts.levels,
              services: counts.services,
              files: counts.files.map((f) => ({
                ...f,
                signature: fileSignatures.get(f.id) ?? null,
                csvHeader: store.files[f.id]?.csv?.header ?? null,
              })),
            },
          },
        });
        break;
      }
      case "rows": {
        const start = Math.max(0, msg.start);
        const slice = filtered.subarray(start, Math.min(filtered.length, msg.end));
        post({ type: "rows", reqId: msg.reqId, start, rows: store.getRows(slice) });
        break;
      }
      case "detail":
        post({
          type: "detail",
          reqId: msg.reqId,
          rowId: msg.rowId,
          fullText: store.fullText(msg.rowId),
          fields: store.fields(msg.rowId),
        });
        break;
      case "position-for-time": {
        // First position within the FILTERED list at/after the time.
        let lo = 0;
        let hi = filtered.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const eff = store.effectiveTs(filtered[mid]!);
          if (Number.isNaN(eff) || eff < msg.ms) lo = mid + 1;
          else hi = mid;
        }
        post({ type: "position", reqId: msg.reqId, position: lo });
        break;
      }
      case "reset":
        store = new LogStore();
        filtered = new Uint32Array(0);
        post({ type: "done", reqId: msg.reqId });
        break;
    }
  } catch (err) {
    post({
      type: "error",
      reqId: msg.reqId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
