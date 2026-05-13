/**
 * RangeFetcher — unified HTTP Range request layer for L1 data.
 *
 * Behaviors (ARCHITECTURE §2.4):
 *   - Coalesces small adjacent byte-range requests within a time window into
 *     one underlying fetch. Each caller resolves with a fresh ArrayBuffer
 *     slice (real copy — required so downstream code may post the buffer as
 *     a Transferable without aliasing).
 *   - Persists merged responses via the browser Cache API; lookups scan
 *     same-URL entries and serve any enclosing range from cache.
 *   - Caps in-flight underlying fetches with a FIFO queue.
 *   - Per-caller AbortSignal: cancelling only your slice; the underlying
 *     fetch keeps going until either it completes or every coalesced caller
 *     has aborted.
 *   - Network/5xx retry with exponential backoff; 4xx fails fast.
 *
 * AGENT_PLAYBOOK §2.2: agent-data ownership.
 */

import { createRangeCache, type RangeCache } from './range-cache';

export interface RangeRequest {
  url: string;
  /** Byte offset, inclusive. */
  start: number;
  /** Byte offset, exclusive. */
  end: number;
  signal?: AbortSignal;
}

export interface RangeFetcherStats {
  inFlight: number;
  coalesced: number;
  cacheHits: number;
  cacheMisses: number;
}

export interface RangeFetcher {
  fetch(req: RangeRequest): Promise<ArrayBuffer>;
  prefetch(req: Omit<RangeRequest, 'signal'>): void;
  dispose(): void;
  stats(): RangeFetcherStats;
}

