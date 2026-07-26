import { describe, expect, it } from "vitest";
import { sniffCsv, splitDelimited } from "../src/engine/csv";
import {
  applyCsvSpec,
  compilePatternFormat,
  fileSignature,
} from "../src/engine/custom";
import { Ingester } from "../src/engine/ingest";
import { Level } from "../src/engine/levels";
import { LogStore } from "../src/engine/store";
import { compileTimeFormat } from "../src/engine/strptime";

const enc = new TextEncoder();

describe("compileTimeFormat (strptime)", () => {
  it("parses the Java/logback comma-millis layout", () => {
    const f = compileTimeFormat("%Y-%m-%d %H:%M:%S,%L")!;
    expect(f.parse("2026-07-26 02:14:04,612")).toBe(Date.UTC(2026, 6, 26, 2, 14, 4, 612));
  });

  it("parses month names and 12-hour clocks", () => {
    const f = compileTimeFormat("%d %b %Y %I:%M %p")!;
    expect(f.parse("26 Jul 2026 02:14 PM")).toBe(Date.UTC(2026, 6, 26, 14, 14));
    expect(f.parse("26 Jul 2026 12:00 AM")).toBe(Date.UTC(2026, 6, 26, 0, 0));
  });

  it("applies zone offsets", () => {
    const f = compileTimeFormat("%Y-%m-%dT%H:%M:%S%z")!;
    expect(f.parse("2026-07-26T03:00:00+01:00")).toBe(Date.UTC(2026, 6, 26, 2, 0, 0));
    expect(f.parse("2026-07-26T02:00:00Z")).toBe(Date.UTC(2026, 6, 26, 2, 0, 0));
  });

  it("parses epoch seconds and milliseconds", () => {
    expect(compileTimeFormat("%s")!.parse("1753495200")).toBe(1_753_495_200_000);
    expect(compileTimeFormat("%Q")!.parse("1753495200123")).toBe(1_753_495_200_123);
  });

  it("is strict: mismatches return null", () => {
    const f = compileTimeFormat("%Y-%m-%d")!;
    expect(f.parse("26/07/2026")).toBeNull();
    expect(f.parse("")).toBeNull();
  });

  it("rejects unknown directives", () => {
    expect(compileTimeFormat("%K")).toBeNull();
  });
});

