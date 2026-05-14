/**
 * Track engine — bridges L3 viewport/tracks signals to the worker pool,
 * and writes results to a per-track signal the render layer subscribes to.
 *
 * Deviation note (lead, M1 E2E smoke):
 *   This bypasses the lead-written tile cache (src/data/tiles/cache.ts).
 *   The cache keys reads into the BIN_SIZES ladder, which for a typical
 *   pileup-level viewport (1Mb) produces hundreds of micro-tiles, each
 *   triggering its own BAM range read — wasteful for an integration
 *   smoke. M2 prep reintroduces proper tile binning + cache hits +
 *   prefetch. For now: ONE worker request per (track, viewport),
 *   debounced, with abort-on-viewport-change. ARCHITECTURE §2.2 promised
 *   tile binning; this is an explicit interim step.
 */

import { createEffect, createSignal, onCleanup } from 'solid-js';
import { tracks } from '~state/tracks';
import { viewport } from '~state/viewport';
import type {
  BamTrack,
  CoverageTile,
  ReadTile,
  Viewport,
} from '~state/types';
import { createWorkerPool, type WorkerPool } from './workers/pool';

export type TrackDataStatus =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; tile: ReadTile | CoverageTile; viewport: Viewport }
  | { state: 'error'; message: string };

/** Map<trackId, current data status>. Render layer reads this. */
export type TrackResults = ReadonlyMap<string, TrackDataStatus>;

const [trackResults, setTrackResults] = createSignal<TrackResults>(new Map());

let pool: WorkerPool | null = null;

/** Per-track debounce timers and in-flight aborters. */
interface PerTrackState {
  debounceTimer: ReturnType<typeof setTimeout> | null;
  abortController: AbortController | null;
}

/**
 * Boot the engine. Returns a disposer. Idempotent: calling again before
 * dispose returns the existing pool.
 */
export function startTrackEngine(): () => void {
  if (!pool) pool = createWorkerPool();
  const localPool = pool;
  const perTrack = new Map<string, PerTrackState>();

  const update = (id: string, status: TrackDataStatus): void => {
    setTrackResults((prev) => {
      const next = new Map(prev);
      next.set(id, status);
      return next;
    });
  };

  const cancelFor = (id: string): void => {
    const s = perTrack.get(id);
    if (!s) return;
    if (s.debounceTimer) clearTimeout(s.debounceTimer);
    s.abortController?.abort();
    s.debounceTimer = null;
    s.abortController = null;
  };

  const dispatchBam = (track: BamTrack, v: Viewport): void => {
    cancelFor(track.id);
    const s: PerTrackState = perTrack.get(track.id) ?? {
      debounceTimer: null,
      abortController: null,
    };
    perTrack.set(track.id, s);

    update(track.id, { state: 'loading' });

    s.debounceTimer = setTimeout(() => {
      s.debounceTimer = null;
      const ac = new AbortController();
      s.abortController = ac;

      // Use binSize 1024 to force ReadTile path (parser returns coverage
      // when binSize ≥ 8192). Range = full viewport, lo32 safe at
      // human-genome scale because viewport spans are well under 2^31.
      const start = Number(v.start);
      const end = Number(v.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        update(track.id, { state: 'error', message: 'invalid viewport range' });
        return;
      }

      localPool
        .parseBamTile(
          {
            url: track.url,
            indexUrl: track.indexUrl,
            chrom: v.chrom,
            start,
            end,
            binSize: 1024,
          },
          ac.signal,
        )
        .then((tile) => {
          if (ac.signal.aborted) return;
          update(track.id, { state: 'ready', tile, viewport: v });
        })
        .catch((err: unknown) => {
          if (ac.signal.aborted) return;
          const message = err instanceof Error ? err.message : String(err);
          update(track.id, { state: 'error', message });
        });
    }, 200);
  };

  // React to viewport / tracks changes.
  createEffect(() => {
    const v = viewport();
    const list = tracks();

    // Drop results for tracks that no longer exist.
    const liveIds = new Set(list.map((t) => t.id));
    setTrackResults((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const id of next.keys()) {
        if (!liveIds.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    for (const id of perTrack.keys()) {
      if (!liveIds.has(id)) {
        cancelFor(id);
        perTrack.delete(id);
      }
    }

    for (const track of list) {
      if (!track.visible) {
        cancelFor(track.id);
        update(track.id, { state: 'idle' });
        continue;
      }
      if (track.kind !== 'bam') {
        // BigWig / FASTA / VCF not wired into this E2E smoke — silent skip
        // so they don't litter the result map with `error`.
        continue;
      }
      dispatchBam(track, v);
    }
  });

  onCleanup(() => {
    for (const id of perTrack.keys()) cancelFor(id);
    perTrack.clear();
    pool?.dispose();
    pool = null;
  });

  return () => {
    for (const id of perTrack.keys()) cancelFor(id);
    perTrack.clear();
    pool?.dispose();
    pool = null;
  };
}

export { trackResults };
