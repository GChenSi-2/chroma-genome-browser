/**
 * Track engine — L1 orchestrator that flows from L3 viewport/tracks signals
 * to the tile cache via the worker pool.
 *
 * Pipeline:
 *   1. createEffect subscribes to viewport + tracks signals
 *   2. 100 ms debounce coalesces bursts (e.g. boot-time signal cascades)
 *   3. For each visible track, dispatch via the per-kind `Dispatcher`
 *      (uses the shared `policyFor` ladder from `./tile-policy`).
 *   4. Per tile in the viewport: cache.has? skip. inflight? skip.
 *      Otherwise: cache.put('pending'), call worker, cache.put('ready' | 'error').
 *   5. Render scheduler picks up the snapshot via the L3 `tileCache` signal.
 *
 * Architecture notes (M2-prep refactor, this commit):
 *   - Span → (binSize, tileWidthBp) ladders live in `tile-policy.ts`. Both
 *     this module and the render scheduler read from `policyFor` so they
 *     can't drift apart.
 *   - The three previous dispatchers (`dispatchBamTrack`,
 *     `dispatchBigWigTrack`, `dispatchReferenceTrack`) shared ~50 lines of
 *     loop+abort+cache scaffolding. They're now a single
 *     `runTileDispatch<T, R>` template — each kind contributes a tiny spec
 *     (worker call + request builder). New track kinds add ~15 lines
 *     instead of duplicating the template.
 *
 * Still deferred:
 *   - Prefetch ±N tiles on the leading edge of a pan
 *   - URL-hash sticky worker routing (warmer per-worker parser caches)
 *   - Cross-tile pileup row assignment
 *   - VCF / gene / bed dispatch (parsers stubbed; T2.E.1+)
 */

import { createEffect, onCleanup } from 'solid-js';
import { tracks } from '~state/tracks';
import { viewport } from '~state/viewport';
import type {
  BamTrack,
  GeneTrack,
  ReferenceTrack,
  TileKey,
  Tile,
  TrackConfig,
  Viewport,
} from '~state/types';
import {
  formatTileKey,
  initTileCache,
  syncTileCacheViewport,
  getTileCache,
  type TileCacheController,
} from './tiles';
import { policyFor, type TilePolicy } from './tile-policy';
import { fetchEnsemblGenes } from './network/ensembl-genes';
import { createWorkerPool, type WorkerPool } from './workers/pool';

// Re-export policy helpers so existing imports (`bamBinSizeForSpan`, etc.)
// keep working through this module.
export {
  policyFor,
  bamBinSizeForSpan,
  bamTileWidthForSpan,
  bigWigBinSizeForSpan,
  bigWigTileWidthForSpan,
  REFERENCE_BIN_SIZE,
  REFERENCE_TILE_WIDTH_BP,
  type TilePolicy,
} from './tile-policy';

// ─────────────────────────────────────────────────────────────────────────────
// Tile index range helper
// ─────────────────────────────────────────────────────────────────────────────

function visibleTileIndexRange(
  start: bigint,
  end: bigint,
  tileWidthBp: number,
): { first: number; last: number } {
  const widthBig = BigInt(tileWidthBp);
  const first = Number(start / widthBig);
  const lastInclusive = end > 0n ? Number((end - 1n) / widthBig) : first;
  return { first, last: lastInclusive };
}

/** Transform a viewport chrom name per a chrom-mapping rule. */
function mapChrom(
  chrom: string,
  mode: 'strip-chr' | 'add-chr' | undefined,
): string {
  if (mode === 'strip-chr') {
    return chrom.startsWith('chr') ? chrom.slice(3) : chrom;
  }
  if (mode === 'add-chr') {
    return chrom.startsWith('chr') ? chrom : 'chr' + chrom;
  }
  return chrom;
}

