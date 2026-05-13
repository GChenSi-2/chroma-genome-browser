import { describe, it, expect } from 'vitest';
import {
  panBy,
  zoomBy,
  jumpTo,
  clampViewport,
  MIN_SPAN,
  MAX_SPAN,
} from '~state/viewport-actions';
import type { Viewport } from '~state/types';

const base: Viewport = {
  chrom: 'chr1',
  start: 1_000_000n,
  end: 2_000_000n, // 1Mb span
  pxWidth: 1000,
  pxHeight: 600,
};

describe('panBy', () => {
  it('shifts right by a positive fraction of span', () => {
    const next = panBy(base, 0.2);
    // 20% of 1Mb = 200_000
    expect(next.start).toBe(1_200_000n);
    expect(next.end).toBe(2_200_000n);
    expect(next.chrom).toBe('chr1');
    expect(next.pxWidth).toBe(1000);
  });

  it('shifts left by a negative fraction', () => {
    const next = panBy(base, -0.5);
    expect(next.start).toBe(500_000n);
    expect(next.end).toBe(1_500_000n);
  });

  it('preserves the span exactly', () => {
    const next = panBy(base, 0.37);
    expect(next.end - next.start).toBe(base.end - base.start);
  });

  it('returns the same viewport when fraction rounds to zero', () => {
    const next = panBy(base, 0);
    expect(next).toBe(base);
  });

  it('clamps start at 0 when panning past the chromosome edge', () => {
    const next = panBy(base, -10);
    expect(next.start).toBe(0n);
    // Span must still equal original.
    expect(next.end - next.start).toBe(base.end - base.start);
  });
});

describe('zoomBy — centered', () => {
  it('zooms in by factor 0.5 keeping the midpoint fixed', () => {
    const next = zoomBy(base, 0.5);
    const oldMid = base.start + (base.end - base.start) / 2n;
    const newMid = next.start + (next.end - next.start) / 2n;
    expect(newMid).toBe(oldMid);
    expect(next.end - next.start).toBe(500_000n);
  });

  it('zooms out by factor 2 keeping the midpoint fixed', () => {
    const next = zoomBy(base, 2);
    const oldMid = base.start + (base.end - base.start) / 2n;
    const newMid = next.start + (next.end - next.start) / 2n;
    expect(newMid).toBe(oldMid);
    expect(next.end - next.start).toBe(2_000_000n);
  });
});

describe('zoomBy — pivot not at center', () => {
  it('zooms in around a pivot near the left edge, preserving the bp under the pivot', () => {
    // pivot at 100px of 1000 → 10% from left → genomic bp ~1_100_000.
    const pivotPx = 100;
    const factor = 0.5;
    const next = zoomBy(base, factor, pivotPx);

    const pivotFrac = pivotPx / base.pxWidth;
    const oldSpan = Number(base.end - base.start);
    const oldPivotBp = base.start + BigInt(Math.round(oldSpan * pivotFrac));

    const newSpan = Number(next.end - next.start);
    const newPivotBp = next.start + BigInt(Math.round(newSpan * pivotFrac));

    // Same bp under the pivot pixel (within rounding noise).
    expect(newPivotBp - oldPivotBp).toBeLessThanOrEqual(1n);
    expect(oldPivotBp - newPivotBp).toBeLessThanOrEqual(1n);
    expect(next.end - next.start).toBe(500_000n);
  });

  it('zooms in around a pivot near the right edge', () => {
    const pivotPx = 900;
    const next = zoomBy(base, 0.5, pivotPx);
    // Pivot at 90% of [1Mb, 2Mb] is bp 1_900_000.
    // New span 500_000 with pivot still at 90% → end ≈ 1_950_000.
    expect(next.end - next.start).toBe(500_000n);
    const pivotBp = 1_900_000n;
    // Same bp under the pivot pixel before/after.
    const newSpan = next.end - next.start;
    const newPivotBp = next.start + (newSpan * 900n) / 1000n;
    const drift = newPivotBp - pivotBp;
    expect(drift).toBeLessThanOrEqual(1n);
    expect(drift).toBeGreaterThanOrEqual(-1n);
  });
});

describe('zoomBy — limits', () => {
  it('clamps zoom-in at MIN_SPAN', () => {
    const next = zoomBy(base, 0.000_000_1);
    expect(next.end - next.start).toBe(MIN_SPAN);
  });

  it('clamps zoom-out at MAX_SPAN', () => {
    const next = zoomBy(base, 100_000);
    expect(next.end - next.start).toBe(MAX_SPAN);
  });

  it('returns input unchanged for factor === 1', () => {
    expect(zoomBy(base, 1)).toBe(base);
  });

  it('rejects non-finite or non-positive factors', () => {
    expect(zoomBy(base, 0)).toBe(base);
    expect(zoomBy(base, -1)).toBe(base);
    expect(zoomBy(base, Number.NaN)).toBe(base);
    expect(zoomBy(base, Number.POSITIVE_INFINITY)).toBe(base);
  });
});

describe('clampViewport', () => {
  it('shifts a negative-start viewport so start === 0', () => {
    const next = clampViewport({ ...base, start: -100n, end: 999_900n });
    expect(next.start).toBe(0n);
    expect(next.end).toBe(1_000_000n);
  });

  it('enforces MIN_SPAN when caller asks for too tight a window', () => {
    const next = clampViewport({ ...base, start: 1_000_000n, end: 1_000_001n });
    expect(next.end - next.start).toBe(MIN_SPAN);
  });

  it('enforces MAX_SPAN when caller asks for too wide a window', () => {
    const next = clampViewport({ ...base, start: 0n, end: 5_000_000_000n });
    expect(next.end - next.start).toBe(MAX_SPAN);
  });

  it('returns the same reference when already in range', () => {
    expect(clampViewport(base)).toBe(base);
  });
});

describe('jumpTo', () => {
  it('moves to a new chrom + range, preserving canvas dims', () => {
    const next = jumpTo(base, 'chr20', 50_000n, 150_000n);
    expect(next.chrom).toBe('chr20');
    expect(next.start).toBe(50_000n);
    expect(next.end).toBe(150_000n);
    expect(next.pxWidth).toBe(base.pxWidth);
    expect(next.pxHeight).toBe(base.pxHeight);
  });

  it('clamps when the requested range is too tight', () => {
    const next = jumpTo(base, 'chr20', 100n, 101n);
    expect(next.end - next.start).toBe(MIN_SPAN);
  });
});
