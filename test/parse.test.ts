import { describe, expect, it } from "vitest";
import { Level } from "../src/engine/levels";
import {
  LineKind,
  accessFields,
  isContinuation,
  jsonFields,
  logfmtFields,
  parseAccessLog,
  parseGeneric,
  parseJsonLine,
  parseLine,
  parseLogfmt,
  parseSyslogLine,
} from "../src/engine/parse";

describe("parseJsonLine", () => {
  it("parses pino-style lines with numeric level and epoch millis", () => {
    const p = parseJsonLine('{"level":50,"time":1753495200123,"msg":"boom","name":"api"}');
    expect(p).not.toBeNull();
    expect(p!.kind).toBe(LineKind.Json);
    expect(p!.level).toBe(Level.Error);
    expect(p!.ts).toBe(1_753_495_200_123);
    expect(p!.message).toBe("boom");
    expect(p!.service).toBe("api");
  });

  it("parses winston/structured style with string level and ISO time", () => {
    const p = parseJsonLine(
      '{"timestamp":"2026-07-26T02:14:04.612Z","level":"warn","message":"slow query","service":"billing"}',
    );
    expect(p!.level).toBe(Level.Warn);
    expect(p!.ts).toBe(Date.UTC(2026, 6, 26, 2, 14, 4, 612));
    expect(p!.message).toBe("slow query");
    expect(p!.service).toBe("billing");
  });

  it("falls back to the raw line when no message key exists", () => {
    const raw = '{"a":1,"b":2}';
    const p = parseJsonLine(raw);
    expect(p!.message).toBe(raw);
    expect(p!.level).toBe(Level.Unknown);
  });

  it("rejects non-JSON and JSON arrays", () => {
    expect(parseJsonLine("not json")).toBeNull();
    expect(parseJsonLine("[1,2,3]")).toBeNull();
    expect(parseJsonLine("{broken")).toBeNull();
  });

  it("exposes the full field map on demand", () => {
    expect(jsonFields('{"a":1,"nested":{"b":2}}')).toEqual({ a: 1, nested: { b: 2 } });
    expect(jsonFields("nope")).toBeNull();
  });
});

describe("parseLogfmt", () => {
  it("parses heroku/go-kit style lines", () => {
    const p = parseLogfmt('ts=2026-07-26T02:14:04Z level=error msg="conn refused" service=worker');
    expect(p).not.toBeNull();
    expect(p!.kind).toBe(LineKind.Logfmt);
    expect(p!.level).toBe(Level.Error);
    expect(p!.ts).toBe(Date.UTC(2026, 6, 26, 2, 14, 4));
    expect(p!.message).toBe("conn refused");
    expect(p!.service).toBe("worker");
  });

  it("handles quoted values with escapes", () => {
    const fields = logfmtFields('msg="say \\"hi\\"" x=1');
    expect(fields["msg"]).toBe('say "hi"');
  });

  it("rejects prose that merely contains an equals sign", () => {
    expect(parseLogfmt("the answer is x=42")).toBeNull();
    expect(parseLogfmt("E = mc squared")).toBeNull();
  });
});

describe("parseAccessLog", () => {
  const line =
    '203.0.113.7 - alice [26/Jul/2026:02:14:04 +0000] "GET /api/checkout HTTP/1.1" 502 552 "-" "Mozilla/5.0"';

  it("parses combined log format", () => {
    const p = parseAccessLog(line);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe(LineKind.Access);
    expect(p!.ts).toBe(Date.UTC(2026, 6, 26, 2, 14, 4));
    expect(p!.level).toBe(Level.Error); // 5xx
    expect(p!.message).toBe("502 GET /api/checkout");
  });

  it("maps 4xx to WARN and 2xx to INFO", () => {
    expect(parseAccessLog(line.replace(" 502 ", " 404 "))!.level).toBe(Level.Warn);
    expect(parseAccessLog(line.replace(" 502 ", " 200 "))!.level).toBe(Level.Info);
  });

  it("exposes structured fields on demand", () => {
    const f = accessFields(line)!;
    expect(f["method"]).toBe("GET");
    expect(f["path"]).toBe("/api/checkout");
    expect(f["status"]).toBe("502");
    expect(f["remote"]).toBe("203.0.113.7");
  });

  it("rejects non-access lines", () => {
    expect(parseAccessLog("hello world")).toBeNull();
  });
});

