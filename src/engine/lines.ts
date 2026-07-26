/**
 * Streaming line splitter.
 *
 * Consumes arbitrary byte chunks (as delivered by File.stream()) and yields
 * complete lines as byte ranges into an internal, growing list of chunks.
 * A line that spans a chunk boundary is stitched without copying the whole
 * file: only the carried fragment is copied once.
 *
 * All downstream parsing works on decoded strings per line, but raw bytes
 * stay the source of truth so multi-GB files never need one giant string.
 */

const NL = 0x0a; // \n
const CR = 0x0d; // \r

export interface LineSink {
  /**
   * Called once per complete line (no trailing newline).
   * `bytes` is only valid during the call — copy it if you keep it.
   */
  line(bytes: Uint8Array, text: string): void;
}

export class LineSplitter {
  private carry: Uint8Array | null = null;
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });

  constructor(private readonly sink: LineSink) {}

  push(chunk: Uint8Array): void {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === NL) {
        let end = i;
        if (end > start && chunk[end - 1] === CR) end--;
        if (this.carry !== null) {
          const merged = concat(this.carry, chunk.subarray(start, end));
          this.carry = null;
          this.emit(merged);
        } else {
          this.emit(chunk.subarray(start, end));
        }
        start = i + 1;
      }
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.carry = this.carry === null ? rest.slice() : concat(this.carry, rest);
    }
  }

  /** Flush any trailing line that had no final newline. */
  end(): void {
    if (this.carry !== null && this.carry.length > 0) {
      let bytes = this.carry;
      if (bytes.length > 0 && bytes[bytes.length - 1] === CR) {
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      this.emit(bytes);
    }
    this.carry = null;
  }

  private emit(bytes: Uint8Array): void {
    // A trailing CR survives when a CRLF pair is split across two chunks
    // (the CR travels in the carry, the LF opens the next chunk).
    if (bytes.length > 0 && bytes[bytes.length - 1] === CR) {
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    this.sink.line(bytes, this.decoder.decode(bytes));
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
