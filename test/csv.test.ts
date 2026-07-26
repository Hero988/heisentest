import { describe, expect, it } from "vitest";
import {
  CsvRecordReader,
  inferColumnRoles,
  parseCsvRecord,
  sniffCsv,
  splitDelimited,
} from "../src/engine/csv";
import { Ingester } from "../src/engine/ingest";
import { Level } from "../src/engine/levels";
import { LogStore } from "../src/engine/store";

const enc = new TextEncoder();

/** Synthetic Vercel-log-export shape — same columns as the real thing. */
const VERCEL_HEADER =
  "TimeUTC,timestampInMs,requestPath,requestMethod,requestQueryString,responseStatusCode,requestId,requestUserAgent,level,environment,branch,vercelCache,type,function,host,deploymentDomain,deploymentId,durationMs,region,maxMemoryUsed,memorySize,message,projectId,traceId,sessionId,invocationId,instanceId,concurrency,workflowRunId,workflowStepId";

function vercelRow(opts: {
  time: string;
  ms: number;
  path: string;
  status: number;
  fn?: string;
  message?: string;
  level?: string;
}): string {
  const ua = '"Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3) AppleWebKit/605.1.15 (KHTML, like Gecko)"';
  return [
    opts.time,
    String(opts.ms),
    opts.path,
    "GET",
    "",
    String(opts.status),
    `req-${opts.ms}`,
    ua,
    opts.level ?? "",
    "production",
    "main",
    "HIT",
    "lambda",
    opts.fn ?? "middleware",
    "www.example.com",
    "example-abc.vercel.app",
    "dpl_XYZ",
    "71",
    "iad1",
    "264",
    "2048",
    opts.message ?? "",
    "prj_ABC",
    "",
    "",
    "inv1",
    "inst1",
    "1",
    "",
    "",
  ].join(",");
}

