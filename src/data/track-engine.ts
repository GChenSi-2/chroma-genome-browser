/**
 * Track engine — L1 orchestrator that flows from L3 viewport/tracks signals
 * to the tile cache via the worker pool.
 *
 * Architecture compliance (M1 debt repayment, commit `179840d` deviation):
 *   - Routes results through `~data/tiles` (the lead-written LRU cache)
 *     instead of a side-channel `trackResults` signal. The L3 `tileCache`
 *     snapshot signal is the single source of truth for what the render
 *     layer can draw.
 *   - Picks a tile binSize from a viewport-span policy (BAM-specific) so
 *     pileup-level views fetch a handful of 1024-bp tiles and wide views
 *     fall back to coarser coverage tiles. The generic `binSizeForViewport`
 *     in derived.ts is unsuited for BAM at fine zoom (it returns 128, which
 *     would spam the BAI index with sub-chunk queries).
 *   - One worker request per (track, chrom, binSize, binIndex). Cache
 *     hits skip the worker entirely; pan with overlap reuses tiles.
 *
 * Still deferred:
 *   - Prefetch ±2 tiles on the leading edge (M2 main)
 *   - Cross-tile pileup row assignment (M2 main — currently rows reset per
 *     tile, so reads near tile boundaries can visually overlap)
 *   - BigWig / VCF / FASTA dispatch (M2 prep when the corresponding workers
 *     replace their stubs)
 */

import { createEffect, onCleanup } from 'solid-js';
import { tracks } from '~state/tracks';
import { viewport } from '~state/viewport';
import type {
  BamTrack,
  BinSize,
  TileKey,
  TileStatus,
  Tile,
  Viewport,
} from '~state/types';
import {
  formatTileKey,
  getTileCache,
  initTileCache,
  syncTileCacheViewport,
  type TileCacheController,
} from './tiles';
import { createWorkerPool, type WorkerPool } from './workers/pool';

/**
 * Viewport-span → binSize policy for BAM.
 *
 *  span (bp)        binSize    tile type    rationale
 *  ─────────────────────────────────────────────────────────────
 *  ≤ 50,000          1,024     ReadTile     pileup view, ~50 tiles max
 *  ≤ 1,000,000       8,192     CoverageTile coverage histogram
 *  ≤ 10,000,000     65,536     CoverageTile zoomed-out coverage
 *   > 10,000,000   524,288     CoverageTile chrom-overview
 */
interface BamPolicyEntry {
  maxSpan: number;
  binSize: BinSize;
}
const BAM_POLICY: ReadonlyArray<BamPolicyEntry> = [
  { maxSpan: 50_000, binSize: 1024 },
  { maxSpan: 1_000_000, binSize: 8192 },
  { maxSpan: 10_000_000, binSize: 65_536 },
  { maxSpan: Number.POSITIVE_INFINITY, binSize: 524_288 },
];

export function bamBinSizeForSpan(spanBp: number): BinSize {
  for (const entry of BAM_POLICY) {
    if (spanBp <= entry.maxSpan) return entry.binSize;
  }
  return 4_194_304;
}

function visibleTileIndexRange(
  start: bigint,
  end: bigint,
  binSize: BinSize,
): { first: number; last: number } {
  const binBig = BigInt(binSize);
  const first = Number(start / binBig);
  const lastInclusive = end > 0n ? Number((end - 1n) / binBig) : first;
  return { first, last: lastInclusive };
}

interface InflightHandle {
  controller: AbortController;
  trackId: string;
}

let pool: WorkerPool | null = null;
let cache: TileCacheController | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inflight: Map<TileKey, InflightHandle> = new Map();

const DEBOUNCE_MS = 100;

function abortAllInflight(): void {
  for (const h of inflight.values()) h.controller.abort();
  inflight.clear();
}

