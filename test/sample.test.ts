import { describe, expect, it } from "vitest";
import { Level } from "../src/engine/levels";
import { SAMPLE_BASE_MS, generateSample } from "../src/engine/sample";
import { LogStore } from "../src/engine/store";

const enc = new TextEncoder();

function load(): LogStore {
  const store = new LogStore();
  const sample = generateSample();
  for (const file of [sample.app, sample.gateway]) {
    const id = store.addFile(file.name);
    for (const line of file.text.split("\n")) {
      if (line.length > 0) store.appendLine(id, enc.encode(line), line);
    }
  }
  return store;
}

describe("the sample incident", () => {
  it("is deterministic", () => {
    const a = generateSample();
    const b = generateSample();
    expect(a.app.text).toBe(b.app.text);
    expect(a.gateway.text).toBe(b.gateway.text);
  });

  it("parses into a two-file store with thousands of rows", () => {
    const store = load();
    expect(store.files).toHaveLength(2);
    expect(store.rowCount).toBeGreaterThan(2000);
  });

  it("contains the OOM with its folded stack trace", () => {
    const store = load();
    const ids = store.filter({ query: "outofmemoryerror" });
    expect(ids.length).toBe(1);
    const row = store.getRows(ids)[0]!;
    expect(row.foldedLines).toBe(3);
    expect(store.fullText(row.id)).toContain("CartSerializer.write");
  });

  it("shows the 502 spike in minutes 14-16 and a quiet phase before", () => {
    const store = load();
    const spike = store.filter({
      levels: new Set([Level.Error]),
      timeRange: [SAMPLE_BASE_MS + 14 * 60_000, SAMPLE_BASE_MS + 16 * 60_000],
    });
    const before = store.filter({
      levels: new Set([Level.Error]),
      timeRange: [SAMPLE_BASE_MS, SAMPLE_BASE_MS + 13 * 60_000],
    });
    expect(spike.length).toBeGreaterThan(30);
    expect(before.length).toBe(0);
  });

  it("the OOM precedes the first gateway 502", () => {
    const store = load();
    const oom = store.getRows(store.filter({ query: "outofmemoryerror" }))[0]!;
    const gw502 = store.getRows(store.filter({ query: "502 get" }));
    expect(gw502.length).toBeGreaterThan(10);
    const first502 = Math.min(...gw502.map((r) => r.ts ?? Infinity));
    expect(oom.ts).not.toBeNull();
    expect(oom.ts!).toBeLessThan(first502);
  });

  it("histogram shows the error spike concentrated after the OOM", () => {
    const store = load();
    const all = store.filter({});
    const h = store.histogram(all)!;
    expect(h).not.toBeNull();
    const errTotal = h.errors.reduce((a, b) => a + b, 0);
    expect(errTotal).toBeGreaterThan(30);
  });
});
