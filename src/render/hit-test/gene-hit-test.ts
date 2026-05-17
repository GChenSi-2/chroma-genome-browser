/**
 * Gene-track hit testing — pointer (canvas-relative px, py) → feature.
 *
 * Pure function: derives the same per-frame layout the renderer uses
 * (track Y bands + per-tile row assignment) but evaluates only the
 * features whose pixel rect contains the pointer.
 *
 * Resolution priority within a row (matches the WebGL gene shader's
 * z-order):
 *   exon  →  transcript  →  gene
 * The first-priority hit is returned as `feature`, and the chain is
 * walked up to the parent gene which always populates `gene` (for the
 * tooltip's name / biotype display).
 */

import type {
  GeneFeature,
  GeneTile,
  TileKey,
  TileStatus,
  TrackConfig,
  Viewport,
} from '~state/types';
import { policyFor } from '~data/tile-policy';
import { computeTrackBands } from '~render/track-layout';
import { assignGeneRows } from '~render/tracks-render/gene';

export interface GeneHitResult {
  trackId: string;
  feature: GeneFeature;
  /** Parent gene (or `feature` itself when it's already a gene). */
  gene: GeneFeature;
  rectPx: { left: number; top: number; width: number; height: number };
}

/** Mirrors the WebGL gene shader's per-type vertical box within a row.
 *  In `(yLow, yHigh)` fractions of the row height. */
const VERT_BOX: Record<GeneFeature['type'], readonly [number, number]> = {
  gene: [0.05, 0.95],
  transcript: [0.45, 0.55],
  exon: [0.20, 0.80],
};

/** Hit-test priority — lower index wins when multiple types overlap. */
const TYPE_PRIORITY: ReadonlyArray<GeneFeature['type']> = ['exon', 'transcript', 'gene'];

function collectGeneTilesForTrack(
  snapshot: ReadonlyMap<TileKey, TileStatus>,
  trackId: string,
  v: Viewport,
): GeneTile[] {
  const out: GeneTile[] = [];
  for (const status of snapshot.values()) {
    if (status.state !== 'ready') continue;
    const tile = status.tile;
    if (tile.payload !== 'gene') continue;
    if (tile.trackId !== trackId) continue;
    if (tile.chrom !== v.chrom) continue;
    if (tile.end <= v.start || tile.start >= v.end) continue;
    out.push(tile);
  }
  return out;
}

function findGeneIn(features: ReadonlyArray<GeneFeature>, feature: GeneFeature): GeneFeature {
  if (feature.type === 'gene') return feature;
  let cur: GeneFeature | null = feature;
  // Walk up at most twice (exon → transcript → gene).
  for (let i = 0; i < 2 && cur && cur.parentId; i++) {
    const next = features.find((f) => f.id === cur!.parentId);
    if (!next) break;
    cur = next;
    if (cur.type === 'gene') return cur;
  }
  return cur ?? feature;
}

/**
 * Run hit-test against the current frame's layout. `px, py` are in CSS
 * pixels relative to the canvas's top-left corner.
 */
export function hitTestGene(
  pointerPx: { px: number; py: number },
  viewportNow: Viewport,
  trackList: ReadonlyArray<TrackConfig>,
  tileCacheSnapshot: ReadonlyMap<TileKey, TileStatus>,
): GeneHitResult | null {
  const { px, py } = pointerPx;
  const span = Number(viewportNow.end - viewportNow.start);
  if (!Number.isFinite(span) || span <= 0) return null;
  const pxPerBp = viewportNow.pxWidth / span;
  if (!Number.isFinite(pxPerBp) || pxPerBp <= 0) return null;

  const bands = computeTrackBands(trackList, viewportNow);

  for (const band of bands) {
    if (band.kind !== 'gene') continue;
    if (py < band.yTopPx || py >= band.yTopPx + band.bandHeightPx) continue;

    const policy = policyFor(band.kind, span);
    if (!policy) continue;

    const tiles = collectGeneTilesForTrack(tileCacheSnapshot, band.trackId, viewportNow);
    if (tiles.length === 0) continue;

    for (const tile of tiles) {
      const features = tile.features;
      const n = features.length;
      if (n === 0) continue;

      const { rows, maxRowUsed } = assignGeneRows(features);
      const rowCount = maxRowUsed + 1;
      const rowHeightPx = Math.max(2, band.bandHeightPx / rowCount);

      const rowIdx = Math.floor((py - band.yTopPx) / rowHeightPx);
      const rowYTop = band.yTopPx + rowIdx * rowHeightPx;

      // Candidate features in this row, ranked by TYPE_PRIORITY.
      const candidates: Array<{ feature: GeneFeature; xLeft: number; xRight: number }> = [];
      for (let i = 0; i < n; i++) {
        const f = features[i]!;
        if ((rows[i] ?? 0) !== rowIdx) continue;
        const x1 = Number(f.start - viewportNow.start) * pxPerBp;
        const x2 = Number(f.end - viewportNow.start) * pxPerBp;
        // The WebGL shader inflates a 1-px floor; mirror that so users can
        // click on a sub-pixel transcript backbone.
        const visualLeft = Math.min(x1, x2 - 1);
        const visualRight = Math.max(x2, x1 + 1);
        if (px < visualLeft || px > visualRight) continue;
        const box = VERT_BOX[f.type];
        const yLow = rowYTop + box[0] * rowHeightPx;
        const yHigh = rowYTop + box[1] * rowHeightPx;
        if (py < yLow || py > yHigh) continue;
        candidates.push({ feature: f, xLeft: visualLeft, xRight: visualRight });
      }
      if (candidates.length === 0) continue;

      // Prefer exon, then transcript, then gene; stable within a tier.
      candidates.sort(
        (a, b) => TYPE_PRIORITY.indexOf(a.feature.type) - TYPE_PRIORITY.indexOf(b.feature.type),
      );
      const winner = candidates[0]!;
      const gene = findGeneIn(features, winner.feature);

      return {
        trackId: band.trackId,
        feature: winner.feature,
        gene,
        rectPx: {
          left: winner.xLeft,
          top: rowYTop,
          width: Math.max(1, winner.xRight - winner.xLeft),
          height: rowHeightPx,
        },
      };
    }
  }

  return null;
}

/** Re-exported for tests that want to assert on row priority order. */
export const _TEST_TYPE_PRIORITY = TYPE_PRIORITY;
