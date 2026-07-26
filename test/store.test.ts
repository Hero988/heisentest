import { describe, expect, it } from "vitest";
import { Level } from "../src/engine/levels";
import { LogStore, containsFoldedCase } from "../src/engine/store";

const enc = new TextEncoder();

function feed(store: LogStore, fileId: number, lines: string[], referenceYear = 2026): void {
  for (const line of lines) {
    store.appendLine(fileId, enc.encode(line), line, referenceYear);
  }
}

describe("LogStore basics", () => {
  it("stores rows and materializes them in order", () => {
    const store = new LogStore();
    const f = store.addFile("app.log");
    feed(store, f, [
      "2026-07-26T02:00:01Z INFO first",
      "2026-07-26T02:00:02Z ERROR second",
    ]);
    expect(store.rowCount).toBe(2);
    const rows = store.getRows(store.order());
    expect(rows[0]!.message).toContain("first");
    expect(rows[1]!.level).toBe(Level.Error);
    expect(rows[1]!.ts).toBe(Date.UTC(2026, 6, 26, 2, 0, 2));
    expect(rows[0]!.lineNo).toBe(1);
    expect(rows[1]!.lineNo).toBe(2);
  });

  it("folds stack traces into their opening row", () => {
    const store = new LogStore();
    const f = store.addFile("app.log");
    feed(store, f, [
      "2026-07-26T02:00:01Z ERROR java.lang.OutOfMemoryError: Java heap space",
      "\tat com.shop.CartSerializer.write(CartSerializer.java:141)",
      "\tat com.shop.CheckoutHandler.handle(CheckoutHandler.java:52)",
      "Caused by: java.io.IOException: closed",
      "2026-07-26T02:00:03Z INFO recovered",
    ]);
    expect(store.rowCount).toBe(2);
    const rows = store.getRows(store.order());
    expect(rows[0]!.foldedLines).toBe(3);
    const full = store.fullText(rows[0]!.id);
    expect(full).toContain("OutOfMemoryError");
    expect(full).toContain("CartSerializer.write");
    expect(full).toContain("Caused by");
    // display message stays the first line
    expect(rows[0]!.message).not.toContain("\n");
  });

  it("keeps untimestamped rows and orders them with their neighbours", () => {
    const store = new LogStore();
    const f = store.addFile("app.log");
    feed(store, f, [
      "Server starting", // no ts, before any timestamp
      "2026-07-26T02:00:01Z INFO up",
      "plain progress line without timestamp",
      "2026-07-26T02:00:05Z INFO done",
    ]);
    const msgs = store.getRows(store.order()).map((r) => r.message);
    expect(msgs[0]).toBe("Server starting");
    expect(msgs[1]).toContain("INFO up");
    expect(msgs[2]).toBe("plain progress line without timestamp");
    expect(msgs[3]).toContain("INFO done");
  });
});

describe("LogStore multi-file merge", () => {
  it("interleaves two files by timestamp", () => {
    const store = new LogStore();
    const a = store.addFile("a.log");
    const b = store.addFile("b.log");
    feed(store, a, ["2026-07-26T02:00:01Z INFO a1", "2026-07-26T02:00:04Z INFO a2"]);
    feed(store, b, ["2026-07-26T02:00:02Z INFO b1", "2026-07-26T02:00:03Z INFO b2"]);
    const rows = store.getRows(store.order());
    expect(rows.map((r) => r.message.slice(-2))).toEqual(["a1", "b1", "b2", "a2"]);
    expect(rows.map((r) => r.file)).toEqual(["a.log", "b.log", "b.log", "a.log"]);
  });

  it("clamps backwards timestamps monotone for ordering but preserves display ts", () => {
    const store = new LogStore();
    const f = store.addFile("a.log");
    feed(store, f, [
      "2026-07-26T02:00:05Z INFO five",
      "2026-07-26T02:00:03Z INFO three-late", // out of order in the file
      "2026-07-26T02:00:06Z INFO six",
    ]);
    const rows = store.getRows(store.order());
    // File order preserved (single file), display ts untouched.
    expect(rows.map((r) => r.message.split(" ").at(-1))).toEqual(["five", "three-late", "six"]);
    expect(rows[1]!.ts).toBe(Date.UTC(2026, 6, 26, 2, 0, 3));
  });
});

