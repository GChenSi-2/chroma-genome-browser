/**
 * Tile cache — LRU + viewport-distance weighted eviction.
 *
 * ARCHITECTURE §2.2:
 *   - capacity 256 tiles
 *   - eviction prefers entries far from current viewport
 *   - on every put/delete, fires onChange with an immutable snapshot
 *     so L3 state can update its `tileCache` signal
 *
 * Lives in the data layer (agent-data ownership per AGENT_PLAYBOOK §2.2),
 * but written by lead in M1 prep to keep agent-data focused on the BAM
 * worker (T1.A.3). The interface is stable; agent-data may extend with
 * prefetch hooks later.
 */

import type {
  BinSize,
  TileKey,
  TileStatus,
  Viewport,
} from '~state/types';
import { BIN_SIZES } from '~state/types';

interface ParsedTileKey {
  trackId: string;
  chrom: string;
  binSize: BinSize;
  binIndex: number;
}

interface TileEntry extends ParsedTileKey {
  status: TileStatus;
  insertedMs: number;
}

const BIN_SIZE_SET: ReadonlySet<number> = new Set(BIN_SIZES);

/** `${trackId}:${chrom}:${binSize}:${binIndex}` — see ARCHITECTURE §2.2. */
export function parseTileKey(key: TileKey): ParsedTileKey | null {
  const parts = key.split(':');
  if (parts.length !== 4) return null;
  const [trackId, chrom, binSizeRaw, binIndexRaw] = parts;
  if (!trackId || !chrom || !binSizeRaw || !binIndexRaw) return null;
  const binSize = Number(binSizeRaw);
  const binIndex = Number(binIndexRaw);
  if (!BIN_SIZE_SET.has(binSize)) return null;
  if (!Number.isFinite(binIndex) || !Number.isInteger(binIndex) || binIndex < 0) return null;
  return { trackId, chrom, binSize: binSize as BinSize, binIndex };
}

export function formatTileKey(p: ParsedTileKey): TileKey {
  return `${p.trackId}:${p.chrom}:${p.binSize}:${p.binIndex}`;
}

export type TileCacheSnapshot = ReadonlyMap<TileKey, TileStatus>;

export interface TileCacheController {
  get(key: TileKey): TileStatus | undefined;
  has(key: TileKey): boolean;
  put(key: TileKey, status: TileStatus): void;
  delete(key: TileKey): boolean;
  /** Update the viewport used for distance-weighted eviction. */
  setViewport(viewport: Viewport | null): void;
  /** Immutable snapshot keyed by TileKey. */
  snapshot(): TileCacheSnapshot;
  size(): number;
  capacity(): number;
  /** Test/diagnostic hook — number of evictions since construction. */
  evictionCount(): number;
  dispose(): void;
}

export interface TileCacheOptions {
  capacity?: number;
  /** Fires after every mutation with the latest snapshot. */
  onChange?: (snapshot: TileCacheSnapshot) => void;
  /** Override clock for deterministic tests. */
  now?: () => number;
}

const DEFAULT_CAPACITY = 256;

/**
 * Computes "distance from viewport" for eviction scoring.
 *
 * On the same chrom as viewport: bp distance from the entry's midpoint
 *   to the viewport midpoint (smaller = keep).
 * On a different chrom: Infinity (always more evictable than same-chrom).
 */
function distanceBp(entry: TileEntry, viewport: Viewport): number {
  if (entry.chrom !== viewport.chrom) return Number.POSITIVE_INFINITY;
  const binSize = BigInt(entry.binSize);
  const entryStart = BigInt(entry.binIndex) * binSize;
  const entryMid = entryStart + binSize / 2n;
  const viewportMid = (viewport.start + viewport.end) / 2n;
  const delta = entryMid > viewportMid ? entryMid - viewportMid : viewportMid - entryMid;
  // bp distances are bounded by ~3e9; Number is safe.
  return Number(delta);
}

export function createTileCache(opts: TileCacheOptions = {}): TileCacheController {
  const capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY);
  const onChange = opts.onChange;
  const now = opts.now ?? Date.now;

  const entries = new Map<TileKey, TileEntry>();
  let viewport: Viewport | null = null;
  let evictions = 0;
  let disposed = false;

  const buildSnapshot = (): TileCacheSnapshot => {
    const snap = new Map<TileKey, TileStatus>();
    for (const [k, e] of entries) snap.set(k, e.status);
    return snap;
  };

  const emit = (): void => {
    if (onChange) onChange(buildSnapshot());
  };

  const evictToCapacity = (): void => {
    const overflow = entries.size - capacity;
    if (overflow <= 0) return;

    // Score each entry: higher = more evictable.
    // When viewport is set, distance dominates (weight ~1e6 per bp) so that
    // a far tile is always evicted before a near one, regardless of age.
    // When no viewport, fall back to pure LRU (oldest first).
    const nowMs = now();
    const scored: { key: TileKey; score: number }[] = [];
    for (const [key, e] of entries) {
      const ageMs = nowMs - e.insertedMs;
      const score = viewport ? distanceBp(e, viewport) * 1e6 + ageMs : ageMs;
      scored.push({ key, score });
    }
    scored.sort((a, b) => b.score - a.score); // descending

    for (let i = 0; i < overflow; i++) {
      entries.delete(scored[i]!.key);
      evictions++;
    }
  };

  return {
    get(key) {
      return entries.get(key)?.status;
    },
    has(key) {
      return entries.has(key);
    },
    put(key, status) {
      if (disposed) return;
      const parsed = parseTileKey(key);
      if (!parsed) {
        throw new Error(`TileCache: invalid tile key "${key}"`);
      }
      entries.set(key, { ...parsed, status, insertedMs: now() });
      evictToCapacity();
      emit();
    },
    delete(key) {
      const ok = entries.delete(key);
      if (ok) emit();
      return ok;
    },
    setViewport(v) {
      viewport = v;
    },
    snapshot() {
      return buildSnapshot();
    },
    size() {
      return entries.size;
    },
    capacity() {
      return capacity;
    },
    evictionCount() {
      return evictions;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      entries.clear();
      emit();
    },
  };
}
