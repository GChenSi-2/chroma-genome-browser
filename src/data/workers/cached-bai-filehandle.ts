/**
 * GenericFilehandle implementation for `.bai` (BAM index) files that
 * caches the whole file in IndexedDB on first fetch.
 *
 * Why whole-file: a single .bai is ~5-15 MB. @gmod/bam's BAI parser
 * walks the file from offset 0 sequentially during parse, so streaming
 * via Range requests would issue many fetches against a (slow) CDN.
 * One whole-file fetch + slice-locally beats N range fetches on a high-
 * latency public BAM host like NCBI ftp-trace.
 *
 * Lifetime: a `CachedBaiFilehandle` instance is created per `BamFile`
 * and held for the worker's lifetime in `bamCache`. The in-memory
 * `cached` field amortises subsequent reads within one session; the
 * IndexedDB layer amortises across sessions (the user's intended fix).
 *
 * Failure mode: any IDB / fetch error falls back to a fresh network
 * fetch. Cache miss is silent — no behaviour difference for callers.
 */

import { getCachedBinary, setCachedBinary } from '~data/network/binary-cache';

interface FilehandleOpts {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export class CachedBaiFilehandle {
  private readonly url: string;
  private readonly cacheKey: string;
  /** In-memory copy after first load. */
  private cached: Uint8Array | null = null;
  /** Coalesce concurrent first loads so parallel `getHeader` calls
   *  don't both fetch from network. */
  private loadPromise: Promise<Uint8Array> | null = null;

  constructor(url: string) {
    this.url = url;
    this.cacheKey = `bai:${url}`;
  }

  /** Whole-file fetch with cache-first lookup. */
  private async loadWholeFile(opts: FilehandleOpts = {}): Promise<Uint8Array> {
    if (this.cached) return this.cached;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      // 1. IndexedDB hit?
      try {
        const hit = await getCachedBinary(this.cacheKey);
        if (hit && hit.length > 0) {
          this.cached = hit;
          return hit;
        }
      } catch {
        // ignore — fall through to network
      }
      // 2. Network — whole file, no Range header (we want the full body).
      const res = await fetch(this.url, {
        method: 'GET',
        headers: opts.headers ?? {},
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      if (!res.ok) {
        throw new Error(`fetch ${this.url} failed: ${res.status} ${res.statusText}`);
      }
      const ab = await res.arrayBuffer();
      const bytes = new Uint8Array(ab);
      // 3. Best-effort populate cache for next session.
      setCachedBinary(this.cacheKey, bytes).catch(() => {});
      this.cached = bytes;
      return bytes;
    })();
    try {
      return await this.loadPromise;
    } finally {
      // Clear the promise reference so a future error doesn't trap callers.
      // The `cached` field stays populated on success; on failure both
      // stay null so the next call retries cleanly.
      if (!this.cached) this.loadPromise = null;
    }
  }

  /** GenericFilehandle: read a slice. @gmod/bam's BAI parser calls this
   *  with rising (position, length) pairs; we serve from the whole-file
   *  cache to avoid N round-trips. */
  async read(
    length: number,
    position: number,
    opts: FilehandleOpts = {},
  ): Promise<Uint8Array> {
    const all = await this.loadWholeFile(opts);
    const end = Math.min(all.length, position + length);
    return all.subarray(position, end);
  }

  /** GenericFilehandle: read the entire file. */
  async readFile(opts: FilehandleOpts = {}): Promise<Uint8Array> {
    return this.loadWholeFile(opts);
  }

  /** GenericFilehandle: file size (post-load). */
  async stat(): Promise<{ size: number }> {
    const all = await this.loadWholeFile();
    return { size: all.length };
  }

  /** GenericFilehandle: no-op — there's no underlying resource to release. */
  async close(): Promise<void> {
    // intentionally empty
  }
}