describe("parseSyslogLine", () => {
  it("parses classic syslog with process and pid", () => {
    const p = parseSyslogLine("Jul 26 02:14:04 host1 sshd[812]: Accepted publickey for root", 2026);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe(LineKind.Syslog);
    expect(p!.ts).toBe(Date.UTC(2026, 6, 26, 2, 14, 4));
    expect(p!.service).toBe("sshd");
    expect(p!.message).toBe("Accepted publickey for root");
    expect(p!.level).toBe(Level.Info);
  });

  it("detects level words inside the body", () => {
    const p = parseSyslogLine("Jul 26 02:14:04 host1 kernel: ERROR disk failure on sda", 2026);
    expect(p!.level).toBe(Level.Error);
  });

  it("rejects non-syslog lines", () => {
    expect(parseSyslogLine("2026-07-26 boom", 2026)).toBeNull();
  });
});

describe("parseGeneric", () => {
  it("parses Java/logback style with logger name", () => {
    const p = parseGeneric("2026-07-26 02:14:04,612 ERROR com.shop.CartService - oom imminent");
    expect(p.kind).toBe(LineKind.Generic);
    expect(p.ts).toBe(Date.UTC(2026, 6, 26, 2, 14, 4, 612));
    expect(p.level).toBe(Level.Error);
    expect(p.service).toBe("com.shop.CartService");
  });

  it("parses bracketed level and service forms", () => {
    const p = parseGeneric("2026-07-26T02:14:04Z [worker-7] WARNING queue depth 12000");
    expect(p.level).toBe(Level.Warn);
    expect(p.service).toBe("worker-7");
  });

  it("does not mistake a bracketed level for a service", () => {
    const p = parseGeneric("2026-07-26T02:14:04Z [ERROR] it broke");
    expect(p.level).toBe(Level.Error);
    expect(p.service).toBeNull();
  });

  it("classifies pure prose as Raw with no timestamp", () => {
    const p = parseGeneric("Server listening on port 3000");
    expect(p.kind).toBe(LineKind.Raw);
    expect(p.ts).toBeNull();
    expect(p.level).toBe(Level.Unknown);
  });
});

describe("isContinuation", () => {
  it("recognizes stack trace shapes", () => {
    expect(isContinuation("\tat com.shop.CartSerializer.write(CartSerializer.java:141)")).toBe(true);
    expect(isContinuation("    at Object.<anonymous> (/app/index.js:10:15)")).toBe(true);
    expect(isContinuation("Caused by: java.io.IOException: closed")).toBe(true);
    expect(isContinuation("... 12 more")).toBe(true);
    expect(isContinuation("Traceback (most recent call last):")).toBe(true);
    expect(isContinuation("  File \"app.py\", line 3, in <module>")).toBe(true);
    expect(isContinuation("goroutine 17 [running]:")).toBe(true);
    expect(isContinuation("")).toBe(true);
  });

  it("does not flag normal lines", () => {
    expect(isContinuation("2026-07-26T02:14:04Z INFO ok")).toBe(false);
    expect(isContinuation('{"level":30,"msg":"ok"}')).toBe(false);
  });
});

describe("parseLine dispatcher", () => {
  it("routes each family to its parser", () => {
    expect(parseLine('{"level":30,"msg":"ok"}').kind).toBe(LineKind.Json);
    expect(
      parseLine('1.2.3.4 - - [26/Jul/2026:02:14:04 +0000] "GET / HTTP/1.1" 200 5 "-" "-"').kind,
    ).toBe(LineKind.Access);
    expect(parseLine("Jul 26 02:14:04 host1 cron[1]: job done", 2026).kind).toBe(LineKind.Syslog);
    expect(parseLine("ts=2026-07-26T02:14:04Z level=info msg=ok").kind).toBe(LineKind.Logfmt);
    expect(parseLine("2026-07-26T02:14:04Z INFO ok").kind).toBe(LineKind.Generic);
    expect(parseLine("hello").kind).toBe(LineKind.Raw);
  });

  it("prefers generic over logfmt when only generic finds the timestamp", () => {
    const p = parseLine("2026-07-26 02:14:04 INFO reconfigured retries=3");
    expect(p.ts).not.toBeNull();
    expect(p.level).toBe(Level.Info);
  });
});
