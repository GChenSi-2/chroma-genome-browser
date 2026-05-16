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
  /**
   * Single-fetch viewport mode. When set, the dispatcher emits exactly one
   * tile spanning [v.start, v.end] instead of N tiles bucketed onto a
   * fixed grid, and `tileWidthBp` equals the viewport span (variable per
   * call). The scheduler skips the tile-binning width check for vp tiles
   * and instead matches by exact tile.start === v.start.
   *
   * Used today for BAM pileup tier (span <= 50_000) where reads-per-byte
   * is high and saving 1-2 HTTP round-trips materially speeds up B1.
   */
  vp?: true;
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
 *  ≤ 50,000          1,024    span (vp mode)   1
 *  ≤ 1,000,000       8,192    524,288           ≤ 3
 *  ≤ 10,000,000     65,536  4,194,304           ≤ 3
 *   > 10,000,000   524,288 33,554,432           1-2
 *
 * Pileup tier uses vp (single-fetch-per-viewport) — see TilePolicy.vp.
 */
const BAM_PILEUP_VP_THRESHOLD = 50_000;
const BAM_LADDER: ReadonlyArray<LadderEntry> = [
  { maxSpan: 1_000_000, binSize: 8192, tileWidthBp: 524_288 },
  { maxSpan: 10_000_000, binSize: 65_536, tileWidthBp: 4_194_304 },
  { maxSpan: Number.POSITIVE_INFINITY, binSize: 524_288, tileWidthBp: 33_554_432 },
];

/**
 * BAM at pileup tier: emit exactly one tile spanning the full viewport.
 * binSize stays at 1024 (below COVERAGE_BIN_THRESHOLD in parser.worker so
 * the worker takes the per-read pack path); tileWidthBp tracks the viewport
 * span verbatim so the scheduler's per-tile width check is satisfied.
 */
function bamPolicy(span: number): TilePolicy {
  if (span <= BAM_PILEUP_VP_THRESHOLD) {
    return { binSize: 1024, tileWidthBp: Math.max(1, Math.floor(span)), vp: true };
  }
  return fromLadder(BAM_LADDER, span);
}

/**
 * BigWig — own ladder. BAM lost its pileup-tier rung when BAM moved to vp
 * mode; BigWig still wants the fine-grained 1024-bin tier at zoom-in so
 * the signal histogram isn't artificially coarsened.
 */
const BIGWIG_LADDER: ReadonlyArray<LadderEntry> = [
  { maxSpan: 50_000, binSize: 1024, tileWidthBp: 32_768 },
  { maxSpan: 1_000_000, binSize: 8192, tileWidthBp: 524_288 },
  { maxSpan: 10_000_000, binSize: 65_536, tileWidthBp: 4_194_304 },
  { maxSpan: Number.POSITIVE_INFINITY, binSize: 524_288, tileWidthBp: 33_554_432 },
];

/**
 * Reference (FASTA): fixed binSize (one bp per base conceptually; 65_536 is
 * the smallest BinSize ladder rung that holds the marker). tileWidthBp 65 kb
 * means a ≤ 65 kb window fetches a single tile.
 */
const REFERENCE_POLICY: TilePolicy = { binSize: 65_536, tileWidthBp: 65_536 };

/**
 * Gene annotation — single tile per Mb. binSize is a marker (the BIN_SIZES
 * ladder doesn't really apply to annotations), tileWidthBp drives the
 * Ensembl REST query range. 1 Mb is comfortable for the API (~50–100
 * features in a typical region) and gives generous cache reuse on pan.
 *
 * At wider zoom-outs we coarsen to 4 Mb tiles so a chrom-overview only
 * needs a handful of API calls. At chrom-overview tier (≥ 10 Mb viewport)
 * we still query 4 Mb chunks rather than 33 Mb because Ensembl truncates
 * very wide overlap responses.
 */
const GENE_LADDER: ReadonlyArray<LadderEntry> = [
  { maxSpan: 50_000, binSize: 1024, tileWidthBp: 65_536 },
  { maxSpan: 1_000_000, binSize: 8192, tileWidthBp: 1_048_576 },
  { maxSpan: Number.POSITIVE_INFINITY, binSize: 65_536, tileWidthBp: 4_194_304 },
];

type PolicyFn = (spanBp: number) => TilePolicy;

const POLICIES: Partial<Record<TrackKind, PolicyFn>> = {
  bam: bamPolicy,
  bigwig: (span) => fromLadder(BIGWIG_LADDER, span),
  reference: () => REFERENCE_POLICY,
  gene: (span) => fromLadder(GENE_LADDER, span),
  // vcf / bed: not yet scheduled — returning null leaves the cache empty
  // for those kinds, and the render layer skips them silently.
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
