/**
 * Context range — the "domain" the RangeSelectionBar visualises.
 *
 * Conceptually, this is the genomic span the user considers "loaded /
 * navigable" right now. The current viewport is a sub-range INSIDE the
 * contextRange, rendered as a draggable selection rectangle on the bar.
 *
 * Default + adaptation rules:
 *   1. When the viewport's chromosome changes, snap contextRange to the
 *      full chromosome from the built-in hg19 / GRCh37 length table.
 *   2. When the viewport stays on the same chromosome, leave the context
 *      alone — small pans should slide the selection across the bar, not
 *      re-centre the bar under the user's cursor.
 *   3. EXCEPT: when the selection would become unusable (occupies < 2 % of
 *      the bar, > 70 % of the bar, or the viewport has scrolled outside
 *      the context entirely), debounce 200 ms and then re-fit the context
 *      to be ~10 × the viewport span centred on the viewport midpoint,
 *      clamped to the chromosome.
 *
 * The debounce is critical: without it, an active drag-to-resize on the
 * selection block would re-centre the context every frame and the
 * selection would feel "stuck" under the cursor.
 *
 * Why a fixed hg19 table for now: we don't have the FASTA / .fai sidecar
 * wired (the Reference track demo is deferred), and IGV's own behaviour
 * is to assume whole-chromosome context unless told otherwise.
 */

import { createSignal, createEffect, onCleanup } from 'solid-js';
import type { Locus } from './types';
import { viewport } from './viewport';

/**
 * hg19 / GRCh37 chromosome lengths in bp. Source: UCSC chromInfo.txt.
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

/** Fallback when the chromosome isn't in our table. */
const FALLBACK_LENGTH = 250_000_000n;

function chromKey(chrom: string): string {
  return chrom.startsWith('chr') ? chrom : `chr${chrom}`;
}

/** The full-chrom default context for a chromosome. */
export function defaultContextRange(chrom: string): Locus {
  const length = HG19_CHROM_LENGTHS[chromKey(chrom)] ?? FALLBACK_LENGTH;
  return { chrom, start: 0n, end: length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Adaptation tunables
// ─────────────────────────────────────────────────────────────────────────────

/** Re-fit if the viewport occupies less than this fraction of the context. */
const MIN_SELECTION_FRACTION = 0.02;
/** Re-fit if the viewport occupies more than this fraction of the context. */
const MAX_SELECTION_FRACTION = 0.7;
/** When re-fitting, aim for the selection to be 1 / FIT_RATIO of the bar. */
const FIT_RATIO = 10n;
/** Debounce before re-fitting so an active drag isn't disrupted. */
const ADAPT_DEBOUNCE_MS = 200;

/**
 * Decide whether `ctx` needs to be re-fit for the current `v`, and if so
 * compute the new context. Returns `null` to mean "keep ctx as-is".
 *
 * Pure function — no signal reads. Easy to unit test.
 */
export function adaptContextRange(
  v: { chrom: string; start: bigint; end: bigint },
  ctx: Locus,
  fullChrom: Locus,
): Locus | null {
  // 1. Chrom mismatch → snap to full chrom of the new chrom.
  if (v.chrom !== ctx.chrom) {
    return ctx === fullChrom ? null : fullChrom;
  }

  const viewportSpan = v.end - v.start;
  if (viewportSpan <= 0n) return null;

  const contextSpan = ctx.end - ctx.start;
  if (contextSpan <= 0n) return fullChrom;

  // 2. Viewport entirely outside ctx (e.g. user jumped far away) → re-fit.
  const outOfBounds = v.start < ctx.start || v.end > ctx.end;

  // 3. Selection too narrow or too wide on the bar → re-fit.
  const fraction = Number(viewportSpan) / Number(contextSpan);
  const badFraction =
    fraction < MIN_SELECTION_FRACTION || fraction > MAX_SELECTION_FRACTION;

  if (!outOfBounds && !badFraction) return null;

  // Aim for the target context span. Clamp to the chromosome.
  const targetSpan = viewportSpan * FIT_RATIO;
  const fullSpan = fullChrom.end - fullChrom.start;
  if (targetSpan >= fullSpan) {
    return ctx.start === fullChrom.start && ctx.end === fullChrom.end ? null : fullChrom;
  }

  const viewportMid = v.start + viewportSpan / 2n;
  const half = targetSpan / 2n;
  let start = viewportMid > half ? viewportMid - half : 0n;
  let end = start + targetSpan;
  if (end > fullChrom.end) {
    end = fullChrom.end;
    start = end > targetSpan ? end - targetSpan : fullChrom.start;
  }
  if (start < fullChrom.start) start = fullChrom.start;

  if (start === ctx.start && end === ctx.end) return null;
  return { chrom: v.chrom, start, end };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal + reactive effect
// ─────────────────────────────────────────────────────────────────────────────

const [contextRange, setContextRange] = createSignal<Locus>(
  defaultContextRange('chr20'),
  {
    equals: (a, b) => a.chrom === b.chrom && a.start === b.start && a.end === b.end,
  },
);

let adaptTimer: ReturnType<typeof setTimeout> | null = null;

createEffect(() => {
  const v = viewport();
  const current = contextRange();

  // Chrom change is immediate — no debounce, no waiting.
  if (current.chrom !== v.chrom) {
    if (adaptTimer !== null) {
      clearTimeout(adaptTimer);
      adaptTimer = null;
    }
    setContextRange(defaultContextRange(v.chrom));
    return;
  }

  // Same chrom: debounce re-fit so an active drag isn't disrupted.
  if (adaptTimer !== null) clearTimeout(adaptTimer);
  adaptTimer = setTimeout(() => {
    adaptTimer = null;
    const c = contextRange();
    const vNow = viewport();
    if (c.chrom !== vNow.chrom) return; // race with chrom change
    const next = adaptContextRange(vNow, c, defaultContextRange(vNow.chrom));
    if (next !== null) setContextRange(next);
  }, ADAPT_DEBOUNCE_MS);
});

onCleanup(() => {
  if (adaptTimer !== null) {
    clearTimeout(adaptTimer);
    adaptTimer = null;
  }
});

export { contextRange, setContextRange };
