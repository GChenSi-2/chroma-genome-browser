import type { Viewport } from './types';

/**
 * Viewport actions — pure functions that compute the *next* viewport from
 * the current one. No I/O, no signals, no Solid context.
 *
 * Ownership: agent-ui (L3). Called from L4 shortcut handlers; the actual
 * `setViewport` write happens at the call-site so these helpers stay
 * trivially testable.
 *
 * Invariants (enforced by `clampViewport`):
 *   - start ≥ 0
 *   - end − start ≥ MIN_SPAN  (no infinite zoom-in)
 *   - end − start ≤ MAX_SPAN  (no zoom-out past 1Gb; chrom-length lookup
 *     comes in Phase 2)
 */

/** Minimum addressable span. 10 bp keeps single-base mode reachable. */
export const MIN_SPAN = 10n;

/** Maximum span — 1 Gb, conservatively below human-genome chrom1 length. */
export const MAX_SPAN = 1_000_000_000n;

/**
 * Clamp viewport to invariants. start ≥ 0; MIN_SPAN ≤ span ≤ MAX_SPAN.
 * Preserves the midpoint when the span has to be resized.
 */
export function clampViewport(v: Viewport): Viewport {
  let start = v.start;
  let end = v.end;

  // Ensure positive span first — defend against caller passing end < start.
  if (end <= start) {
    end = start + MIN_SPAN;
  }

  let span = end - start;

  if (span < MIN_SPAN) {
    const mid = start + span / 2n;
    start = mid - MIN_SPAN / 2n;
    end = start + MIN_SPAN;
    span = MIN_SPAN;
  } else if (span > MAX_SPAN) {
    const mid = start + span / 2n;
    start = mid - MAX_SPAN / 2n;
    end = start + MAX_SPAN;
    span = MAX_SPAN;
  }

  if (start < 0n) {
    end = end - start; // shift right by `-start`
    start = 0n;
  }

  if (start === v.start && end === v.end) return v;
  return { ...v, start, end };
}

/**
 * Pan by a fraction of the current span. Positive fraction moves the view
 * to the right (genomic + direction), negative to the left.
 */
export function panBy(v: Viewport, fractionOfSpan: number): Viewport {
  const span = v.end - v.start;
  // Round in Number space; span × fraction stays well within safe int range
  // for any sane viewport (span ≤ 1e9, |fraction| usually < 2).
  const delta = BigInt(Math.round(Number(span) * fractionOfSpan));
  if (delta === 0n) return v;
  return clampViewport({ ...v, start: v.start + delta, end: v.end + delta });
}

/**
 * Zoom in / out around a pivot pixel. `factor < 1` zooms in (span shrinks),
 * `factor > 1` zooms out. `pivotPx` defaults to the centre of the viewport;
 * the genomic position under the pivot pixel is preserved across the zoom.
 */
export function zoomBy(
  v: Viewport,
  factor: number,
  pivotPx?: number,
): Viewport {
  if (factor <= 0 || !Number.isFinite(factor)) return v;
  if (factor === 1) return v;

  const pxWidth = v.pxWidth > 0 ? v.pxWidth : 1;
  const pivot = pivotPx ?? pxWidth / 2;
  // Clamp pivot to [0, pxWidth] so off-canvas wheel events don't fling.
  const clampedPivot = Math.max(0, Math.min(pxWidth, pivot));

  const span = v.end - v.start;
  const spanNum = Number(span);

  // Genomic position under the pivot pixel, in Number space (safe: span
  // ≤ 1e9, pivot/pxWidth ∈ [0,1] so the product stays below 1e9).
  const pivotFrac = clampedPivot / pxWidth;
  const pivotOffsetNum = spanNum * pivotFrac;
  const pivotBp = v.start + BigInt(Math.round(pivotOffsetNum));

  // New span — rounded toward the floor, but enforce MIN_SPAN here so the
  // clamp step doesn't have to re-center.
  let newSpanNum = Math.max(Math.round(spanNum * factor), Number(MIN_SPAN));
  if (newSpanNum > Number(MAX_SPAN)) newSpanNum = Number(MAX_SPAN);
  const newSpan = BigInt(newSpanNum);

  const newPivotOffsetNum = newSpanNum * pivotFrac;
  let newStart = pivotBp - BigInt(Math.round(newPivotOffsetNum));
  // Avoid double-rounding drift: ensure end - start == newSpan exactly.
  let newEnd = newStart + newSpan;

  if (newStart < 0n) {
    newEnd = newEnd - newStart;
    newStart = 0n;
  }

  return clampViewport({ ...v, start: newStart, end: newEnd });
}

/**
 * Jump to an explicit locus while preserving the canvas dimensions. Used by
 * the go-to prompt and the URL-hash rehydrate path.
 */
export function jumpTo(
  v: Viewport,
  chrom: string,
  start: bigint,
  end: bigint,
): Viewport {
  return clampViewport({
    ...v,
    chrom,
    start,
    end,
  });
}
