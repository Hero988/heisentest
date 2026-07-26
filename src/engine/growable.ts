/** Growable typed arrays — capacity doubles, no per-row object overhead. */

type TypedArray = Float64Array | Uint32Array | Uint8Array | Int32Array;

class GrowableBase<T extends TypedArray> {
  protected buf: T;
  length = 0;

  constructor(
    private readonly make: (capacity: number) => T,
    initialCapacity = 1024,
  ) {
    this.buf = make(initialCapacity);
  }

  protected ensure(extra: number): void {
    if (this.length + extra <= this.buf.length) return;
    let capacity = this.buf.length * 2;
    while (capacity < this.length + extra) capacity *= 2;
    const next = this.make(capacity);
    next.set(this.buf as never);
    this.buf = next;
  }

  push(value: number): number {
    this.ensure(1);
    this.buf[this.length] = value;
    return this.length++;
  }

  get(i: number): number {
    return this.buf[i] as number;
  }

  set(i: number, value: number): void {
    this.buf[i] = value;
  }

  /** A view over the live region — invalidated by the next push. */
  view(): T {
    return this.buf.subarray(0, this.length) as T;
  }
}

export class GrowableF64 extends GrowableBase<Float64Array> {
  constructor(initialCapacity?: number) {
    super((c) => new Float64Array(c), initialCapacity);
  }
}
export class GrowableU32 extends GrowableBase<Uint32Array> {
  constructor(initialCapacity?: number) {
    super((c) => new Uint32Array(c), initialCapacity);
  }
}
export class GrowableI32 extends GrowableBase<Int32Array> {
  constructor(initialCapacity?: number) {
    super((c) => new Int32Array(c), initialCapacity);
  }
}
export class GrowableU8 extends GrowableBase<Uint8Array> {
  constructor(initialCapacity?: number) {
    super((c) => new Uint8Array(c), initialCapacity);
  }
}
