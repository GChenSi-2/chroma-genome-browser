/**
 * Cache API helper for RangeFetcher.
 *
 * Scans up to CACHE_SCAN_LIMIT same-URL entries looking for either a direct
 * key match or any enclosing range. All cache operations are best-effort —
 * any failure short-circuits to "no hit" / "no-op put", never throws.
 */

const CACHE_SCAN_LIMIT = 32;

function getCachesGlobal(): CacheStorage | undefined {
  // Cache API may be absent in plain Node / happy-dom. Guard.
  const g = globalThis as { caches?: CacheStorage };
  return g.caches;
}

function makeCacheKey(url: string, start: number, end: number): string {
  return `${url}#bytes=${start}-${end}`;
}

function rangesEnclose(
  outerStart: number,
  outerEnd: number,
  innerStart: number,
  innerEnd: number,
): boolean {
  return outerStart <= innerStart && outerEnd >= innerEnd;
}

function sliceCopy(
  source: ArrayBuffer,
  sourceStart: number,
  start: number,
  end: number,
): ArrayBuffer {
  const offset = start - sourceStart;
  return source.slice(offset, offset + (end - start));
}

export interface RangeCache {
  /** Returns a fresh ArrayBuffer covering [start,end) if hit, else null. */
  tryHit(url: string, start: number, end: number): Promise<ArrayBuffer | null>;
  /** Best-effort write; never throws. */
  put(url: string, start: number, end: number, body: ArrayBuffer): Promise<void>;
}

/**
 * @param cacheName — pass `undefined` to disable entirely (returns a no-op).
 */
export function createRangeCache(cacheName: string | undefined): RangeCache {
  if (!cacheName) {
    return {
      tryHit: async () => null,
      put: async () => {},
    };
  }

  return {
    async tryHit(url, start, end) {
      const caches = getCachesGlobal();
      if (!caches) return null;
      let cache: Cache;
      try {
        cache = await caches.open(cacheName);
      } catch {
        return null;
      }

      const directKey = makeCacheKey(url, start, end);
      const direct = await cache.match(directKey).catch(() => undefined);
      if (direct) {
        const buf = await direct.arrayBuffer();
        return buf.slice(0);
      }

      const keys = await cache.keys().catch(() => [] as readonly Request[]);
      let scanned = 0;
      for (const req of keys) {
        if (scanned >= CACHE_SCAN_LIMIT) break;
        if (!req.url.startsWith(url + '#bytes=')) continue;
        scanned++;
        const match = /#bytes=(\d+)-(\d+)$/.exec(req.url);
        if (!match) continue;
        const sStr = match[1];
        const eStr = match[2];
        if (sStr === undefined || eStr === undefined) continue;
        const cStart = Number(sStr);
        const cEnd = Number(eStr);
        if (!rangesEnclose(cStart, cEnd, start, end)) continue;
        const resp = await cache.match(req).catch(() => undefined);
        if (!resp) continue;
        const buf = await resp.arrayBuffer();
        return sliceCopy(buf, cStart, start, end);
      }
      return null;
    },

    async put(url, start, end, body) {
      const caches = getCachesGlobal();
      if (!caches) return;
      try {
        const cache = await caches.open(cacheName);
        const resp = new Response(body.slice(0));
        await cache.put(makeCacheKey(url, start, end), resp);
      } catch {
        // best-effort
      }
    },
  };
}
