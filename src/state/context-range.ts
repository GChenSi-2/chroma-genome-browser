/**
 * Context range — the "domain" the RangeSelectionBar visualises.
 *
 * Conceptually, this is the genomic span the user considers "loaded /
 * navigable" right now. The current viewport is a sub-range INSIDE the
 * contextRange, rendered as a draggable selection rectangle on the bar.
 *
 * Default behaviour: when the viewport's chromosome changes, we look up
 * the chromosome length in a built-in hg19 / GRCh37 table and reset
 * contextRange to [0, chromLength]. Users can override later (zoom
 * the ruler itself, etc. — Phase 2).
 *
 * Why a fixed hg19 table for now: we don't have the FASTA / .fai sidecar
 * wired (the Reference track demo is deferred), and IGV's own behaviour
 * is to assume whole-chromosome context unless told otherwise. The table
 * is small (24 entries) and public; if we ever support hg38 / mm10 we
 * add another table and key by genome build.
 */

import { createSignal, createEffect } from 'solid-js';
import type { Locus } from './types';
import { viewport } from './viewport';

/**
 * hg19 / GRCh37 chromosome lengths in bp. Source: UCSC chromInfo.txt.
 * Used to seed contextRange when no explicit domain is set. Other genome
 * builds (hg38, mm10) can be added as separate tables keyed by build.
 */
const HG19_CHROM_LENGTHS: Readonly<Record<string, bigint>> = {
  chr1: 249_250_621n,
  chr2: 243_199_373n,
  chr3: 198_022_430n,
  chr4: 191_154_276n,
  chr5: 180_915_260n,
  chr6: 171_115_067n,
  chr7: 159_138_663n,
  chr8: 146_364_022n,
  chr9: 141_213_431n,
  chr10: 135_534_747n,
  chr11: 135_006_516n,
  chr12: 133_851_895n,
  chr13: 115_169_878n,
  chr14: 107_349_540n,
  chr15: 102_531_392n,
  chr16: 90_354_753n,
  chr17: 81_195_210n,
  chr18: 78_077_248n,
  chr19: 59_128_983n,
  chr20: 63_025_520n,
  chr21: 48_129_895n,
  chr22: 51_304_566n,
  chrX: 155_270_560n,
  chrY: 59_373_566n,
  chrM: 16_571n,
};

/** Fallback when the chromosome isn't in our table (alt contigs, decoy, etc.). */
const FALLBACK_LENGTH = 250_000_000n;

/** Normalize bare "20" / "chr20" / "X" to canonical "chrN" for the table lookup. */
function chromKey(chrom: string): string {
  return chrom.startsWith('chr') ? chrom : `chr${chrom}`;
}

/**
 * The default context range for a chromosome — full chrom span starting at 0.
 * Exported so callers can preview / reset.
 */
export function defaultContextRange(chrom: string): Locus {
  const length = HG19_CHROM_LENGTHS[chromKey(chrom)] ?? FALLBACK_LENGTH;
  return { chrom, start: 0n, end: length };
}

const [contextRange, setContextRange] = createSignal<Locus>(
  defaultContextRange('chr20'),
  {
    equals: (a, b) => a.chrom === b.chrom && a.start === b.start && a.end === b.end,
  },
);

/**
 * Effect: when viewport's chromosome changes, reset contextRange to that
 * chromosome's full default span. Idempotent: same-chrom updates are a
 * no-op thanks to the equals function.
 *
 * Runs at module load (outside any reactive root) — emits the usual Solid
 * "computations outside createRoot" warning. Harmless; the contextRange
 * signal is process-wide just like viewport().
 */
createEffect(() => {
  const v = viewport();
  const current = contextRange();
  if (current.chrom !== v.chrom) {
    setContextRange(defaultContextRange(v.chrom));
  }
});

export { contextRange, setContextRange };