function vercelCsv(): string {
  const rows = [VERCEL_HEADER];
  for (let i = 0; i < 30; i++) {
    rows.push(
      vercelRow({
        time: `2026-07-26 16:${String(50 + Math.floor(i / 10)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
        ms: 1785084600000 + i * 1000,
        path: "www.example.com/",
        status: 200,
      }),
    );
  }
  rows.push(
    vercelRow({
      time: "2026-07-26 16:55:24",
      ms: 1785084924244,
      path: "www.example.com/api/pay",
      status: 502,
    }),
  );
  rows.push(
    vercelRow({
      time: "2026-07-26 16:55:30",
      ms: 1785084930000,
      path: "www.example.com/api/pay",
      status: 200,
      fn: "api/pay",
      level: "error",
      message: "Unhandled rejection: TypeError: x is undefined",
    }),
  );
  return rows.join("\n") + "\n";
}

describe("splitDelimited", () => {
  it("splits plain fields", () => {
    expect(splitDelimited("a,b,c", ",")).toEqual(["a", "b", "c"]);
  });
  it("honours quoted fields containing the delimiter", () => {
    expect(splitDelimited('a,"b,c",d', ",")).toEqual(["a", "b,c", "d"]);
  });
  it("unescapes doubled quotes", () => {
    expect(splitDelimited('a,"say ""hi""",c', ",")).toEqual(["a", 'say "hi"', "c"]);
  });
  it("keeps empty fields", () => {
    expect(splitDelimited("a,,c,", ",")).toEqual(["a", "", "c", ""]);
  });
});

describe("sniffCsv", () => {
  it("detects the Vercel export shape", () => {
    const d = sniffCsv(vercelCsv())!;
    expect(d).not.toBeNull();
    expect(d.delimiter).toBe(",");
    expect(d.header).toHaveLength(30);
    expect(d.header[0]).toBe("TimeUTC");
  });
  it("detects TSV", () => {
    const d = sniffCsv("time\tlevel\tmessage\n2026-07-26T02:00:00Z\tinfo\thello\n")!;
    expect(d).not.toBeNull();
    expect(d.delimiter).toBe("\t");
  });
  it("rejects JSON lines despite their commas", () => {
    expect(sniffCsv('{"a":1,"b":2}\n{"a":2,"b":3}\n')).toBeNull();
  });
  it("rejects ordinary log lines", () => {
    expect(
      sniffCsv("2026-07-26T02:00:00Z INFO service started, listening\n2026-07-26T02:00:01Z INFO ok\n"),
    ).toBeNull();
  });
});

describe("CsvRecordReader", () => {
  function collect(delimiter = ",") {
    const records: { raw: string; fields: string[] }[] = [];
    const reader = new CsvRecordReader(delimiter, {
      record: (raw, fields) => records.push({ raw, fields }),
    });
    return { records, reader };
  }

  it("reads records split across arbitrary chunk boundaries", () => {
    const { records, reader } = collect();
    const text = 'a,b,"c,d"\ne,f,g\n';
    for (const ch of text) reader.push(ch); // worst case: 1-byte chunks
    reader.end();
    expect(records).toHaveLength(2);
    expect(records[0]!.fields).toEqual(["a", "b", "c,d"]);
    expect(records[1]!.fields).toEqual(["e", "f", "g"]);
  });

  it("keeps newlines inside quoted fields", () => {
    const { records, reader } = collect();
    reader.push('id,note\n1,"line one\nline two"\n2,plain\n');
    reader.end();
    expect(records).toHaveLength(3); // header + 2 data
    expect(records[1]!.fields[1]).toBe("line one\nline two");
  });

  it("unescapes doubled quotes across chunk boundaries", () => {
    const { records, reader } = collect();
    reader.push('a,"he said ""');
    reader.push('hi"" ok",b\n');
    reader.end();
    expect(records[0]!.fields).toEqual(["a", 'he said "hi" ok', "b"]);
  });

  it("handles CRLF line endings", () => {
    const { records, reader } = collect();
    reader.push("a,b\r\nc,d\r\n");
    reader.end();
    expect(records).toHaveLength(2);
    expect(records[1]!.fields).toEqual(["c", "d"]);
  });
});

describe("inferColumnRoles on the Vercel shape", () => {
  const header = VERCEL_HEADER.split(",");
  const samples = vercelCsv()
    .split("\n")
    .slice(1, 21)
    .filter(Boolean)
    .map((l) => splitDelimited(l, ","));
  const roles = inferColumnRoles(header, samples);

  it("prefers the millisecond epoch column over the second-resolution string", () => {
    expect(header[roles.time]).toBe("timestampInMs");
  });
  it("finds status, message and service columns", () => {
    expect(header[roles.status]).toBe("responseStatusCode");
    expect(header[roles.message]).toBe("message");
    expect(header[roles.service]).toBe("function");
  });
  it("keeps the mostly-empty level column for later rows", () => {
    expect(header[roles.level]).toBe("level");
  });
});

describe("parseCsvRecord", () => {
  const header = VERCEL_HEADER.split(",");
  const samples = [splitDelimited(vercelRow({ time: "2026-07-26 16:50:00", ms: 1785084600000, path: "/", status: 200 }), ",")];
  const roles = inferColumnRoles(header, samples);

  it("derives ERROR from a 502 status when level is empty", () => {
    const fields = splitDelimited(
      vercelRow({ time: "2026-07-26 16:55:24", ms: 1785084924244, path: "/api/pay", status: 502 }),
      ",",
    );
    const p = parseCsvRecord(fields, roles);
    expect(p.level).toBe(Level.Error);
    expect(p.ts).toBe(1785084924244);
    expect(p.message).toContain("502");
    expect(p.message).toContain("/api/pay");
  });

  it("uses the explicit level and message when present", () => {
    const fields = splitDelimited(
      vercelRow({
        time: "2026-07-26 16:55:30",
        ms: 1785084930000,
        path: "/api/pay",
        status: 200,
        level: "error",
        message: "Unhandled rejection",
      }),
      ",",
    );
    const p = parseCsvRecord(fields, roles);
    expect(p.level).toBe(Level.Error);
    expect(p.message).toBe("Unhandled rejection");
  });
});

describe("Ingester routing", () => {
  it("ingests a Vercel-shaped CSV as structured rows", () => {
    const store = new LogStore();
    const fileId = store.addFile("export.csv");
    const ing = new Ingester(store, fileId);
    ing.push(enc.encode(vercelCsv()));
    ing.end();

    expect(store.rowCount).toBe(32); // header excluded
    const errors = store.filter({ levels: new Set([Level.Error]) });
    expect(errors.length).toBe(2); // the 502 and the explicit error row
    const rows = store.getRows(errors);
    expect(rows[0]!.ts).toBe(1785084924244); // ms precision from timestampInMs
    // detail view exposes every non-empty column by header name
    const fields = store.fields(rows[0]!.id)!;
    expect(fields["responseStatusCode"]).toBe("502");
    expect(fields["region"]).toBe("iad1");
  });

  it("ingests CSV pushed in tiny chunks identically", () => {
    const store = new LogStore();
    const fileId = store.addFile("export.csv");
    const ing = new Ingester(store, fileId);
    const bytes = enc.encode(vercelCsv());
    for (let i = 0; i < bytes.length; i += 7) {
      ing.push(bytes.subarray(i, Math.min(bytes.length, i + 7)));
    }
    ing.end();
    expect(store.rowCount).toBe(32);
  });

  it("still routes plain logs through line mode", () => {
    const store = new LogStore();
    const fileId = store.addFile("app.log");
    const ing = new Ingester(store, fileId);
    ing.push(enc.encode("2026-07-26T02:00:01Z INFO alpha, beta, gamma\n2026-07-26T02:00:02Z ERROR boom\n"));
    ing.end();
    expect(store.rowCount).toBe(2);
    expect(store.files[fileId]!.csv).toBeUndefined();
    const errors = store.filter({ levels: new Set([Level.Error]) });
    expect(errors.length).toBe(1);
  });
});
