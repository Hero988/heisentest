/// <reference lib="webworker" />
/**
 * The engine worker. Owns the LogStore; the UI thread never touches raw data.
 * Files stream in here chunk by chunk; queries return counts, histograms and
 * facets; the UI asks only for the rows it can see.
 */

import { LineSplitter } from "./lines";
import {
  serializeHistogram,
  toFilterSpec,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol";
import { generateSample } from "./sample";
import { LogStore } from "./store";

let store = new LogStore();
let filtered: Uint32Array = new Uint32Array(0);

function post(msg: WorkerResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

const encoder = new TextEncoder();

function addText(fileName: string, text: string, reqId: number): void {
  const fileId = store.addFile(fileName);
  const splitter = new LineSplitter({
    line: (bytes, lineText) => {
      store.appendLine(fileId, bytes, lineText);
    },
  });
  splitter.push(encoder.encode(text));
  splitter.end();
  finishFile(fileId, reqId);
}

async function addFile(file: File, reqId: number): Promise<void> {
  const fileId = store.addFile(file.name);
  let bytesRead = 0;
  let lastProgress = 0;
  const splitter = new LineSplitter({
    line: (bytes, lineText) => {
      store.appendLine(fileId, bytes, lineText);
    },
  });
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    splitter.push(value);
    bytesRead += value.byteLength;
    if (bytesRead - lastProgress > 16 * 1024 * 1024) {
      lastProgress = bytesRead;
      post({ type: "progress", reqId, rows: store.rowCount, bytes: bytesRead });
    }
  }
  splitter.end();
  finishFile(fileId, reqId);
}

function finishFile(fileId: number, reqId: number): void {
  const f = store.files[fileId]!;
  post({
    type: "loaded",
    reqId,
    file: { id: fileId, name: f.name, rows: f.rows, firstTs: f.firstTs, lastTs: f.lastTs },
  });
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
        await addFile(msg.file, msg.reqId);
        post({ type: "done", reqId: msg.reqId });
        break;
      case "add-text":
        addText(msg.name, msg.text, msg.reqId);
        post({ type: "done", reqId: msg.reqId });
        break;
      case "query": {
        filtered = store.filter(toFilterSpec(msg.spec));
        post({
          type: "snapshot",
          reqId: msg.reqId,
          snapshot: {
            count: filtered.length,
            totalRows: store.rowCount,
            approxBytes: store.approxBytes(),
            histogram: serializeHistogram(store.histogram(filtered)),
            facets: store.facetCounts(),
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
