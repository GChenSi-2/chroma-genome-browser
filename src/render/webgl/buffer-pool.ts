/**
 * Object pool for Float32Array / Int32Array.
 *
 * Why: render loop must not allocate. GC pauses kill 60fps.
 *
 * Usage:
 *   const pool = createFloat32Pool();
 *   const buf = pool.acquire(maxReads * 5);  // 5 floats per instance
 *   ...fill buf, upload to GPU...
 *   pool.release(buf);
 *
 * The pool rounds up to power-of-2 sizes to reduce fragmentation.
 */

type TypedArray =
  | Float32Array<ArrayBufferLike>
  | Int32Array<ArrayBufferLike>
  | Uint32Array<ArrayBufferLike>
  | Uint16Array<ArrayBufferLike>
  | Uint8Array<ArrayBufferLike>;
type TypedArrayCtor<T extends TypedArray> = {
  new (length: number): T;
  BYTES_PER_ELEMENT: number;
};

interface Pool<T extends TypedArray> {
  acquire: (minLength: number) => T;
  release: (buf: T) => void;
  stats: () => { allocated: number; available: number };
  clear: () => void;
}

function nextPow2(n: number): number {
  if (n <= 0) return 1;
  return 1 << Math.ceil(Math.log2(n));
}

function makePool<T extends TypedArray>(Ctor: TypedArrayCtor<T>): Pool<T> {
  // size -> available buffers of that exact size
  const free = new Map<number, T[]>();
  let allocated = 0;

  return {
    acquire(minLength: number): T {
      const size = nextPow2(minLength);
      const bucket = free.get(size);
      if (bucket && bucket.length > 0) {
        return bucket.pop()!;
      }
      allocated++;
      return new Ctor(size);
    },
    release(buf: T): void {
      const size = buf.length;
      let bucket = free.get(size);
      if (!bucket) {
        bucket = [];
        free.set(size, bucket);
      }
      // Cap each bucket to prevent unbounded growth
      if (bucket.length < 8) {
        bucket.push(buf);
      }
    },
    stats() {
      let available = 0;
      for (const bucket of free.values()) available += bucket.length;
      return { allocated, available };
    },
    clear() {
      free.clear();
    },
  };
}

// The `as unknown as ...` chain works around the constructor variance between
// the global TypedArray ctors (overloaded, default buffer = ArrayBuffer) and
// our internal `TypedArrayCtor<T>` shape (single new(length): T overload).
export const createFloat32Pool = (): Pool<Float32Array<ArrayBufferLike>> =>
  makePool<Float32Array<ArrayBufferLike>>(
    Float32Array as unknown as TypedArrayCtor<Float32Array<ArrayBufferLike>>,
  );
export const createInt32Pool = (): Pool<Int32Array<ArrayBufferLike>> =>
  makePool<Int32Array<ArrayBufferLike>>(
    Int32Array as unknown as TypedArrayCtor<Int32Array<ArrayBufferLike>>,
  );
export const createUint32Pool = (): Pool<Uint32Array<ArrayBufferLike>> =>
  makePool<Uint32Array<ArrayBufferLike>>(
    Uint32Array as unknown as TypedArrayCtor<Uint32Array<ArrayBufferLike>>,
  );
export const createUint16Pool = (): Pool<Uint16Array<ArrayBufferLike>> =>
  makePool<Uint16Array<ArrayBufferLike>>(
    Uint16Array as unknown as TypedArrayCtor<Uint16Array<ArrayBufferLike>>,
  );
export const createUint8Pool = (): Pool<Uint8Array<ArrayBufferLike>> =>
  makePool<Uint8Array<ArrayBufferLike>>(
    Uint8Array as unknown as TypedArrayCtor<Uint8Array<ArrayBufferLike>>,
  );

// Module-level singletons for renderers to share
export const float32Pool = createFloat32Pool();
export const uint16Pool = createUint16Pool();
export const uint8Pool = createUint8Pool();
