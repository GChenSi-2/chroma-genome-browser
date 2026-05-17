/**
 * Ruler helpers — pure formatting + tick-placement logic shared between the
 * chromosome overview bar and the local zoom bar.
 *
 * Layering: this module is dependency-free at runtime (no signals, no DOM)
 * so each ruler component imports it directly and unit tests can exercise
 * the math without spinning up a render root.
 */

import type { Locus } from '~state/types';

export interface Tick {
  /** Absolute genomic position of the tick. */
  posBp: bigint;
  /** Position as a fraction of the domain (0..1). */
  fraction: number;
  /** Human-readable label, e.g. "10 Mb" or "50.04 Mb". */
  label: string;
}

/**
 * Return a "nice" round step (1, 2, or 5 × 10^N) so that `span / step` is
 * close to `targetCount`. Mirrors the algorithm used by D3's
 * `d3.scaleLinear().ticks()`.
 */
export function niceInterval(spanBp: number, targetCount: number = 5): number {
  if (!Number.isFinite(spanBp) || spanBp <= 0 || targetCount <= 0) return 1;
  const rough = spanBp / targetCount;
  const pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow10;
  let nice: number;
  if (norm < 1.5) nice = 1;
  else if (norm < 3.5) nice = 2;
  else if (norm < 7.5) nice = 5;
  else nice = 10;
  return nice * pow10;
}

/**
 * Format an absolute genomic position appropriate to `intervalBp`. The
 * precision tracks the tick step so two adjacent ticks always read as
 * distinct values (no "50.0 Mb / 50.0 Mb" duplicates at a 20 kb step).
 */
export function formatTickPosition(bp: bigint, intervalBp: number): string {
  const n = Number(bp);
  // Unit is driven by POSITION magnitude, precision by INTERVAL granularity.
  //   - Mb-scale positions (≥ 1 Mb) always read in Mb; sub-Mb steps just add
  //     decimals (50_020_000 @ 20 kb → "50.02 Mb").
  //   - Sub-Mb positions (a small contig, or near contig start) read in kb,
  //     so a 100 kb hg19 alt shows "20 kb / 40 kb" not "0.02 Mb / 0.04 Mb".
  if (n >= 1_000_000) {
    if (intervalBp >= 1_000_000) return `${(n / 1_000_000).toFixed(0)} Mb`;
    if (intervalBp >= 100_000) return `${(n / 1_000_000).toFixed(1)} Mb`;
    if (intervalBp >= 10_000) return `${(n / 1_000_000).toFixed(2)} Mb`;
    return `${(n / 1_000_000).toFixed(3)} Mb`;
  }
  if (n >= 1_000 || intervalBp >= 1_000) {
    return `${Math.round(n / 1_000)} kb`;
  }
  return `${n}`;
}

/**
 * Compute nice tick positions inside `domain`. Skips ticks landing within
 * `edgeFraction` of either side so they don't collide with edge meta
 * labels (chrom name / total length).
 */
export function computeTicks(
  domain: Locus,
  targetCount: number = 5,
  edgeFraction: number = 0.05,
): Tick[] {
  const startN = Number(domain.start);
  const endN = Number(domain.end);
  const spanBp = endN - startN;
  if (spanBp <= 0) return [];
  const interval = niceInterval(spanBp, targetCount);
  const first = Math.ceil(startN / interval) * interval;
  const out: Tick[] = [];
  for (let pos = first; pos < endN; pos += interval) {
    const fraction = (pos - startN) / spanBp;
    if (fraction < edgeFraction || fraction > 1 - edgeFraction) continue;
    out.push({
      posBp: BigInt(pos),
      fraction,
      label: formatTickPosition(BigInt(pos), interval),
    });
  }
  return out;
}

/** Span width in bp, formatted with enough precision to discriminate. */
export function formatSpan(bp: number): string {
  if (bp < 1000) return `${bp} bp`;
  if (bp < 1_000_000) return `${(bp / 1000).toFixed(bp < 10_000 ? 2 : 1)} kb`;
  return `${(bp / 1_000_000).toFixed(2)} Mb`;
}

/** Absolute position — useful for the floating chip's "start" anchor. */
export function formatPosition(bp: bigint): string {
  const n = Number(bp);
  if (n < 1000) return `${n} bp`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} kb`;
  return `${(n / 1_000_000).toFixed(2)} Mb`;
}

/** Chromosome-scale total length, for the right-edge meta label. */
export function formatTotal(bp: bigint): string {
  const n = Number(bp);
  if (n < 1_000_000) return `${(n / 1000).toFixed(0)} kb`;
  return `${(n / 1_000_000).toFixed(1)} Mb`;
}