export interface RangeFetcherOptions {
  /** Time window during which new requests may coalesce. Default 500ms. */
  coalesceWindowMs?: number;
  /** Largest acceptable byte gap between coalesced ranges. Default 64KiB. */
  coalesceMaxGapBytes?: number;
  /** Concurrent underlying fetches. Default 6. */
  maxConcurrent?: number;
  /** Cache API cache name; pass `undefined` to disable Cache API entirely. */
  cacheName?: string | undefined;
  /** Injected fetch implementation for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_WINDOW_MS = 500;
const DEFAULT_MAX_GAP = 64 * 1024;
const DEFAULT_MAX_CONCURRENT = 6;
const DEFAULT_CACHE_NAME = 'chroma-range-v1';
const RETRY_DELAYS_MS = [200, 500, 1200] as const;

type Resolver = (value: ArrayBuffer) => void;
type Rejecter = (reason: unknown) => void;

interface Waiter {
  start: number;
  end: number;
  signal: AbortSignal | undefined;
  abortHandler: (() => void) | undefined;
  aborted: boolean;
  resolve: Resolver;
  reject: Rejecter;
}

interface PendingBatch {
  url: string;
  start: number;
  end: number;
  waiters: Waiter[];
  timer: ReturnType<typeof setTimeout> | null;
  dispatched: boolean;
}

interface QueuedJob {
  url: string;
  start: number;
  end: number;
  waiters: Waiter[];
}

function createAbortError(): DOMException {
  return new DOMException('aborted', 'AbortError');
}

function sleep(ms: number, outerSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (outerSignal?.aborted) {
      reject(createAbortError());
      return;
    }
    const t = setTimeout(() => {
      outerSignal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(createAbortError());
    };
    outerSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

function sliceFromBatch(
  source: ArrayBuffer,
  sourceStart: number,
  start: number,
  end: number,
): ArrayBuffer {
  const offset = start - sourceStart;
  return source.slice(offset, offset + (end - start));
}

export function createRangeFetcher(opts: RangeFetcherOptions = {}): RangeFetcher {
  const windowMs = opts.coalesceWindowMs ?? DEFAULT_WINDOW_MS;
  const maxGap = opts.coalesceMaxGapBytes ?? DEFAULT_MAX_GAP;
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const cacheName = 'cacheName' in opts ? opts.cacheName : DEFAULT_CACHE_NAME;
  const fetchImpl: typeof fetch =
    opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const cache: RangeCache = createRangeCache(cacheName);

  const batchesByUrl = new Map<string, PendingBatch>();
  const queue: QueuedJob[] = [];
  let inFlight = 0;
  let disposed = false;

  const counters: RangeFetcherStats = {
    inFlight: 0,
    coalesced: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };

  async function fetchWithRetry(
    url: string,
    start: number,
    end: number,
    innerSignal: AbortSignal,
  ): Promise<ArrayBuffer> {
    let attempt = 0;
    for (;;) {
      if (innerSignal.aborted) throw createAbortError();
      let resp: Response;
      try {
        resp = await fetchImpl(url, {
          headers: { Range: `bytes=${start}-${end - 1}` },
          signal: innerSignal,
        });
      } catch (err) {
        if (innerSignal.aborted) throw createAbortError();
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) throw err;
        attempt++;
        await sleep(delay, innerSignal);
        continue;
      }
      if (resp.status >= 200 && resp.status < 300) {
        return await resp.arrayBuffer();
      }
      if (resp.status >= 400 && resp.status < 500) {
        throw new Error(`Range request failed: HTTP ${resp.status}`);
      }
      // 5xx — retry.
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        throw new Error(`Range request failed: HTTP ${resp.status}`);
      }
      attempt++;
      await sleep(delay, innerSignal);
    }
  }

  function detachWaiter(w: Waiter): void {
    if (w.abortHandler && w.signal) {
      w.signal.removeEventListener('abort', w.abortHandler);
      w.abortHandler = undefined;
    }
  }

  function runJob(job: QueuedJob): void {
    inFlight++;
    counters.inFlight = inFlight;

    const innerController = new AbortController();
    const checkAllAborted = (): void => {
      if (innerController.signal.aborted) return;
      if (job.waiters.every((w) => w.aborted)) innerController.abort();
    };

    // Waiters already have abort handlers from admit(). Add a secondary
    // listener so we can early-abort the inner controller once every
    // coalesced caller has dropped.
    const innerAbortListeners: Array<{ w: Waiter; fn: () => void }> = [];
    for (const w of job.waiters) {
      if (w.signal && !w.aborted) {
        const fn = () => checkAllAborted();
        w.signal.addEventListener('abort', fn, { once: true });
        innerAbortListeners.push({ w, fn });
      }
    }
    checkAllAborted();

    void (async () => {
      try {
        const buf = await fetchWithRetry(
          job.url,
          job.start,
          job.end,
          innerController.signal,
        );
        void cache.put(job.url, job.start, job.end, buf);
        for (const w of job.waiters) {
          if (w.aborted) continue;
          try {
            w.resolve(sliceFromBatch(buf, job.start, w.start, w.end));
          } catch (sliceErr) {
            w.reject(sliceErr);
          }
          detachWaiter(w);
        }
      } catch (err) {
        for (const w of job.waiters) {
          if (w.aborted) continue;
          w.reject(err);
          detachWaiter(w);
        }
      } finally {
        for (const h of innerAbortListeners) {
          h.w.signal?.removeEventListener('abort', h.fn);
        }
        inFlight--;
        counters.inFlight = inFlight;
        pump();
      }
    })();
  }

  function pump(): void {
    while (!disposed && inFlight < maxConcurrent && queue.length > 0) {
      const next = queue.shift();
      if (next) runJob(next);
    }
  }

  function dispatchBatch(batch: PendingBatch): void {
    if (batch.dispatched) return;
    batch.dispatched = true;
    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }
    if (batchesByUrl.get(batch.url) === batch) {
      batchesByUrl.delete(batch.url);
    }
    queue.push({
      url: batch.url,
      start: batch.start,
      end: batch.end,
      waiters: batch.waiters,
    });
    pump();
  }

  function canMerge(batch: PendingBatch, start: number, end: number): boolean {
    if (batch.dispatched) return false;
    const gap = Math.max(0, Math.max(batch.start, start) - Math.min(batch.end, end));
    return gap <= maxGap;
  }

  function admit(
    url: string,
    start: number,
    end: number,
    signal: AbortSignal | undefined,
  ): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      if (disposed) {
        reject(new Error('RangeFetcher disposed'));
        return;
      }
      if (signal?.aborted) {
        reject(createAbortError());
        return;
      }

      const waiter: Waiter = {
        start,
        end,
        signal,
        abortHandler: undefined,
        aborted: false,
        resolve,
        reject,
      };

      // Attach the abort handler eagerly so callers see rejection even
      // before the batch dispatches.
      if (signal) {
        const handler = () => {
          if (waiter.aborted) return;
          waiter.aborted = true;
          waiter.reject(createAbortError());
          detachWaiter(waiter);
        };
        waiter.abortHandler = handler;
        signal.addEventListener('abort', handler, { once: true });
      }

      const existing = batchesByUrl.get(url);
      if (existing && canMerge(existing, start, end)) {
        existing.waiters.push(waiter);
        existing.start = Math.min(existing.start, start);
        existing.end = Math.max(existing.end, end);
        counters.coalesced++;
        return;
      }

      if (existing) dispatchBatch(existing);

      const batch: PendingBatch = {
        url,
        start,
        end,
        waiters: [waiter],
        timer: null,
        dispatched: false,
      };
      batch.timer = setTimeout(() => dispatchBatch(batch), windowMs);
      batchesByUrl.set(url, batch);
    });
  }

  async function fetchRange(req: RangeRequest): Promise<ArrayBuffer> {
    if (disposed) throw new Error('RangeFetcher disposed');
    if (
      !Number.isFinite(req.start) ||
      !Number.isFinite(req.end) ||
      req.end <= req.start
    ) {
      throw new Error(`Invalid byte range ${req.start}-${req.end}`);
    }
    if (req.signal?.aborted) throw createAbortError();

    const cached = await cache.tryHit(req.url, req.start, req.end);
    if (cached) {
      counters.cacheHits++;
      return cached;
    }
    counters.cacheMisses++;
    return await admit(req.url, req.start, req.end, req.signal);
  }

  function prefetch(req: Omit<RangeRequest, 'signal'>): void {
    void fetchRange({ url: req.url, start: req.start, end: req.end }).catch(
      () => {
        // swallow — prefetch failures are not actionable
      },
    );
  }

  function rejectAllWaiters(waiters: Waiter[]): void {
    for (const w of waiters) {
      if (w.aborted) continue;
      w.reject(new Error('RangeFetcher disposed'));
      detachWaiter(w);
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const batch of batchesByUrl.values()) {
      if (batch.timer) clearTimeout(batch.timer);
      rejectAllWaiters(batch.waiters);
    }
    batchesByUrl.clear();
    for (const job of queue) rejectAllWaiters(job.waiters);
    queue.length = 0;
  }

  function stats(): RangeFetcherStats {
    return { ...counters };
  }

  return { fetch: fetchRange, prefetch, dispose, stats };
}
