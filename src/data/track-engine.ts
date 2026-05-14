/**
 * Track engine — L1 orchestrator that flows from L3 viewport/tracks signals
 * to the tile cache via the worker pool.
 *
 * Architecture compliance (M1 debt repayment, commit `179840d` deviation):
 *   - Routes results through `~data/tiles` (the lead-written LRU cache)
 *     instead of a side-channel `trackResults` signal. The L3 `tileCache`
 *     snapshot signal is the single source of truth for what the render
 *     layer can draw.
 *   - Picks a tile binSize from a viewport-span policy (per-kind) so
 *     pileup-level views fetch a handful of 1024-bp tiles and wide views
 *     fall back to coarser coverage/signal tiles. The generic
 *     `binSizeForViewport` in derived.ts is unsuited for BAM at fine zoom
 *     (it returns 128, which would spam the BAI index with sub-chunk queries).
 *   - One worker request per (track, chrom, binSize, binIndex). Cache
 *     hits skip the worker entirely; pan with overlap reuses tiles.
 *
 * M2-prep additions (this commit):
 *   - `dispatchBigWigTrack` + `bigWigBinSizeForSpan` — signal tiles for the
 *     coverage/overview semantic levels. BigWig benefits from finer
 *     resolution than BAM because bbi is dense.
 *   - `dispatchReferenceTrack` — single 65_536-bp tile per viewport for
 *     base-resolution FASTA. Reference fetches are cheap so a fixed binSize
 *     is fine.
 *   - `chromMap` on BamTrack: viewport.chrom may carry the locus-parser
 *     auto-prefix ("chr20"); some BAMs use bare ("20"). The transform is
 *     applied to what we send the worker; the cache key still uses the
 *     outside-facing `v.chrom` so render finds tiles by viewport chrom.
 *
 * Still deferred:
 *   - Prefetch ±2 tiles on the leading edge (M2 main)
 *   - Cross-tile pileup row assignment (M2 main — currently rows reset per
 *     tile, so reads near tile boundaries can visually overlap)
 *   - VCF / gene / bed dispatch (T2.E.1 + M2 main)
 */

