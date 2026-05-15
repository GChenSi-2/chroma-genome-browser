/**
 * Tile policy — the single source of truth for "given a viewport span and a
 * track kind, what (binSize, tileWidthBp) should the tile system use?"
 *
 * Both `~data/track-engine` (dispatch) and `~render/scheduler` (filtering)
 * consume this. Keeping the lookup in one place means changing a policy is
 * a single-file edit, not a hunt across layers.
 *
 * Layering: this module imports only type-level state. It is dependency-free
 * at runtime (no signals, no DOM, no workers), so tests and either layer
 * can pull it in without cycles.
 */

import type { BinSize, TrackKind } from '~state/types';

export interface TilePolicy {
  /** bp per coverage/signal sample inside the tile. */
  binSize: BinSize;
  /** bp covered by one whole tile (fetch granularity). Always >= binSize. */
  tileWidthBp: number;
}

interface LadderEntry extends TilePolicy {
  /** This ladder rung applies when `spanBp <= maxSpan`. */
  maxSpan: number;
}

/**
 * BAM:
 *
 *  span (bp)        binSize    tileWidthBp    tiles/viewport
 *  ──────────────────────────────────────────────────────────
 *  ≤ 50,000          1,024     32,768           ≤ 3
 *  ≤ 1,000,000       8,192    524,288           ≤ 3
 *  ≤ 10,000,000     65,536  4,194,304           ≤ 3
 *   > 10,000,000   524,288 33,554,432           1-2
 */
const BAM_LADDER: ReadonlyArray<LadderEntry> = [
  { maxSpan: 50_000, binSize: 1024, tileWidthBp: 32_768 },
  { maxSpan: 1_000_000, binSize: 8192, tileWidthBp: 524_288 },
  { maxSpan: 10_000_000, binSize: 65_536, tileWidthBp: 4_194_304 },
  { maxSpan: Number.POSITIVE_INFINITY, binSize: 524_288, tileWidthBp: 33_554_432 },
];

/**
 * BigWig — same ladder as BAM for now. bbi is dense so finer binSize at fine
 * zoom would be visually crisper, but per-tile network overhead dominates;
 * matching BAM keeps total tile cardinality low.
 */
const BIGWIG_LADDER: ReadonlyArray<LadderEntry> = BAM_LADDER;

/**
 * Reference (FASTA): fixed binSize (one bp per base conceptually; 65_536 is
 * the smallest BinSize ladder rung that holds the marker). tileWidthBp 65 kb
 * means a ≤ 65 kb window fetches a single tile.
 */
const REFERENCE_POLICY: TilePolicy = { binSize: 65_536, tileWidthBp: 65_536 };

type PolicyFn = (spanBp: number) => TilePolicy;

const POLICIES: Partial<Record<TrackKind, PolicyFn>> = {
  bam: (span) => fromLadder(BAM_LADDER, span),
  bigwig: (span) => fromLadder(BIGWIG_LADDER, span),
  reference: () => REFERENCE_POLICY,
  // vcf / gene / bed: not yet scheduled — returning null leaves the cache
  // empty for those kinds, and the render layer skips them silently.
};

function fromLadder(ladder: ReadonlyArray<LadderEntry>, spanBp: number): TilePolicy {
  for (const rung of ladder) {
    if (spanBp <= rung.maxSpan) return { binSize: rung.binSize, tileWidthBp: rung.tileWidthBp };
  }
  const last = ladder[ladder.length - 1]!;
  return { binSize: last.binSize, tileWidthBp: last.tileWidthBp };
}

/**
 * The one function both data and render layers call. Returns null for
 * track kinds whose tile scheduling isn't wired yet (vcf/gene/bed).
 */
export function policyFor(kind: TrackKind, spanBp: number): TilePolicy | null {
  const fn = POLICIES[kind];
  return fn ? fn(spanBp) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backwards-compat shims — older callers imported the per-kind getter pairs
// directly. They now just delegate to policyFor. New callers should use
// policyFor.
// ─────────────────────────────────────────────────────────────────────────────

export function bamBinSizeForSpan(spanBp: number): BinSize {
  return policyFor('bam', spanBp)!.binSize;
}
export function bamTileWidthForSpan(spanBp: number): number {
  return policyFor('bam', spanBp)!.tileWidthBp;
}
export function bigWigBinSizeForSpan(spanBp: number): BinSize {
  return policyFor('bigwig', spanBp)!.binSize;
}
export function bigWigTileWidthForSpan(spanBp: number): number {
  return policyFor('bigwig', spanBp)!.tileWidthBp;
}

/** Backwards-compat: REFERENCE_POLICY constants exported for the scheduler. */
export const REFERENCE_BIN_SIZE: BinSize = REFERENCE_POLICY.binSize;
export const REFERENCE_TILE_WIDTH_BP: number = REFERENCE_POLICY.tileWidthBp;
