/** Messages between the UI and the engine worker. */

import type { Level } from "./levels";
import type { FilterSpec, HistogramResult, RowView } from "./store";

export interface FileSummary {
  id: number;
  name: string;
  rows: number;
  firstTs: number | null;
  lastTs: number | null;
}

export interface FacetCounts {
  levels: number[]; // indexed by Level
  services: { id: number; name: string; count: number }[];
  files: FileSummary[];
}

export interface QuerySnapshot {
  count: number;
  totalRows: number;
  approxBytes: number;
  histogram: SerializedHistogram | null;
  facets: FacetCounts;
}

export interface SerializedHistogram {
  bucketMs: number;
  startMs: number;
  total: number[];
  errors: number[];
  warns: number[];
}

export function serializeHistogram(h: HistogramResult | null): SerializedHistogram | null {
  if (!h) return null;
  return {
    bucketMs: h.bucketMs,
    startMs: h.startMs,
    total: Array.from(h.total),
    errors: Array.from(h.errors),
    warns: Array.from(h.warns),
  };
}

export type WorkerRequest =
  | { type: "load-sample"; reqId: number }
  | { type: "add-file"; reqId: number; name: string; file: File }
  | { type: "add-text"; reqId: number; name: string; text: string }
  | { type: "query"; reqId: number; spec: SerializableFilter }
  | { type: "rows"; reqId: number; start: number; end: number }
  | { type: "detail"; reqId: number; rowId: number }
  | { type: "position-for-time"; reqId: number; ms: number }
  | { type: "reset"; reqId: number };

export interface SerializableFilter {
  query?: string;
  levels?: Level[];
  fileIds?: number[];
  serviceIds?: number[];
  timeRange?: [number, number];
}

export function toFilterSpec(s: SerializableFilter): FilterSpec {
  const spec: FilterSpec = {};
  if (s.query !== undefined && s.query.length > 0) spec.query = s.query;
  if (s.levels && s.levels.length > 0) spec.levels = new Set(s.levels);
  if (s.fileIds && s.fileIds.length > 0) spec.fileIds = new Set(s.fileIds);
  if (s.serviceIds && s.serviceIds.length > 0) spec.serviceIds = new Set(s.serviceIds);
  if (s.timeRange) spec.timeRange = s.timeRange;
  return spec;
}

export type WorkerResponse =
  | { type: "progress"; reqId: number; rows: number; bytes: number }
  | { type: "loaded"; reqId: number; file: FileSummary }
  | { type: "snapshot"; reqId: number; snapshot: QuerySnapshot }
  | { type: "rows"; reqId: number; start: number; rows: RowView[] }
  | {
      type: "detail";
      reqId: number;
      rowId: number;
      fullText: string;
      fields: Record<string, unknown> | null;
    }
  | { type: "position"; reqId: number; position: number }
  | { type: "done"; reqId: number }
  | { type: "error"; reqId: number; message: string };