import { createEffect, onCleanup } from 'solid-js';
import { tracks } from '~state/tracks';
import { viewport } from '~state/viewport';
import type {
  BamTrack,
  BigWigTrack,
  BinSize,
  ReferenceTrack,
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

// ─────────────────────────────────────────────────────────────────────────────
// Span → binSize policies (one per data kind)
// ─────────────────────────────────────────────────────────────────────────────

interface PolicyEntry {
  maxSpan: number;
  binSize: BinSize;
}

/**
 * BAM:
 *
 *  span (bp)        binSize    tile type    rationale
 *  ─────────────────────────────────────────────────────────────
 *  ≤ 50,000          1,024     ReadTile     pileup view, ~50 tiles max
 *  ≤ 1,000,000       8,192     CoverageTile coverage histogram
 *  ≤ 10,000,000     65,536     CoverageTile zoomed-out coverage
 *   > 10,000,000   524,288     CoverageTile chrom-overview
 */
const BAM_POLICY: ReadonlyArray<PolicyEntry> = [
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

/**
 * BigWig — bbi is dense, finer resolution is cheap:
 *
 *  span (bp)        binSize    rationale
 *  ─────────────────────────────────────────────────────────────
 *  ≤    50,000        128      ~390 bins, sub-bp detail visible
 *  ≤ 1,000,000      1,024      ~976 bins, smooth coverage
 *  ≤ 10,000,000     8,192      ~1220 bins, chrom-region overview
 *   > 10,000,000    65,536     chrom-overview
 */
const BIGWIG_POLICY: ReadonlyArray<PolicyEntry> = [
  { maxSpan: 50_000, binSize: 128 },
  { maxSpan: 1_000_000, binSize: 1024 },
  { maxSpan: 10_000_000, binSize: 8192 },
  { maxSpan: Number.POSITIVE_INFINITY, binSize: 65_536 },
];

export function bigWigBinSizeForSpan(spanBp: number): BinSize {
  for (const entry of BIGWIG_POLICY) {
    if (spanBp <= entry.maxSpan) return entry.binSize;
  }
  return 4_194_304;
}

/**
 * Reference (FASTA): a single fixed-binSize tile per viewport. 65_536-bp tiles
 * mean small windows (≤ 65kb) fetch one tile, larger windows split. Reference
 * fetches are cheap (sequential bytes through .fai), so no ladder is needed.
 */
const REFERENCE_BIN_SIZE: BinSize = 65_536;

// ─────────────────────────────────────────────────────────────────────────────
// Tile index range helper
// ─────────────────────────────────────────────────────────────────────────────

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

/** Transform a viewport chrom name per the BAM track's chromMap rule. */
function mapBamChrom(track: BamTrack, chrom: string): string {
  if (track.chromMap === 'strip-chr') {
    return chrom.startsWith('chr') ? chrom.slice(3) : chrom;
  }
  if (track.chromMap === 'add-chr') {
    return chrom.startsWith('chr') ? chrom : 'chr' + chrom;
  }
  return chrom;
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine state
// ─────────────────────────────────────────────────────────────────────────────

interface InflightHandle {
  controller: AbortController;
  trackId: string;
}

let pool: WorkerPool | null = null;
let cache: TileCacheController | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const inflight: Map<TileKey, InflightHandle> = new Map();

const DEBOUNCE_MS = 100;

function abortAllInflight(): void {
  for (const h of inflight.values()) h.controller.abort();
  inflight.clear();
}

/**
 * Cancel inflight tiles for `trackId` whose keys aren't in the wanted set.
 * Returns nothing — mutates the shared inflight map in place.
 */
function pruneInflightForTrack(trackId: string, wantedKeys: Set<TileKey>): void {
  for (const [key, h] of inflight) {
    if (h.trackId !== trackId) continue;
    if (!wantedKeys.has(key)) {
      h.controller.abort();
      inflight.delete(key);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BAM dispatcher
// ─────────────────────────────────────────────────────────────────────────────

function dispatchBamTrack(
  track: BamTrack,
  v: Viewport,
  c: TileCacheController,
  p: WorkerPool,
): void {
  const span = Number(v.end - v.start);
  if (!Number.isFinite(span) || span <= 0) return;

  const binSize = bamBinSizeForSpan(span);
  const { first, last } = visibleTileIndexRange(v.start, v.end, binSize);

  // Chrom mapping: the cache key uses v.chrom (the outside-facing name the
  // render layer scans for); only the worker request carries the mapped name.
  const chromForWorker = mapBamChrom(track, v.chrom);

  const wantedKeys = new Set<TileKey>();
  for (let binIndex = first; binIndex <= last; binIndex++) {
    wantedKeys.add(formatTileKey({ trackId: track.id, chrom: v.chrom, binSize, binIndex }));
  }
  pruneInflightForTrack(track.id, wantedKeys);

  for (let binIndex = first; binIndex <= last; binIndex++) {
    const key = formatTileKey({ trackId: track.id, chrom: v.chrom, binSize, binIndex });
    if (c.has(key)) continue;
    if (inflight.has(key)) continue;

    const controller = new AbortController();
    inflight.set(key, { controller, trackId: track.id });
    c.put(key, { state: 'pending' });

    const tileStart = binIndex * binSize;
    const tileEnd = (binIndex + 1) * binSize;

    p
      .parseBamTile(
        {
          url: track.url,
          indexUrl: track.indexUrl,
          chrom: chromForWorker,
          start: tileStart,
          end: tileEnd,
          binSize,
        },
        controller.signal,
      )
      .then((rawTile) => {
        if (controller.signal.aborted) return;
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

// ─────────────────────────────────────────────────────────────────────────────
// BigWig dispatcher
// ─────────────────────────────────────────────────────────────────────────────

function dispatchBigWigTrack(
  track: BigWigTrack,
  v: Viewport,
  c: TileCacheController,
  p: WorkerPool,
): void {
  const span = Number(v.end - v.start);
  if (!Number.isFinite(span) || span <= 0) return;

  const binSize = bigWigBinSizeForSpan(span);
  const { first, last } = visibleTileIndexRange(v.start, v.end, binSize);

  const wantedKeys = new Set<TileKey>();
  for (let binIndex = first; binIndex <= last; binIndex++) {
    wantedKeys.add(formatTileKey({ trackId: track.id, chrom: v.chrom, binSize, binIndex }));
  }
  pruneInflightForTrack(track.id, wantedKeys);

  for (let binIndex = first; binIndex <= last; binIndex++) {
    const key = formatTileKey({ trackId: track.id, chrom: v.chrom, binSize, binIndex });
    if (c.has(key)) continue;
    if (inflight.has(key)) continue;

    const controller = new AbortController();
    inflight.set(key, { controller, trackId: track.id });
    c.put(key, { state: 'pending' });

    const tileStart = binIndex * binSize;
    const tileEnd = (binIndex + 1) * binSize;

    p
      .parseBigWigTile(
        {
          url: track.url,
          chrom: v.chrom,
          start: tileStart,
          end: tileEnd,
          binSize,
        },
        controller.signal,
      )
      .then((rawTile) => {
        if (controller.signal.aborted) return;
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

// ─────────────────────────────────────────────────────────────────────────────
// Reference (FASTA) dispatcher
// ─────────────────────────────────────────────────────────────────────────────

function dispatchReferenceTrack(
  track: ReferenceTrack,
  v: Viewport,
  c: TileCacheController,
  p: WorkerPool,
): void {
  const span = Number(v.end - v.start);
  if (!Number.isFinite(span) || span <= 0) return;

  const binSize = REFERENCE_BIN_SIZE;
  const { first, last } = visibleTileIndexRange(v.start, v.end, binSize);

  const wantedKeys = new Set<TileKey>();
  for (let binIndex = first; binIndex <= last; binIndex++) {
    wantedKeys.add(formatTileKey({ trackId: track.id, chrom: v.chrom, binSize, binIndex }));
  }
  pruneInflightForTrack(track.id, wantedKeys);

  for (let binIndex = first; binIndex <= last; binIndex++) {
    const key = formatTileKey({ trackId: track.id, chrom: v.chrom, binSize, binIndex });
    if (c.has(key)) continue;
    if (inflight.has(key)) continue;

    const controller = new AbortController();
    inflight.set(key, { controller, trackId: track.id });
    c.put(key, { state: 'pending' });

    const tileStart = binIndex * binSize;
    const tileEnd = (binIndex + 1) * binSize;

    p
      .parseFastaTile(
        {
          url: track.url,
          faiUrl: track.faiUrl,
          chrom: v.chrom,
          start: tileStart,
          end: tileEnd,
        },
        controller.signal,
      )
      .then((rawTile) => {
        if (controller.signal.aborted) return;
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

// ─────────────────────────────────────────────────────────────────────────────
// Engine boot
// ─────────────────────────────────────────────────────────────────────────────

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
      const vNow = viewport();
      const listNow = tracks();
      for (const track of listNow) {
        if (!track.visible) continue;
        if (track.kind === 'bam') {
          dispatchBamTrack(track, vNow, localCache, localPool);
        } else if (track.kind === 'bigwig') {
          dispatchBigWigTrack(track, vNow, localCache, localPool);
        } else if (track.kind === 'reference') {
          dispatchReferenceTrack(track, vNow, localCache, localPool);
        }
        // gene / vcf / bed: M2 main
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
