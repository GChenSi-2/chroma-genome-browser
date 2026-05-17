/**
 * Track layout — shared geometry for the render scheduler and hit-test
 * pipeline. Both need to agree on track Y-offsets and band heights or the
 * tooltip would point at the wrong feature.
 *
 * Pure: depends only on the policy table and the visible-track list.
 */

import { policyFor, type TilePolicy } from '~data/tile-policy';
import type { TrackConfig, TrackKind, Viewport } from '~state/types';

export const TOP_PAD_PX = 16;
export const TRACK_GAP_PX = 8;

/** Default band heights by track kind. BAM coverage tier shrinks via
 *  `bandHeightFor()` below. */
export const TRACK_HEIGHT: Record<TrackKind, number> = {
  reference: 20,
  bam: 200,
  bigwig: 80,
  vcf: 28,
  gene: 90,
  bed: 32,
};

/** BAM band height when the policy returns a coverage-tier binSize. */
export const BAM_COVERAGE_HEIGHT_PX = 60;

export function bandHeightFor(kind: TrackKind, policy: TilePolicy): number {
  if (kind === 'bam') {
    return policy.binSize >= 8192 ? BAM_COVERAGE_HEIGHT_PX : TRACK_HEIGHT.bam;
  }
  return TRACK_HEIGHT[kind];
}

export interface TrackBandRect {
  trackId: string;
  kind: TrackKind;
  yTopPx: number;
  bandHeightPx: number;
}

/**
 * Replicate the scheduler's per-frame Y-offset progression so hit-test
 * lands on the same band the user sees. Visible tracks only.
 */
export function computeTrackBands(tracks: ReadonlyArray<TrackConfig>, v: Viewport): TrackBandRect[] {
  const span = Number(v.end - v.start);
  const out: TrackBandRect[] = [];
  let y = TOP_PAD_PX;
  for (const t of tracks) {
    if (!t.visible) continue;
    const policy = policyFor(t.kind, span);
    const h = policy ? bandHeightFor(t.kind, policy) : TRACK_HEIGHT[t.kind];
    out.push({ trackId: t.id, kind: t.kind, yTopPx: y, bandHeightPx: h });
    y += h + TRACK_GAP_PX;
  }
  return out;
}
