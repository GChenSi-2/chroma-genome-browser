/**
 * Shared types across data / render / state / ui layers.
 *
 * AGENT_PLAYBOOK §6.1 — lead-owned. Sub-agents may extend by adding new
 * fields *with lead approval*; they must not rename, remove, or change the
 * semantics of any existing field.
 *
 * Layering rule: this file imports from NOTHING in src/. Other layers import
 * from here. Keep it dependency-free.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Genomic coordinates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Genomic position in base pairs. 0-indexed, half-open in ranges.
 * MUST be `bigint`. Direct cast to `number` is only allowed inside
 * src/render/coord/index.ts.
 */
export type GenomicCoord = bigint;

export interface Locus {
  chrom: string;
  start: GenomicCoord;
  end: GenomicCoord;
}

export interface Viewport extends Locus {
  /** Logical CSS width of the stage in pixels. */
  pxWidth: number;
  /** Logical CSS height of the stage in pixels. */
  pxHeight: number;
}

export type SemanticLevel = 'overview' | 'coverage' | 'pileup' | 'base';

// ─────────────────────────────────────────────────────────────────────────────
// Tracks
// ─────────────────────────────────────────────────────────────────────────────

export type TrackKind =
  | 'reference'
  | 'bam'
  | 'bigwig'
  | 'vcf'
  | 'gene'
  | 'bed';

export interface TrackBase {
  id: string;
  kind: TrackKind;
  label: string;
  url: string;
  /** Visibility toggle from L4 UI. Hidden tracks are not fetched. */
  visible: boolean;
}

export interface BamTrack extends TrackBase {
  kind: 'bam';
  /** Companion index. */
  indexUrl: string;
  /** Optional: per-track pileup row cap. Defaults to 200. */
  maxRows?: number;
  /**
   * Map the viewport chrom name before sending it to the worker. 1000G
   * BAMs use bare "20"; hg38 BAMs use "chr20". Auto-prefix in locus-parser
   * means viewport.chrom usually carries "chr20" — `strip-chr` adapts to
   * a bare-chrom BAM, `add-chr` is the inverse for already-bare chrom inputs.
   */
  chromMap?: 'strip-chr' | 'add-chr';
}

export interface BigWigTrack extends TrackBase {
  kind: 'bigwig';
  /** Linear by default; toggleable per DESIGN_SYSTEM §3 BigWig. */
  scale?: 'linear' | 'log';
}

export interface VcfTrack extends TrackBase {
  kind: 'vcf';
  indexUrl: string;
}

export interface ReferenceTrack extends TrackBase {
  kind: 'reference';
  /** FASTA .fai sidecar. */
  faiUrl: string;
}

export interface GeneTrack extends TrackBase {
  kind: 'gene';
  /** GFF / BED format autodetected; explicit hint preferred. */
  format?: 'gff' | 'bed';
}

export type TrackConfig =
  | ReferenceTrack
  | BamTrack
  | BigWigTrack
  | VcfTrack
  | GeneTrack;

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

export type SelectionKind = 'read' | 'variant' | 'feature' | 'region';

export interface Selection {
  kind: SelectionKind;
  trackId: string;
  /** Stable identifier within the track (read name, variant id, etc.). */
  itemId: string;
  /** Genomic span for highlight box. */
  locus: Locus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tile system (ARCHITECTURE §2.2)
// ─────────────────────────────────────────────────────────────────────────────

/** Stable binSize ladder. ARCHITECTURE §2.2. */
export const BIN_SIZES = [128, 1024, 8192, 65_536, 524_288, 4_194_304] as const;
export type BinSize = (typeof BIN_SIZES)[number];

/** `${trackId}:${chrom}:${binSize}:${binIndex}`. */
export type TileKey = string;

export interface TileMetaBase {
  key: TileKey;
  trackId: string;
  chrom: string;
  binSize: BinSize;
  binIndex: number;
  /** Genomic range covered by this tile, derived from binSize × binIndex. */
  start: GenomicCoord;
  end: GenomicCoord;
}

/**
 * BAM read tile — Structure-of-Arrays for cache-friendly iteration and
 * Transferable zero-copy hand-off from worker.
 * Mirrors reference-spike/src/render/tracks-render/bam-pileup.ts ReadTile.
 */
export interface ReadTile extends TileMetaBase {
  payload: 'reads';
  count: number;
  /** Genomic start, low 32 bits. */
  starts: Int32Array;
  /** Genomic start, high 32 bits (usually 0 for human autosomes). */
  startsHi: Int32Array;
  lengths: Uint16Array;
  /** SAM flags. */
  flags: Uint16Array;
  mapq: Uint8Array;
}

/** BAM coverage histogram (used when binSize ≥ 8192). */
export interface CoverageTile extends TileMetaBase {
  payload: 'coverage';
  /** Per-bin depth. */
  values: Float32Array;
}

/** BigWig signal tile. Same shape as coverage, different semantics. */
export interface SignalTile extends TileMetaBase {
  payload: 'signal';
  values: Float32Array;
}

/** Reference FASTA tile — 2-bit packed bases. */
export interface ReferenceTile extends TileMetaBase {
  payload: 'reference';
  /** 2-bit-packed bases (A=0, C=1, G=2, T=3, N=4 via overflow byte). */
  packed: Uint8Array;
  /** Number of valid bases (may be less than packed.length * 4). */
  baseCount: number;
}

/** VCF variant tile. */
export interface VariantTile extends TileMetaBase {
  payload: 'variants';
  count: number;
  positions: Int32Array;
  positionsHi: Int32Array;
  /** Encoded variant type → DESIGN_SYSTEM §2.2 var-* colors. */
  types: Uint8Array;
  /** Indexes into a string pool (ref/alt) — pool sent alongside. */
  refStringIdx: Uint32Array;
  altStringIdx: Uint32Array;
  /** PHRED-scaled quality. */
  quals: Float32Array;
  strings: string[];
}

export type Tile =
  | ReadTile
  | CoverageTile
  | SignalTile
  | ReferenceTile
  | VariantTile;

export type TileStatus =
  | { state: 'pending' }
  | { state: 'ready'; tile: Tile }
  | { state: 'error'; message: string };

// ─────────────────────────────────────────────────────────────────────────────
// URL-state shape (so url-sync can serialize without a circular dep)
// ─────────────────────────────────────────────────────────────────────────────

export interface UrlState {
  viewport: { chrom: string; start: string; end: string };
  tracks: ReadonlyArray<TrackConfig>;
}
