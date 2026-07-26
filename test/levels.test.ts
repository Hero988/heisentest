import { describe, expect, it } from "vitest";
import { Level, levelFromNumber, levelFromText, levelName } from "../src/engine/levels";

describe("levelFromText", () => {
  it("maps canonical names", () => {
    expect(levelFromText("ERROR")).toBe(Level.Error);
    expect(levelFromText("warn")).toBe(Level.Warn);
    expect(levelFromText("Info")).toBe(Level.Info);
    expect(levelFromText("DEBUG")).toBe(Level.Debug);
    expect(levelFromText("trace")).toBe(Level.Trace);
  });

  it("maps ecosystem variants onto the canonical five", () => {
    expect(levelFromText("fatal")).toBe(Level.Error);
    expect(levelFromText("SEVERE")).toBe(Level.Error); // java.util.logging
    expect(levelFromText("emerg")).toBe(Level.Error); // syslog
    expect(levelFromText("panic")).toBe(Level.Error); // go
    expect(levelFromText("warning")).toBe(Level.Warn);
    expect(levelFromText("notice")).toBe(Level.Info); // syslog
    expect(levelFromText("fine")).toBe(Level.Debug);
    expect(levelFromText("verbose")).toBe(Level.Trace);
    expect(levelFromText("E")).toBe(Level.Error); // logcat
  });

  it("returns Unknown for prose", () => {
    expect(levelFromText("hello")).toBe(Level.Unknown);
    expect(levelFromText("")).toBe(Level.Unknown);
  });
});

describe("levelFromNumber (pino/bunyan)", () => {
  it("maps the numeric ladder", () => {
    expect(levelFromNumber(60)).toBe(Level.Error); // fatal
    expect(levelFromNumber(50)).toBe(Level.Error);
    expect(levelFromNumber(40)).toBe(Level.Warn);
    expect(levelFromNumber(30)).toBe(Level.Info);
    expect(levelFromNumber(20)).toBe(Level.Debug);
    expect(levelFromNumber(10)).toBe(Level.Trace);
  });
});

describe("levelName", () => {
  it("round-trips display names", () => {
    expect(levelName(Level.Error)).toBe("ERROR");
    expect(levelName(Level.Unknown)).toBe("—");
  });
});