describe("compilePatternFormat", () => {
  it("parses a pipe-delimited invented format", () => {
    const compiled = compilePatternFormat({
      kind: "pattern",
      patterns: [
        String.raw`^(?<timestamp>\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}) \| (?<level>[A-Z]+) \| (?<service>\S+) \| (?<message>.*)$`,
      ],
      timestampFormats: ["%d.%m.%Y %H:%M:%S"],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const r = compiled.format.parse("26.07.2026 02:14:04 | ERR | pay | card declined");
    expect(r.matched).toBe(true);
    expect(r.ts).toBe(Date.UTC(2026, 6, 26, 2, 14, 4));
    expect(r.level).toBe(Level.Error); // ERR maps via built-in level table
    expect(r.service).toBe("pay");
    expect(r.message).toBe("card declined");
  });

  it("honours custom level token maps", () => {
    const compiled = compilePatternFormat({
      kind: "pattern",
      patterns: [String.raw`^(?<level>\w+): (?<message>.*)$`],
      levels: { error: ["boom"], warn: ["meh"] },
    });
    if (!compiled.ok) throw new Error(compiled.error);
    expect(compiled.format.parse("boom: it broke").level).toBe(Level.Error);
    expect(compiled.format.parse("meh: it wobbled").level).toBe(Level.Warn);
  });

  it("reports invalid regexes instead of throwing", () => {
    const compiled = compilePatternFormat({ kind: "pattern", patterns: ["([unclosed"] });
    expect(compiled.ok).toBe(false);
  });

  it("falls back to auto timestamp detection when no format given", () => {
    const compiled = compilePatternFormat({
      kind: "pattern",
      patterns: [String.raw`^(?<timestamp>\S+) (?<message>.*)$`],
    });
    if (!compiled.ok) throw new Error(compiled.error);
    const r = compiled.format.parse("2026-07-26T02:14:04.612Z hello");
    expect(r.ts).toBe(Date.UTC(2026, 6, 26, 2, 14, 4, 612));
  });
});

describe("Ingester with a pattern spec", () => {
  const WEIRD =
    "26.07.2026 02:14:04 | INF | api | started\n" +
    "26.07.2026 02:14:05 | ERR | pay | card declined\n" +
    "  detail: gateway said no\n" + // folds into the error row
    "26.07.2026 02:14:06 | INF | api | recovered\n";

  it("parses an invented format end to end, folding unmatched lines", () => {
    const store = new LogStore();
    const fileId = store.addFile("weird.log");
    const ing = new Ingester(store, fileId, {
      kind: "pattern",
      patterns: [
        String.raw`^(?<timestamp>\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}) \| (?<level>[A-Z]+) \| (?<service>\S+) \| (?<message>.*)$`,
      ],
      timestampFormats: ["%d.%m.%Y %H:%M:%S"],
      levels: { info: ["INF"], error: ["ERR"] },
    });
    ing.push(enc.encode(WEIRD));
    ing.end();

    expect(store.rowCount).toBe(3); // detail line folded
    const errors = store.getRows(store.filter({ levels: new Set([Level.Error]) }));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("card declined");
    expect(errors[0]!.service).toBe("pay");
    expect(errors[0]!.foldedLines).toBe(1);
    expect(store.fullText(errors[0]!.id)).toContain("gateway said no");
    // custom fields exposed in the detail view
    const fields = store.fields(errors[0]!.id)!;
    expect(fields["level"]).toBe("ERR");
  });

  it("auto-applies a saved spec via the signature lookup", () => {
    const store = new LogStore();
    const fileId = store.addFile("weird.log");
    const expectedSig = fileSignature(null, "26.07.2026 02:14:04 | INF | api | started");
    const ing = new Ingester(store, fileId, null, (sig) =>
      sig === expectedSig
        ? {
            kind: "pattern",
            patterns: [String.raw`^(?<timestamp>[\d.]+ [\d:]+) \| (?<level>\w+) \| (?<service>\S+) \| (?<message>.*)$`],
            timestampFormats: ["%d.%m.%Y %H:%M:%S"],
            levels: { error: ["ERR"], info: ["INF"] },
          }
        : null,
    );
    ing.push(enc.encode(WEIRD));
    ing.end();
    expect(ing.signature()).toBe(expectedSig);
    const errors = store.filter({ levels: new Set([Level.Error]) });
    expect(errors.length).toBe(1);
  });
});

describe("applyCsvSpec", () => {
  const text = "when,how bad,what\n2026-07-26 02:00:00,ERROR,oh no\n2026-07-26 02:00:01,INFO,fine\n";
  const dialect = sniffCsv(text)!;
  const samples = text
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((l) => splitDelimited(l, ","));

  it("maps user-chosen columns onto roles the inference could not name", () => {
    const { roles } = applyCsvSpec(
      { kind: "csv", time: "when", level: "how bad", message: "what" },
      dialect,
      samples,
    );
    expect(dialect.header[roles.time]).toBe("when");
    expect(dialect.header[roles.level]).toBe("how bad");
    expect(dialect.header[roles.message]).toBe("what");
  });

  it("supports explicit (none)", () => {
    const { roles } = applyCsvSpec({ kind: "csv", service: "(none)" }, dialect, samples);
    expect(roles.service).toBe(-1);
  });
});

describe("fileSignature", () => {
  it("keys CSV files by header and line files by digit-collapsed shape", () => {
    expect(fileSignature("a,b,c", "ignored")).toBe("csv:a,b,c");
    // Numbers collapse, so a re-export of the same log matches...
    const a = fileSignature(null, "2026-07-26 02:14:04 | INF | api started pid=91");
    const b = fileSignature(null, "2027-01-01 09:00:00 | INF | api started pid=4");
    expect(a).toBe(b);
    // ...but different first-line words are different shapes.
    const c = fileSignature(null, "totally different banner");
    expect(a).not.toBe(c);
  });
});
