import { createSignal } from 'solid-js';
import type { TileKey, TileStatus } from './types';

/**
 * Tile cache — bridge between data layer (writes) and render layer (reads).
 * ARCHITECTURE §2.2 + §4.
 *
 * The actual LRU eviction logic lives in src/data/tiles/cache.ts (agent-data
 * owns it). This signal is the *view* exposed to the rest of the app: a
 * frozen snapshot map keyed by TileKey.
 *
 * Why a Map-in-a-signal rather than a fine-grained record-per-tile:
 *   For 256 tiles, the overhead of a fresh Map allocation on every change is
 *   negligible (<1ms), and the render layer benefits from a single `tiles()`
 *   read in its raf loop instead of 256 separate signal subscriptions.
 */
export type TileCacheSnapshot = ReadonlyMap<TileKey, TileStatus>;

const EMPTY: TileCacheSnapshot = new Map();

const [tileCache, setTileCache] = createSignal<TileCacheSnapshot>(EMPTY);

export { tileCache, setTileCache };