function mapBamChrom(track: BamTrack, chrom: string): string {
  return mapChrom(chrom, track.chromMap);
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
// Generic dispatch template
// ─────────────────────────────────────────────────────────────────────────────

interface DispatcherSpec<R extends Tile> {
  /** Track id (used for cache key + inflight tracking). */
  trackId: string;
  /** The track-engine policy chosen for this viewport. */
  policy: TilePolicy;
  /** Genomic chrom written into the cache key (outside-facing). */
  cacheChrom: string;
  /** Tile index range visible in the current viewport. */
  range: { first: number; last: number };
  /** Worker invocation for one tile range. Closure captures the track config. */
  workerCall: (tileStart: number, tileEnd: number, signal: AbortSignal) => Promise<R>;
}

function runTileDispatch<R extends Tile>(
  spec: DispatcherSpec<R>,
  c: TileCacheController,
): void {
  const { trackId, policy, cacheChrom, range, workerCall } = spec;
  const { binSize, tileWidthBp } = policy;

  const wantedKeys = new Set<TileKey>();
  for (let tileIndex = range.first; tileIndex <= range.last; tileIndex++) {
    wantedKeys.add(
      formatTileKey({ trackId, chrom: cacheChrom, binSize, tileWidthBp, tileIndex }),
    );
  }
  pruneInflightForTrack(trackId, wantedKeys);

  for (let tileIndex = range.first; tileIndex <= range.last; tileIndex++) {
    const key = formatTileKey({
      trackId,
      chrom: cacheChrom,
      binSize,
      tileWidthBp,
      tileIndex,
    });
    if (c.has(key)) continue;
    if (inflight.has(key)) continue;

    const controller = new AbortController();
    inflight.set(key, { controller, trackId });
    c.put(key, { state: 'pending' });

    const tileStart = tileIndex * tileWidthBp;
    const tileEnd = (tileIndex + 1) * tileWidthBp;

    workerCall(tileStart, tileEnd, controller.signal)
      .then((rawTile) => {
        if (controller.signal.aborted) return;
        // Worker emits placeholder trackId/key/chrom; stamp the canonical
        // values so the render layer scans by viewport chrom.
        const tile: Tile = {
          ...rawTile,
          trackId,
          key,
          chrom: cacheChrom,
          binSize,
          binIndex: tileIndex,
          start: BigInt(tileStart),
          end: BigInt(tileEnd),
        } as Tile;
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
// BAM single-fetch (viewport mode) — pileup tier only.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One request covers the entire viewport, bypassing the tile-binning loop.
 * Cache key encodes v.start as tileIndex so different viewport positions
 * stay distinct. Eviction distance scoring becomes meaningless for vp keys
 * (the tileIndex * tileWidthBp product is far outside genomic space) but
 * the cache never hits capacity at our N tracks — acceptable for now.
 */
function dispatchBamSingleFetch(
  track: BamTrack,
  v: Viewport,
  chromForWorker: string,
  policy: TilePolicy,
  c: TileCacheController,
  p: WorkerPool,
): void {
  const start = Number(v.start);
  const end = Number(v.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  const span = end - start;

  const key = formatTileKey({
    trackId: track.id,
    chrom: v.chrom,
    binSize: policy.binSize,
    tileWidthBp: span,
    tileIndex: start,
  });

  pruneInflightForTrack(track.id, new Set([key]));
  if (c.has(key)) return;
  if (inflight.has(key)) return;

  const controller = new AbortController();
  inflight.set(key, { controller, trackId: track.id });
  c.put(key, { state: 'pending' });

  p.parseBamTile(
    {
      url: track.url,
      indexUrl: track.indexUrl,
      chrom: chromForWorker,
      start,
      end,
      binSize: policy.binSize,
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
        binSize: policy.binSize,
        binIndex: 0,
        start: BigInt(start),
        end: BigInt(end),
      } as Tile;
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

// ─────────────────────────────────────────────────────────────────────────────
// Per-kind dispatcher specs
// ─────────────────────────────────────────────────────────────────────────────

function dispatchTrack(
  track: TrackConfig,
  v: Viewport,
  c: TileCacheController,
  p: WorkerPool,
): void {
  const span = Number(v.end - v.start);
  if (!Number.isFinite(span) || span <= 0) return;

  const policy = policyFor(track.kind, span);
  if (!policy) return; // vcf / gene / bed — silently skipped this commit

  const range = visibleTileIndexRange(v.start, v.end, policy.tileWidthBp);

  switch (track.kind) {
    case 'bam': {
      const chromForWorker = mapBamChrom(track, v.chrom);
      if (policy.vp) {
        dispatchBamSingleFetch(track, v, chromForWorker, policy, c, p);
        return;
      }
      runTileDispatch(
        {
          trackId: track.id,
          policy,
          cacheChrom: v.chrom,
          range,
          workerCall: (start, end, signal) =>
            p.parseBamTile(
              {
                url: track.url,
                indexUrl: (track as BamTrack).indexUrl,
                chrom: chromForWorker,
                start,
                end,
                binSize: policy.binSize,
              },
              signal,
            ),
        },
        c,
      );
      return;
    }
    case 'bigwig': {
      runTileDispatch(
        {
          trackId: track.id,
          policy,
          cacheChrom: v.chrom,
          range,
          workerCall: (start, end, signal) =>
            p.parseBigWigTile(
              {
                url: track.url,
                chrom: v.chrom,
                start,
                end,
                binSize: policy.binSize,
              },
              signal,
            ),
        },
        c,
      );
      return;
    }
    case 'reference': {
      const refTrack = track as ReferenceTrack;
      runTileDispatch(
        {
          trackId: track.id,
          policy,
          cacheChrom: v.chrom,
          range,
          workerCall: (start, end, signal) =>
            p.parseFastaTile(
              {
                url: refTrack.url,
                faiUrl: refTrack.faiUrl,
                chrom: v.chrom,
                start,
                end,
              },
              signal,
            ),
        },
        c,
      );
      return;
    }
    case 'gene': {
      const gTrack = track as GeneTrack;
      const host = gTrack.ensemblHost ?? 'https://rest.ensembl.org';
      const chromForApi = mapChrom(v.chrom, gTrack.chromMap);
      runTileDispatch(
        {
          trackId: track.id,
          policy,
          cacheChrom: v.chrom,
          range,
          // Annotation fetch is small JSON, runs on main thread. Re-using
          // the same `workerCall` slot keeps the dispatcher generic — the
          // worker pool is just ignored for this kind.
          workerCall: async (start, end, signal) => {
            const features = await fetchEnsemblGenes({
              host,
              chrom: chromForApi,
              start,
              end,
              signal,
            });
            return {
              key: '',
              trackId: '',
              chrom: v.chrom,
              binSize: policy.binSize,
              binIndex: 0,
              start: BigInt(start),
              end: BigInt(end),
              payload: 'gene',
              features,
            };
          },
        },
        c,
      );
      return;
    }
    // vcf / bed: policyFor returned null above.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine boot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Boot the engine. Idempotent — calling twice without dispose returns the
 * same pool/cache pair. Must be invoked from within a Solid render root
 * (App's onMount qualifies) so createEffect / onCleanup bind correctly.
 */
export function startTrackEngine(): () => void {
  if (!pool) pool = createWorkerPool();
  if (!cache) cache = initTileCache();
  const localPool = pool;
  const localCache = cache;

  createEffect(() => {
    const v = viewport();
    // Subscribe to tracks(); read the fresh list inside the debounced cb.
    tracks();

    syncTileCacheViewport(v);

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const vNow = viewport();
      const listNow = tracks();
      for (const track of listNow) {
        if (!track.visible) continue;
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
export function snapshotTiles(): ReturnType<TileCacheController['snapshot']> {
  return getTileCache().snapshot();
}