describe("LogStore filtering", () => {
  function build(): LogStore {
    const store = new LogStore();
    const f = store.addFile("app.log");
    feed(store, f, [
      "2026-07-26T02:00:01Z INFO alpha service started",
      "2026-07-26T02:00:02Z WARN beta queue deep",
      "2026-07-26T02:00:03Z ERROR gamma OutOfMemoryError",
      "2026-07-26T02:00:04Z INFO delta all clear",
    ]);
    return store;
  }

  it("filters by level", () => {
    const store = build();
    const ids = store.filter({ levels: new Set([Level.Error]) });
    expect(ids.length).toBe(1);
    expect(store.getRows(ids)[0]!.message).toContain("gamma");
  });

  it("filters by case-insensitive substring", () => {
    const store = build();
    const ids = store.filter({ query: "outofmemory" });
    expect(ids.length).toBe(1);
    const none = store.filter({ query: "zzz-not-there" });
    expect(none.length).toBe(0);
  });

  it("filters by time range", () => {
    const store = build();
    const ids = store.filter({
      timeRange: [Date.UTC(2026, 6, 26, 2, 0, 2), Date.UTC(2026, 6, 26, 2, 0, 3)],
    });
    const msgs = store.getRows(ids).map((r) => r.message);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain("beta");
    expect(msgs[1]).toContain("gamma");
  });

  it("combines query and level filters", () => {
    const store = build();
    const ids = store.filter({ query: "e", levels: new Set([Level.Info]) });
    expect(ids.length).toBe(2);
  });

  it("searches inside folded continuation lines", () => {
    const store = new LogStore();
    const f = store.addFile("app.log");
    feed(store, f, [
      "2026-07-26T02:00:01Z ERROR boom",
      "\tat com.shop.CartSerializer.write(CartSerializer.java:141)",
    ]);
    const ids = store.filter({ query: "cartserializer" });
    expect(ids.length).toBe(1);
  });
});

describe("LogStore histogram", () => {
  it("buckets totals, errors and warns", () => {
    const store = new LogStore();
    const f = store.addFile("app.log");
    feed(store, f, [
      "2026-07-26T02:00:01Z INFO a",
      "2026-07-26T02:00:30Z ERROR b",
      "2026-07-26T02:01:10Z WARN c",
      "2026-07-26T02:02:50Z INFO d",
    ]);
    const ids = store.filter({});
    const h = store.histogram(ids)!;
    expect(h).not.toBeNull();
    expect(h.bucketMs).toBe(5000); // ~170s span at ≤120 buckets → 5s buckets
    const sum = h.total.reduce((a, b) => a + b, 0);
    expect(sum).toBe(4);
    expect(h.errors.reduce((a, b) => a + b, 0)).toBe(1);
    expect(h.warns.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("returns null when no row has a timestamp", () => {
    const store = new LogStore();
    const f = store.addFile("app.log");
    feed(store, f, ["no timestamps here", "none here either"]);
    const h = store.histogram(store.filter({}));
    expect(h).toBeNull();
  });
});

describe("positionForTime", () => {
  it("finds the first row at or after a time", () => {
    const store = new LogStore();
    const f = store.addFile("app.log");
    feed(store, f, [
      "2026-07-26T02:00:01Z INFO a",
      "2026-07-26T02:00:05Z INFO b",
      "2026-07-26T02:00:09Z INFO c",
    ]);
    const order = store.order();
    expect(store.positionForTime(order, Date.UTC(2026, 6, 26, 2, 0, 5))).toBe(1);
    expect(store.positionForTime(order, Date.UTC(2026, 6, 26, 2, 0, 6))).toBe(2);
    expect(store.positionForTime(order, 0)).toBe(0);
  });
});

describe("containsFoldedCase", () => {
  it("matches case-insensitively over ASCII", () => {
    const hay = enc.encode("Hello OutOfMemoryError world");
    expect(containsFoldedCase(hay, enc.encode("outofmemory"))).toBe(true);
    expect(containsFoldedCase(hay, enc.encode("WORLD"))).toBe(false); // needle must be lowercase
    expect(containsFoldedCase(hay, enc.encode("world"))).toBe(true);
    expect(containsFoldedCase(hay, enc.encode("absent"))).toBe(false);
    expect(containsFoldedCase(hay, enc.encode(""))).toBe(true);
  });
});
