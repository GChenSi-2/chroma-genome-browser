import { describe, it, expect } from 'vitest';
import {
  clampViewportToContext,
  panBpWithin,
  resizeViewportEdge,
  setViewportSpan,
} from '~state/viewport-actions';
import type { Locus, Viewport } from '~state/types';

const RANGE: Locus = { chrom: 'chr20', start: 0n, end: 64_444_167n };

const vp = (start: bigint, end: bigint): Viewport => ({
  chrom: 'chr20',
  start,
  end,
  pxWidth: 1200,
  pxHeight: 600,
});

describe('clampViewportToContext', () => {
  it('passes through a viewport inside the range', () => {
    const v = vp(10_000_000n, 11_000_000n);
    expect(clampViewportToContext(v, RANGE)).toEqual(v);
  });

  it('shifts a viewport that starts below the range floor', () => {
    const v = vp(-500_000n, 500_000n);
    const out = clampViewportToContext(v, RANGE);
    expect(out.start).toBe(0n);
    expect(out.end).toBe(1_000_000n);
  });

  it('shifts a viewport that ends past the range ceiling', () => {
    const v = vp(64_000_000n, 65_000_000n);
    const out = clampViewportToContext(v, RANGE);
    expect(out.end).toBe(64_444_167n);
    expect(out.end - out.start).toBe(1_000_000n);
  });

  it('shrinks a viewport wider than the range to fit exactly', () => {
    const v = vp(-1_000_000n, 100_000_000n);
    const out = clampViewportToContext(v, RANGE);
    expect(out.start).toBe(RANGE.start);
    expect(out.end).toBe(RANGE.end);
  });

  it('returns unchanged when chrom differs', () => {
    const v = { ...vp(10n, 20n), chrom: 'chr1' };
    expect(clampViewportToContext(v, RANGE)).toBe(v);
  });
});

describe('panBpWithin', () => {
  it('moves the viewport when there is room', () => {
    const v = vp(10_000_000n, 11_000_000n);
    const out = panBpWithin(v, 500_000n, RANGE);
    expect(out.start).toBe(10_500_000n);
    expect(out.end).toBe(11_500_000n);
  });

  it('clamps at the right edge', () => {
    const v = vp(62_000_000n, 63_000_000n);
    const out = panBpWithin(v, 5_000_000n, RANGE);
    expect(out.end).toBe(64_444_167n);
    expect(out.end - out.start).toBe(1_000_000n);
  });

  it('clamps at the left edge with negative delta', () => {
    const v = vp(500_000n, 1_500_000n);
    const out = panBpWithin(v, -5_000_000n, RANGE);
    expect(out.start).toBe(0n);
    expect(out.end - out.start).toBe(1_000_000n);
  });

  it('is a no-op for zero delta', () => {
    const v = vp(10_000_000n, 11_000_000n);
    expect(panBpWithin(v, 0n, RANGE)).toBe(v);
  });
});

describe('resizeViewportEdge', () => {
  it('moves the start edge without touching end', () => {
    const v = vp(10_000_000n, 11_000_000n);
    const out = resizeViewportEdge(v, 'start', 10_500_000n, RANGE);
    expect(out.start).toBe(10_500_000n);
    expect(out.end).toBe(11_000_000n);
  });

  it('moves the end edge without touching start', () => {
    const v = vp(10_000_000n, 11_000_000n);
    const out = resizeViewportEdge(v, 'end', 12_000_000n, RANGE);
    expect(out.start).toBe(10_000_000n);
    expect(out.end).toBe(12_000_000n);
  });

  it('refuses to collapse start past end', () => {
    const v = vp(10_000_000n, 11_000_000n);
    // Try to drag start way past end  Eshould clamp to end - MIN_SPAN
    const out = resizeViewportEdge(v, 'start', 99_999_999n, RANGE);
    expect(out.start).toBeLessThan(out.end);
  });

  it('clamps end against range ceiling', () => {
    const v = vp(63_000_000n, 63_010_000n);
    const out = resizeViewportEdge(v, 'end', 999_999_999n, RANGE);
    expect(out.end).toBe(64_444_167n);
  });
});

describe('setViewportSpan', () => {
  it('orders the two coords correctly', () => {
    const v = vp(0n, 1n);
    const out = setViewportSpan(v, 5_000_000n, 3_000_000n, RANGE);
    expect(out.start).toBe(3_000_000n);
    expect(out.end).toBe(5_000_000n);
  });

  it('enforces MIN_SPAN floor when the two coords coincide', () => {
    const v = vp(0n, 1n);
    const out = setViewportSpan(v, 5_000_000n, 5_000_000n, RANGE);
    expect(out.end - out.start).toBeGreaterThanOrEqual(10n);
  });

  it('clamps both edges against the range', () => {
    const v = vp(0n, 1n);
    const out = setViewportSpan(v, -1_000_000n, 999_999_999n, RANGE);
    expect(out.start).toBe(RANGE.start);
    expect(out.end).toBe(RANGE.end);
  });
});
