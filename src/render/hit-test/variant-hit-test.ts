/**
 * VCF variant hit testing — pointer (canvas-relative px, py) → variant.
 *
 * Variants are anchored at a single genomic position (REF[POS]). The
 * renderer paints them as `MIN_TICK_PX`-wide vertical ticks spanning the
 * full band, so hit-test does the inverse: project the pointer x back to
 * a tile-relative bp range and pick the nearest variant whose tick
 * covers the pointer.
 *
 * Discriminated-union result matches `HoveredVariant` in `~state/hover`.
 */

import type {
  TileKey,
  TileStatus,
  TrackConfig,
  VariantTile,
  Viewport,
} from '~state/types';
import type {
  HoveredVariant,
  VariantKind,
  VariantSummary,
} from '~state/hover';
import { policyFor } from '~data/tile-policy';
import { computeTrackBands } from '~render/track-layout';

/** Mirrors the renderer's minimum on-screen width; sets the hit-test
 *  hot zone. Slightly wider than the visual to make ticks easier to
 *  click without pixel-precision aiming. */
const HIT_TICK_PX = 4;

const TYPE_CODE_TO_KIND: readonly VariantKind[] = ['snv', 'ins', 'del', 'mnv', 'sv'];

function collectVariantTilesForTrack(
  snapshot: ReadonlyMap<TileKey, TileStatus>,
  trackId: string,
  v: Viewport,
): VariantTile[] {
  const out: VariantTile[] = [];
  for (const status of snapshot.values()) {
    if (status.state !== 'ready') continue;
    const tile = status.tile;
    if (tile.payload !== 'variants') continue;
    if (tile.trackId !== trackId) continue;
    if (tile.chrom !== v.chrom) continue;
    if (tile.end <= v.start || tile.start >= v.end) continue;
    out.push(tile);
  }
  return out;
}

function summaryFrom(tile: VariantTile, i: number): VariantSummary {
  const pos = BigInt(tile.positions[i]!) + BigInt(tile.positionsHi[i]!) * 4_294_967_296n;
  return {
    pos,
    ref: tile.strings[tile.refStringIdx[i]!] ?? '',
    alt: tile.strings[tile.altStringIdx[i]!] ?? '',
    qual: tile.quals[i]!,
    type: TYPE_CODE_TO_KIND[Math.min(4, tile.types[i]!)]!,
  };
}

/**
 * Hit-test for VCF variant tracks. Returns the nearest variant whose
 * inflated tick contains (px, py), or `null` if no match.
 */
export function hitTestVariant(
  pointerPx: { px: number; py: number },
  viewportNow: Viewport,
  trackList: ReadonlyArray<TrackConfig>,
  tileCacheSnapshot: ReadonlyMap<TileKey, TileStatus>,
): HoveredVariant | null {
  const { px, py } = pointerPx;
  const span = Number(viewportNow.end - viewportNow.start);
  if (!Number.isFinite(span) || span <= 0) return null;
  const pxPerBp = viewportNow.pxWidth / span;
  if (!Number.isFinite(pxPerBp) || pxPerBp <= 0) return null;

  const bands = computeTrackBands(trackList, viewportNow);
  // Convert click x to a bp position with a +/- inflate so the user can
  // click within HIT_TICK_PX of the tick centre.
  const inflateBp = HIT_TICK_PX / Math.max(pxPerBp, 1e-9);
  const clickBp = Number(viewportNow.start) + px / pxPerBp;
  const lo = clickBp - inflateBp;
  const hi = clickBp + inflateBp;

  for (const band of bands) {
    if (band.kind !== 'vcf') continue;
    if (py < band.yTopPx || py >= band.yTopPx + band.bandHeightPx) continue;

    const policy = policyFor(band.kind, span);
    if (!policy) continue;

    const tiles = collectVariantTilesForTrack(tileCacheSnapshot, band.trackId, viewportNow);
    if (tiles.length === 0) continue;

    let bestPos = Number.NaN;
    let bestDelta = Infinity;
    let bestTile: VariantTile | null = null;
    let bestIdx = -1;

    for (const tile of tiles) {
      const n = tile.count;
      for (let i = 0; i < n; i++) {
        const absPos = tile.positions[i]! + tile.positionsHi[i]! * 4_294_967_296;
        if (absPos < lo || absPos > hi) continue;
        const delta = Math.abs(absPos - clickBp);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestPos = absPos;
          bestTile = tile;
          bestIdx = i;
        }
      }
    }

    if (bestTile === null || bestIdx < 0) continue;

    const xCenter = (bestPos - Number(viewportNow.start)) * pxPerBp;
    return {
      kind: 'variant',
      trackId: band.trackId,
      variant: summaryFrom(bestTile, bestIdx),
      rectPx: {
        left: xCenter - HIT_TICK_PX / 2,
        top: band.yTopPx,
        width: HIT_TICK_PX,
        height: band.bandHeightPx,
      },
    };
  }

  return null;
}
