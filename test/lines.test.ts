import { describe, expect, it } from "vitest";
import { LineSplitter } from "../src/engine/lines";

function collect(): { lines: string[]; splitter: LineSplitter } {
  const lines: string[] = [];
  const splitter = new LineSplitter({ line: (_bytes, text) => lines.push(text) });
  return { lines, splitter };
}

const enc = new TextEncoder();

describe("LineSplitter", () => {
  it("splits simple newline-terminated lines", () => {
    const { lines, splitter } = collect();
    splitter.push(enc.encode("alpha\nbeta\ngamma\n"));
    splitter.end();
    expect(lines).toEqual(["alpha", "beta", "gamma"]);
  });

  it("stitches a line split across chunk boundaries", () => {
    const { lines, splitter } = collect();
    splitter.push(enc.encode("hel"));
    splitter.push(enc.encode("lo wor"));
    splitter.push(enc.encode("ld\nnext\n"));
    splitter.end();
    expect(lines).toEqual(["hello world", "next"]);
  });

  it("strips CRLF endings", () => {
    const { lines, splitter } = collect();
    splitter.push(enc.encode("one\r\ntwo\r\n"));
    splitter.end();
    expect(lines).toEqual(["one", "two"]);
  });

  it("handles CRLF split exactly between chunks", () => {
    const { lines, splitter } = collect();
    splitter.push(enc.encode("one\r"));
    splitter.push(enc.encode("\ntwo\n"));
    splitter.end();
    expect(lines).toEqual(["one", "two"]);
  });

  it("emits a trailing line without a final newline on end()", () => {
    const { lines, splitter } = collect();
    splitter.push(enc.encode("a\nb"));
    splitter.end();
    expect(lines).toEqual(["a", "b"]);
  });

  it("preserves empty lines", () => {
    const { lines, splitter } = collect();
    splitter.push(enc.encode("a\n\nb\n"));
    splitter.end();
    expect(lines).toEqual(["a", "", "b"]);
  });

  it("decodes UTF-8 split mid-codepoint across chunks", () => {
    const { lines, splitter } = collect();
    const bytes = enc.encode("café ok\n");
    splitter.push(bytes.subarray(0, 4)); // splits the 2-byte é
    splitter.push(bytes.subarray(4));
    splitter.end();
    expect(lines).toEqual(["café ok"]);
  });
});
