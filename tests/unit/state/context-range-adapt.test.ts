import { describe, it, expect } from 'vitest';
import { adaptContextRange, defaultContextRange } from '~state/context-range';
import type { Locus } from '~state/types';

const chr20Full = defaultContextRange('chr20'); // 0..63_025_520

const vp = (start: bigint, end: bigint, chrom: string = 'chr20') => ({
  chrom,
  start,
  end,
});

describe('adaptContextRange', () => {
  it('returns null when viewport occupies a comfortable fraction (~10%)', () => {
    // 10 % of 100 Mb context = 10 Mb viewport.
    const ctx: Locus = { chrom: 'chr20', start: 0n, end: 100_000_000n };
    const v = vp(10_000_000n, 20_000_000n);
    expect(adaptContextRange(v, ctx, chr20Full)).toBeNull();
  });

  it('re-fits when the selection would be < 2 % of the bar', () => {
    // 10 kb viewport in a 60 Mb context = 0.017 %  Etoo narrow to grab.
    const v = vp(10_000_000n, 10_010_000n);
    const next = adaptContextRange(v, chr20Full, chr20Full);
    expect(next).not.toBeNull();
    expect(next!.chrom).toBe('chr20');
    // 10 kb ÁEFIT_RATIO (10) = 100 kb context, centred on 10,005,000.
    expect(Number(next!.end - next!.start)).toBe(100_000);
    const mid = (next!.start + next!.end) / 2n;
    expect(Number(mid - 10_005_000n)).toBeLessThanOrEqual(1);
  });

  it('re-fits when the selection would cover > 70 % of the bar', () => {
    // 9 Mb viewport, current ctx 10 Mb ↁEfraction = 0.9 ↁEtoo wide.
    const ctx: Locus = { chrom: 'chr20', start: 10_000_000n, end: 20_000_000n };
    const v = vp(10_500_000n, 19_500_000n);
    const next = adaptContextRange(v, ctx, chr20Full);
    expect(next).not.toBeNull();
    // 9 Mb ÁE10 = 90 Mb requested, but chr20 only has 63 Mb ↁEsnaps to full.
    expect(next!.start).toBe(0n);
    expect(next!.end).toBe(63_025_520n);
  });

  it('re-fits when viewport scrolled outside ctx (drag/jump far away)', () => {
    const ctx: Locus = { chrom: 'chr20', start: 10_000_000n, end: 11_000_000n };
    const v = vp(40_000_000n, 40_010_000n);
    const next = adaptContextRange(v, ctx, chr20Full);
    expect(next).not.toBeNull();
    // Re-fit centred on the new position.
    expect(Number(next!.start)).toBeLessThan(40_005_000);
    expect(Number(next!.end)).toBeGreaterThan(40_005_000);
  });

  it('snaps to full chrom when target context exceeds chrom length', () => {
    // 10 Mb viewport ÁE10 = 100 Mb context, but chr20 is only 63 Mb.
    const ctx: Locus = { chrom: 'chr20', start: 0n, end: 1_000_000n };
    const v = vp(20_000_000n, 30_000_000n);
    const next = adaptContextRange(v, ctx, chr20Full);
    expect(next).not.toBeNull();
    expect(next!.start).toBe(0n);
    expect(next!.end).toBe(63_025_520n);
  });

  it('clamps the re-fit context against the chromosome start', () => {
    // Tiny viewport near the start of the chrom.
    const v = vp(500n, 1500n);
    const next = adaptContextRange(v, chr20Full, chr20Full);
    expect(next).not.toBeNull();
    expect(next!.start).toBe(0n);
  });

  it('clamps the re-fit context against the chromosome end', () => {
    // Viewport in the last 50 kb of chr20 (10 kb wide) -> target context is
    // 100 kb but bumps against the chrom ceiling.
    const v = vp(64_400_000n, 64_410_000n);
    const next = adaptContextRange(v, chr20Full, chr20Full);
    expect(next).not.toBeNull();
    expect(next!.end).toBe(63_025_520n);
  });

  it('returns full chrom when chrom mismatches', () => {
    const ctx: Locus = { chrom: 'chr1', start: 0n, end: 1_000_000n };
    const v = vp(10n, 20n, 'chr20');
    const next = adaptContextRange(v, ctx, chr20Full);
    expect(next).not.toBeNull();
    expect(next!.chrom).toBe('chr20');
    expect(next!.start).toBe(0n);
    expect(next!.end).toBe(63_025_520n);
  });

  it('is a no-op for zero-span viewport (defensive)', () => {
    const v = vp(10_000_000n, 10_000_000n);
    expect(adaptContextRange(v, chr20Full, chr20Full)).toBeNull();
  });
});
