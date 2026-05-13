import { createMemo } from 'solid-js';
import { viewport } from './viewport';
import { tracks } from './tracks';
import { BIN_SIZES, type BinSize, type SemanticLevel, type TileKey } from './types';

/**
 * Derived state — pure memos. ARCHITECTURE §4.2.
 *
 * Lives in L3 because both render (L2) and UI chrome (L4) consume the same
 * computed values. Keep this file dependency-free of coord helpers — the
 * formulas are duplicated here intentionally to avoid pulling L2 into L3.
 */

/** Pixels per base pair. Drives semantic zoom selection. */
export const basePixelWidth = createMemo<number>(() => {
  const v = viewport();
  const span = Number(v.end - v.start);
  return span > 0 ? v.pxWidth / span : 0;
});

/** Semantic zoom level for renderer dispatch. Thresholds from ARCHITECTURE §4.2. */
export const semanticLevel = createMemo<SemanticLevel>(() => {
  const bpw = basePixelWidth();
  if (bpw < 0.001) return 'overview';
  if (bpw < 0.05) return 'coverage';
  if (bpw < 4) return 'pileup';
  return 'base';
});

/**
 * Pick the bin size whose pixel footprint is closest to 1px.
 * This drives which tile-level data the renderer asks for.
 */
export const binSizeForViewport = createMemo<BinSize>(() => {
  const bpw = basePixelWidth();
  if (bpw <= 0) return BIN_SIZES[BIN_SIZES.length - 1]!;
  // Want roughly 1 bin == 1 pixel. binSize = 1 / bpw, snapped to ladder.
  const target = 1 / bpw;
  let best: BinSize = BIN_SIZES[0]!;
  for (const b of BIN_SIZES) {
    if (b <= target) best = b;
  }
  return best;
});

/**
 * Computed list of tile keys the renderer should currently be drawing.
 * Data layer subscribes to this to know what to prefetch.
 *
 * agent-ui implements the actual binning math; this stub keeps the export
 * shape stable so other layers can import unconditionally.
 */
export const visibleTileKeys = createMemo<ReadonlyArray<TileKey>>(() => {
  const v = viewport();
  const binSize = binSizeForViewport();
  const trackList = tracks();
  if (trackList.length === 0) return [];

  const firstBin = Number(v.start / BigInt(binSize));
  const lastBin = Number((v.end - 1n) / BigInt(binSize));
  const keys: TileKey[] = [];
  for (const t of trackList) {
    if (!t.visible) continue;
    for (let i = firstBin; i <= lastBin; i++) {
      keys.push(`${t.id}:${v.chrom}:${binSize}:${i}`);
    }
  }
  return keys;
});
