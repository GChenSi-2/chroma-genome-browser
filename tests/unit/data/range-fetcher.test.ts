/**
 * RangeFetcher unit tests.
 *
 * Default vitest environment is happy-dom (see vitest.config.ts). Happy-dom
 * does not expose the Cache API, so cache-related tests install a tiny
 * in-memory polyfill on globalThis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRangeFetcher } from '~data/network/range-fetcher';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory Cache API polyfill
// ─────────────────────────────────────────────────────────────────────────────

interface FakeCache {
  match(req: string | Request): Promise<Response | undefined>;
  put(req: string | Request, resp: Response): Promise<void>;
  keys(): Promise<Request[]>;
}

interface FakeCacheStorage {
  open(name: string): Promise<FakeCache>;
  _reset(): void;
}

function installFakeCaches(): FakeCacheStorage {
  const stores = new Map<string, Map<string, { body: ArrayBuffer }>>();
  const storage: FakeCacheStorage = {
    open(name) {
      let s = stores.get(name);
      if (!s) {
        s = new Map();
        stores.set(name, s);
      }
      const store = s;
      const cache: FakeCache = {
        async match(reqIn) {
          const url = typeof reqIn === 'string' ? reqIn : reqIn.url;
          const entry = store.get(url);
          if (!entry) return undefined;
          // Return a fresh Response each match to mimic real Cache semantics.
          return new Response(entry.body.slice(0));
        },
        async put(reqIn, resp) {
          const url = typeof reqIn === 'string' ? reqIn : reqIn.url;
          const body = await resp.arrayBuffer();
          store.set(url, { body });
        },
        async keys() {
          return [...store.keys()].map((u) => new Request(u));
        },
      };
      return Promise.resolve(cache);
    },
    _reset() {
      stores.clear();
    },
  };
  (globalThis as unknown as { caches: FakeCacheStorage }).caches = storage;
  return storage;
}

function removeFakeCaches(): void {
  delete (globalThis as { caches?: unknown }).caches;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeBuffer(len: number, fillStart: number): ArrayBuffer {
  const buf = new Uint8Array(len);
  for (let i = 0; i < len; i++) buf[i] = (fillStart + i) & 0xff;
  return buf.buffer;
}

function parseRange(headers: HeadersInit | undefined): { start: number; end: number } {
  const h = new Headers(headers);
  const r = h.get('Range') ?? h.get('range');
  if (!r) throw new Error('No Range header');
  const m = /bytes=(\d+)-(\d+)/.exec(r);
  if (!m) throw new Error('Bad Range header: ' + r);
  const s = m[1];
  const e = m[2];
  if (!s || !e) throw new Error('Bad Range header: ' + r);
  // Convert HTTP inclusive end → exclusive end-of-slice.
  return { start: Number(s), end: Number(e) + 1 };
}

function bytesOf(buf: ArrayBuffer): number[] {
  return Array.from(new Uint8Array(buf));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('createRangeFetcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    removeFakeCaches();
  });

  it('coalesces two adjacent requests within window into one underlying fetch', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const { start, end } = parseRange(init?.headers);
      return new Response(makeBuffer(end - start, start));
    }) as unknown as typeof fetch;

    const f = createRangeFetcher({
      coalesceWindowMs: 50,
      coalesceMaxGapBytes: 1024,
      fetchImpl,
      cacheName: undefined,
    });

    const p1 = f.fetch({ url: 'https://x/y.bam', start: 0, end: 100 });
    const p2 = f.fetch({ url: 'https://x/y.bam', start: 110, end: 200 });

    // Drive past the coalesce window.
    await vi.advanceTimersByTimeAsync(60);

    const [b1, b2] = await Promise.all([p1, p2]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const lastCall = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(lastCall).toBeDefined();
    expect(b1.byteLength).toBe(100);
    expect(b2.byteLength).toBe(90);
    // Slices should start with their respective range offsets.
    expect(bytesOf(b1)[0]).toBe(0);
    expect(bytesOf(b2)[0]).toBe(110 & 0xff);

    expect(f.stats().coalesced).toBe(1);
  });

  it('does NOT coalesce requests separated by a gap larger than coalesceMaxGapBytes', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const { start, end } = parseRange(init?.headers);
      return new Response(makeBuffer(end - start, start));
    }) as unknown as typeof fetch;

    const f = createRangeFetcher({
      coalesceWindowMs: 50,
      coalesceMaxGapBytes: 100,
      fetchImpl,
      cacheName: undefined,
    });

    const p1 = f.fetch({ url: 'https://x/y.bam', start: 0, end: 100 });
    const p2 = f.fetch({ url: 'https://x/y.bam', start: 10_000, end: 10_100 });

    await vi.advanceTimersByTimeAsync(80);
    await Promise.all([p1, p2]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('serves a direct cache hit without going to the network', async () => {
    installFakeCaches();
    const cached = makeBuffer(64, 7);
    // Pre-populate the cache via the helper structure used by RangeFetcher.
    const caches = (globalThis as unknown as { caches: FakeCacheStorage }).caches;
    const cache = await caches.open('chroma-range-v1');
    await cache.put(
      'https://x/y.bam#bytes=100-164',
      new Response(cached.slice(0)),
    );

    const fetchImpl = vi.fn(async () => new Response(new ArrayBuffer(0))) as unknown as typeof fetch;

    const f = createRangeFetcher({ fetchImpl });
    const buf = await f.fetch({ url: 'https://x/y.bam', start: 100, end: 164 });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(bytesOf(buf)).toEqual(bytesOf(cached));
    expect(f.stats().cacheHits).toBe(1);
    expect(f.stats().cacheMisses).toBe(0);
  });

  it('serves a cache hit when an enclosing range is cached', async () => {
    installFakeCaches();
    const big = makeBuffer(1000, 0); // bytes 1000..1999 → value (1000+i)&0xff
    const caches = (globalThis as unknown as { caches: FakeCacheStorage }).caches;
    const cache = await caches.open('chroma-range-v1');
    await cache.put(
      'https://x/y.bam#bytes=1000-2000',
      new Response(big.slice(0)),
    );

    const fetchImpl = vi.fn(async () => new Response(new ArrayBuffer(0))) as unknown as typeof fetch;

    const f = createRangeFetcher({ fetchImpl });
    const buf = await f.fetch({ url: 'https://x/y.bam', start: 1500, end: 1600 });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(buf.byteLength).toBe(100);
    // First byte should be (1500 - 1000)&0xff = 244.
    expect(bytesOf(buf)[0]).toBe(500 & 0xff);
    expect(f.stats().cacheHits).toBe(1);
  });

  it('aborting caller A does not affect coalesced caller B', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const { start, end } = parseRange(init?.headers);
      return new Response(makeBuffer(end - start, start));
    }) as unknown as typeof fetch;

    const f = createRangeFetcher({
      coalesceWindowMs: 50,
      coalesceMaxGapBytes: 1024,
      fetchImpl,
      cacheName: undefined,
    });

    const ac = new AbortController();
    const p1 = f.fetch({ url: 'https://x/y.bam', start: 0, end: 100, signal: ac.signal });
    const p2 = f.fetch({ url: 'https://x/y.bam', start: 100, end: 200 });
    // Attach a rejection handler synchronously so Node doesn't flag it as
    // unhandled while we wait for timers.
    const p1Settled = p1.catch((e) => e);

    ac.abort();
    await vi.advanceTimersByTimeAsync(80);

    const p1Err = await p1Settled;
    expect((p1Err as { name?: string }).name).toBe('AbortError');
    const b2 = await p2;
    expect(b2.byteLength).toBe(100);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on HTTP 500 up to 3 times then succeeds', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls++;
      if (calls === 1) return new Response('boom', { status: 500 });
      const { start, end } = parseRange(init?.headers);
      return new Response(makeBuffer(end - start, start));
    }) as unknown as typeof fetch;

    const f = createRangeFetcher({
      coalesceWindowMs: 10,
      fetchImpl,
      cacheName: undefined,
    });
    const p = f.fetch({ url: 'https://x/y.bam', start: 0, end: 50 });
    // Advance past coalesce window, then past the first retry backoff (200ms).
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(250);
    const buf = await p;
    expect(buf.byteLength).toBe(50);
    expect(calls).toBe(2);
  });

  it('does NOT retry on HTTP 404 and rejects immediately', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;

    const f = createRangeFetcher({
      coalesceWindowMs: 10,
      fetchImpl,
      cacheName: undefined,
    });

    const p = f.fetch({ url: 'https://x/y.bam', start: 0, end: 50 });
    const settled = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(20);
    const err = await settled;
    expect(String((err as Error).message)).toMatch(/404/);
    expect(calls).toBe(1);
  });

  it('stats() reflects coalesce, cache hit, and cache miss counters', async () => {
    installFakeCaches();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const { start, end } = parseRange(init?.headers);
      return new Response(makeBuffer(end - start, start));
    }) as unknown as typeof fetch;

    const f = createRangeFetcher({
      coalesceWindowMs: 30,
      coalesceMaxGapBytes: 1024,
      fetchImpl,
    });

    // First call: cache miss, network.
    const p1 = f.fetch({ url: 'https://x/y.bam', start: 0, end: 100 });
    const p2 = f.fetch({ url: 'https://x/y.bam', start: 110, end: 200 });
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([p1, p2]);

    // Second call: cache hit for one of the cached ranges.
    const p3 = f.fetch({ url: 'https://x/y.bam', start: 0, end: 100 });
    await vi.advanceTimersByTimeAsync(50);
    await p3;

    const s = f.stats();
    expect(s.coalesced).toBe(1);
    expect(s.cacheMisses).toBeGreaterThanOrEqual(2);
    expect(s.cacheHits).toBe(1);
  });
});
