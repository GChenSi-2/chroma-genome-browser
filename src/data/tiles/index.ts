/**
 * Tile cache wiring — single global instance, pumps snapshots into the L3
 * `tileCache` signal so render and UI layers see them.
 *
 * Why a singleton: the cache is process-wide state. Multiple instances would
 * shadow each other in the L3 signal. Tests can side-step this by importing
 * `createTileCache` directly.
 */

import { setTileCache } from '~state/tile-cache';
import type { Viewport } from '~state/types';
import {
  createTileCache,
  type TileCacheController,
  type TileCacheOptions,
} from './cache';

let instance: TileCacheController | null = null;

export function initTileCache(opts: Omit<TileCacheOptions, 'onChange'> = {}): TileCacheController {
  if (instance) return instance;
  instance = createTileCache({
    ...opts,
    onChange: (snapshot) => setTileCache(snapshot),
  });
  return instance;
}

export function getTileCache(): TileCacheController {
  if (!instance) {
    throw new Error('Tile cache not initialized — call initTileCache() at app boot');
  }
  return instance;
}

/** Update the eviction-distance viewport. Call from a state effect on viewport(). */
export function syncTileCacheViewport(viewport: Viewport | null): void {
  instance?.setViewport(viewport);
}

export function disposeTileCache(): void {
  instance?.dispose();
  instance = null;
}

export {
  createTileCache,
  parseTileKey,
  formatTileKey,
  type TileCacheController,
  type TileCacheOptions,
  type TileCacheSnapshot,
} from './cache';
