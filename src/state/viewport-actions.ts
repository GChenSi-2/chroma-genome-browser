import type { Locus, Viewport } from './types';

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

// ─────────────────────────────────────────────────────────────────────────────
// Context-aware variants — clamp inside a Locus "domain" instead of the global
// [0, MAX_SPAN] envelope. Used by RangeSelectionBar and Shift+wheel pan.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clamp the viewport so its [start, end) sits entirely inside `range`,
 * preserving span length. If the viewport span exceeds the range span,
 * shrink to fit (start = range.start, end = range.end).
 *
 * Off-chromosome viewport is returned unchanged — caller decides whether
 * to jump to the right chrom.
 */
export function clampViewportToContext(v: Viewport, range: Locus): Viewport {
  if (v.chrom !== range.chrom) return v;

  const span = v.end - v.start;
  const rangeSpan = range.end - range.start;

  let start = v.start;
  let end = v.end;

  if (span >= rangeSpan) {
    start = range.start;
    end = range.end;
  } else {
    if (start < range.start) {
      start = range.start;
      end = start + span;
    }
    if (end > range.end) {
      end = range.end;
      start = end - span;
    }
  }

  if (start === v.start && end === v.end) return v;
  return { ...v, start, end };
}

/**
 * Pan the viewport by an explicit bp delta, clamped to a context range.
 * Returns the input unchanged when delta is 0 or the move is fully clipped.
 */
export function panBpWithin(v: Viewport, deltaBp: bigint, range: Locus): Viewport {
  if (deltaBp === 0n) return v;
  return clampViewportToContext(
    { ...v, start: v.start + deltaBp, end: v.end + deltaBp },
    range,
  );
}

/**
 * Move ONE edge of the viewport. Used by RangeSelectionBar's edge resize.
 * The opposite edge stays put; the moving edge is clamped against both the
 * context range AND a minimum-span floor so the viewport can't collapse.
 *
 * `side === 'start'`: new start position; clamped to [range.start, end-MIN_SPAN].
 * `side === 'end'`:   new end position;   clamped to [start+MIN_SPAN, range.end].
 */
export function resizeViewportEdge(
  v: Viewport,
  side: 'start' | 'end',
  newPos: bigint,
  range: Locus,
): Viewport {
  if (v.chrom !== range.chrom) return v;
  if (side === 'start') {
    const min = range.start;
    const max = v.end - MIN_SPAN;
    let start = newPos < min ? min : newPos > max ? max : newPos;
    if (start === v.start) return v;
    return clampViewportToContext({ ...v, start }, range);
  }
  const min = v.start + MIN_SPAN;
  const max = range.end;
  let end = newPos < min ? min : newPos > max ? max : newPos;
  if (end === v.end) return v;
  return clampViewportToContext({ ...v, end }, range);
}

/**
 * Set BOTH edges at once. Used by RangeSelectionBar's drag-to-create.
 * The smaller value becomes start, larger becomes end; a MIN_SPAN floor is
 * enforced and the result is clamped to the context range.
 */
export function setViewportSpan(
  v: Viewport,
  a: bigint,
  b: bigint,
  range: Locus,
): Viewport {
  if (v.chrom !== range.chrom) return v;
  let start = a < b ? a : b;
  let end = a < b ? b : a;
  if (end - start < MIN_SPAN) end = start + MIN_SPAN;
  return clampViewportToContext({ ...v, start, end }, range);
}