function dispatchTrack(
  track: BamTrack,
  v: Viewport,
  c: TileCacheController,
  p: WorkerPool,
): void {
  const span = Number(v.end - v.start);
  if (!Number.isFinite(span) || span <= 0) return;

  const binSize = bamBinSizeForSpan(span);
  const { first, last } = visibleTileIndexRange(v.start, v.end, binSize);

  // Build the visible-key set so we can cancel in-flight tiles that scrolled out.
  const wantedKeys = new Set<TileKey>();
  for (let binIndex = first; binIndex <= last; binIndex++) {
    wantedKeys.add(formatTileKey({ trackId: track.id, chrom: v.chrom, binSize, binIndex }));
  }

  // Abort tiles for this track that are no longer wanted.
  for (const [key, h] of inflight) {
    if (h.trackId !== track.id) continue;
    if (!wantedKeys.has(key)) {
      h.controller.abort();
      inflight.delete(key);
    }
  }

  for (let binIndex = first; binIndex <= last; binIndex++) {
    const key = formatTileKey({ trackId: track.id, chrom: v.chrom, binSize, binIndex });
    if (c.has(key)) continue; // cached (ready / pending / error — never re-fetch in same session)
    if (inflight.has(key)) continue;

    const controller = new AbortController();
    inflight.set(key, { controller, trackId: track.id });

    const pendingStatus: TileStatus = { state: 'pending' };
    c.put(key, pendingStatus);

    const tileStart = binIndex * binSize;
    const tileEnd = (binIndex + 1) * binSize;

    p
      .parseBamTile(
        {
          url: track.url,
          indexUrl: track.indexUrl,
          chrom: v.chrom,
          start: tileStart,
          end: tileEnd,
          binSize,
        },
        controller.signal,
      )
      .then((rawTile) => {
        if (controller.signal.aborted) return;
        // Worker emits trackId='' and a placeholder key; stamp them so the
        // cache snapshot keys match what the render layer scans for.
        const tile: Tile = {
          ...rawTile,
          trackId: track.id,
          key,
          chrom: v.chrom,
          binSize,
          binIndex,
          start: BigInt(tileStart),
          end: BigInt(tileEnd),
        };
        c.put(key, { state: 'ready', tile });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        c.put(key, { state: 'error', message });
      })
      .finally(() => {
        inflight.delete(key);
      });
  }
}

/**
 * Boot the engine. Idempotent — calling twice without dispose returns the
 * same pool/cache pair. Solid's createEffect / onCleanup are used, so this
 * must be invoked from within a render root (App's onMount qualifies).
 */
export function startTrackEngine(): () => void {
  if (!pool) pool = createWorkerPool();
  if (!cache) cache = initTileCache();
  const localPool = pool;
  const localCache = cache;

  createEffect(() => {
    const v = viewport();
    // Subscribe to tracks() for re-firing on add/remove/visibility-toggle.
    // We re-read the value inside the debounced callback so we always use
    // the freshest list, not whatever was captured at effect-fire time.
    tracks();

    // Tell the cache about the current viewport so eviction prefers far tiles.
    syncTileCacheViewport(v);

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      // Re-read fresh values (these reads are outside the effect's tracking
      // scope because we're inside setTimeout).
      const vNow = viewport();
      const listNow = tracks();
      for (const track of listNow) {
        if (!track.visible) continue;
        if (track.kind !== 'bam') continue;
        dispatchTrack(track, vNow, localCache, localPool);
      }
    }, DEBOUNCE_MS);
  });

  const dispose = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    abortAllInflight();
    pool?.dispose();
    pool = null;
    // The cache itself is kept across reboots — the singleton holds the data.
    // If a full reset is needed, callers should disposeTileCache() separately.
  };

  onCleanup(dispose);
  return dispose;
}

/** Diagnostic: current in-flight tile count. */
export function inflightCount(): number {
  return inflight.size;
}

/**
 * Helper for tests / dev: snapshot the tile cache via the singleton.
 * Render layer should subscribe to the L3 `tileCache` signal instead.
 */
export function snapshotTiles(): ReadonlyMap<TileKey, TileStatus> {
  return getTileCache().snapshot();
}
