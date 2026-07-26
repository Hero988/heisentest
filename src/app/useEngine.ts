/**
 * The single hook that owns the engine worker, the current filters, the
 * latest snapshot, and a page cache of visible rows.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EngineClient, type DetailResult, type LoadProgress } from "../engine/client";
import type { Level } from "../engine/levels";
import type { FileSummary, QuerySnapshot, SerializableFilter } from "../engine/protocol";
import type { RowView } from "../engine/store";

export interface Filters {
  query: string;
  levels: Set<Level>;
  fileIds: Set<number>;
  serviceIds: Set<number>;
  timeRange: [number, number] | null;
}

export const EMPTY_FILTERS: Filters = {
  query: "",
  levels: new Set(),
  fileIds: new Set(),
  serviceIds: new Set(),
  timeRange: null,
};

function toSerializable(f: Filters): SerializableFilter {
  const spec: SerializableFilter = {};
  if (f.query) spec.query = f.query;
  if (f.levels.size) spec.levels = [...f.levels];
  if (f.fileIds.size) spec.fileIds = [...f.fileIds];
  if (f.serviceIds.size) spec.serviceIds = [...f.serviceIds];
  if (f.timeRange) spec.timeRange = f.timeRange;
  return spec;
}

const PAGE = 256;

export type Phase = "empty" | "loading" | "ready";

export function useEngine() {
  const client = useMemo(() => new EngineClient(), []);
  const [phase, setPhase] = useState<Phase>("empty");
  const [files, setFiles] = useState<FileSummary[]>([]);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [snapshot, setSnapshot] = useState<QuerySnapshot | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [error, setError] = useState<string | null>(null);
  const [loadMs, setLoadMs] = useState<number | null>(null);

  const rowCache = useRef(new Map<number, RowView>());
  const inFlight = useRef(new Set<number>());
  const [cacheVersion, setCacheVersion] = useState(0);
  const queryEpoch = useRef(0);

  const runQuery = useCallback(
    async (f: Filters) => {
      const epoch = ++queryEpoch.current;
      const snap = await client.query(toSerializable(f));
      if (epoch !== queryEpoch.current) return; // superseded
      rowCache.current.clear();
      inFlight.current.clear();
      setSnapshot(snap);
      setCacheVersion((v) => v + 1);
    },
    [client],
  );

  // Re-query whenever filters change while ready.
  const isReady = phase === "ready";
  useEffect(() => {
    if (isReady) void runQuery(filters);
  }, [filters, isReady, runQuery]);

  const finishLoad = useCallback(
    async (startedAt: number) => {
      setLoadMs(Math.round(performance.now() - startedAt));
      setPhase("ready");
      await runQuery(EMPTY_FILTERS);
      setFilters(EMPTY_FILTERS);
    },
    [runQuery],
  );

  const loadSample = useCallback(async () => {
    setPhase("loading");
    setError(null);
    const t0 = performance.now();
    try {
      await client.loadSample((f) => setFiles((prev) => [...prev.filter((p) => p.id !== f.id), f]));
      await finishLoad(t0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase(files.length > 0 ? "ready" : "empty");
    }
  }, [client, files.length, finishLoad]);

  const addFiles = useCallback(
    async (dropped: File[]) => {
      if (dropped.length === 0) return;
      setPhase("loading");
      setError(null);
      const t0 = performance.now();
      try {
        for (const file of dropped) {
          await client.addFile(
            file,
            (p) => setProgress(p),
            (f) => setFiles((prev) => [...prev.filter((p) => p.id !== f.id), f]),
          );
        }
        setProgress(null);
        await finishLoad(t0);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setProgress(null);
        setPhase(files.length > 0 ? "ready" : "empty");
      }
    },
    [client, files.length, finishLoad],
  );

  /** Synchronous cache read; kicks off a page fetch when missing. */
  const rowAt = useCallback(
    (position: number): RowView | null => {
      const cached = rowCache.current.get(position);
      if (cached) return cached;
      const page = Math.floor(position / PAGE);
      if (!inFlight.current.has(page)) {
        inFlight.current.add(page);
        const epoch = queryEpoch.current;
        void client.rows(page * PAGE, (page + 1) * PAGE).then(({ start, rows }) => {
          if (epoch !== queryEpoch.current) return;
          rows.forEach((row, i) => rowCache.current.set(start + i, row));
          inFlight.current.delete(page);
          setCacheVersion((v) => v + 1);
        });
      }
      return null;
    },
    [client],
  );

  const detail = useCallback((rowId: number): Promise<DetailResult> => client.detail(rowId), [client]);

  const positionForTime = useCallback(
    (ms: number): Promise<number> => client.positionForTime(ms),
    [client],
  );

  const reset = useCallback(async () => {
    await client.reset();
    rowCache.current.clear();
    inFlight.current.clear();
    queryEpoch.current++;
    setFiles([]);
    setSnapshot(null);
    setFilters(EMPTY_FILTERS);
    setPhase("empty");
    setLoadMs(null);
  }, [client]);

  return {
    phase,
    files,
    progress,
    snapshot,
    filters,
    setFilters,
    error,
    loadMs,
    cacheVersion,
    loadSample,
    addFiles,
    rowAt,
    detail,
    positionForTime,
    reset,
  };
}

export type Engine = ReturnType<typeof useEngine>;
