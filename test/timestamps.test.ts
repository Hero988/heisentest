import { describe, expect, it } from "vitest";
import { findTimestamp, parseFieldTimestamp } from "../src/engine/timestamps";

describe("findTimestamp", () => {
  it("parses ISO 8601 with millis and Z", () => {
    const m = findTimestamp("2026-07-26T02:14:04.612Z ERROR boom");
    expect(m).not.toBeNull();
    expect(m!.ts).toBe(Date.UTC(2026, 6, 26, 2, 14, 4, 612));
  });

  it("parses the Java/Python comma-millis space-separated form", () => {
    const m = findTimestamp("2026-07-26 02:14:04,612 ERROR boom");
    expect(m!.ts).toBe(Date.UTC(2026, 6, 26, 2, 14, 4, 612));
  });

  it("applies numeric zone offsets", () => {
    const plain = findTimestamp("2026-07-26T02:00:00Z x")!.ts;
    const offset = findTimestamp("2026-07-26T03:00:00+01:00 x")!.ts;
    expect(offset).toBe(plain);
  });

  it("parses slash-separated dates (Go default layout)", () => {
    const m = findTimestamp("2026/07/26 02:14:04 boom");
    expect(m!.ts).toBe(Date.UTC(2026, 6, 26, 2, 14, 4));
  });

  it("parses nginx/apache CLF brackets with zone", () => {
    const m = findTimestamp('26/Jul/2026:02:14:04 +0000');
    expect(m!.ts).toBe(Date.UTC(2026, 6, 26, 2, 14, 4));
    const shifted = findTimestamp('26/Jul/2026:03:14:04 +0100');
    expect(shifted!.ts).toBe(Date.UTC(2026, 6, 26, 2, 14, 4));
  });

  it("parses classic syslog with a supplied reference year", () => {
    const m = findTimestamp("Jul 26 02:14:04 host1 sshd[812]: hello", 2026);
    expect(m!.ts).toBe(Date.UTC(2026, 6, 26, 2, 14, 4));
  });

  it("parses syslog single-digit day with double space", () => {
    const m = findTimestamp("Jul  6 02:14:04 host1 x", 2026);
    expect(m!.ts).toBe(Date.UTC(2026, 6, 6, 2, 14, 4));
  });

  it("parses epoch seconds and milliseconds at line start", () => {
    expect(findTimestamp("1753495200 boot ok")!.ts).toBe(1_753_495_200_000);
    expect(findTimestamp("1753495200123 boot ok")!.ts).toBe(1_753_495_200_123);
    expect(findTimestamp("1753495200.500 boot ok")!.ts).toBe(1_753_495_200_500);
  });

  it("returns null for lines without a timestamp", () => {
    expect(findTimestamp("just some text")).toBeNull();
    expect(findTimestamp("")).toBeNull();
  });

  it("does not treat short numbers as epochs", () => {
    expect(findTimestamp("12345 not a timestamp")).toBeNull();
  });
});

describe("parseFieldTimestamp", () => {
  it("handles ISO strings, epoch seconds and epoch millis", () => {
    expect(parseFieldTimestamp("2026-07-26T02:14:04.612Z")).toBe(
      Date.UTC(2026, 6, 26, 2, 14, 4, 612),
    );
    expect(parseFieldTimestamp(1_753_495_200)).toBe(1_753_495_200_000);
    expect(parseFieldTimestamp(1_753_495_200_123)).toBe(1_753_495_200_123);
    expect(parseFieldTimestamp("1753495200123")).toBe(1_753_495_200_123);
  });

  it("rejects junk", () => {
    expect(parseFieldTimestamp("soon")).toBeNull();
    expect(parseFieldTimestamp(42)).toBeNull();
    expect(parseFieldTimestamp(null)).toBeNull();
  });
});
