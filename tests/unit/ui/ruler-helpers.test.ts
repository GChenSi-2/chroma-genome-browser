import { describe, it, expect } from 'vitest';
import {
  niceInterval,
  computeTicks,
  formatTickPosition,
  formatSpan,
  formatPosition,
} from '~/ui/components/ruler-helpers';

describe('niceInterval', () => {
  it.each([
    // span, targetCount, expectedInterval
    [64_400_000, 7, 10_000_000],   // chr20: 7 ticks ⇒ 10 Mb step
    [200_000_000, 5, 50_000_000],  // chr1-ish
    [100_000, 5, 20_000],          // 100 kb local
    [10_000, 5, 2_000],            // 10 kb local
    [50, 5, 10],                   // 50 bp deep zoom
    [1_000, 4, 200],               // 1 kb
  ])('span=%i target=%i ⇒ interval=%i', (span, target, want) => {
    expect(niceInterval(span, target)).toBe(want);
  });

  it('returns 1 for degenerate inputs', () => {
    expect(niceInterval(0)).toBe(1);
    expect(niceInterval(-5)).toBe(1);
    expect(niceInterval(100, 0)).toBe(1);
  });
});

describe('formatTickPosition', () => {
  it.each([
    [50_000_000n, 10_000_000, '50 Mb'],
    [50_020_000n, 20_000,     '50.02 Mb'],
    [50_500_000n, 500_000,    '50.5 Mb'],
    [120_000n,    20_000,     '0.12 Mb'],   // 100kb interval ⇒ Mb with 1 dec
    [12_000n,     2_000,      '12 kb'],
    [500n,        100,        '500'],
  ])('bp=%s interval=%i ⇒ "%s"', (bp, interval, want) => {
    expect(formatTickPosition(bp, interval)).toBe(want);
  });
});

describe('computeTicks', () => {
  it('chr20 overview produces 10-Mb ticks at 10..60', () => {
    const ticks = computeTicks(
      { chrom: 'chr20', start: 0n, end: 64_444_167n },
      7,
    );
    expect(ticks.map((t) => Number(t.posBp))).toEqual([
      10_000_000, 20_000_000, 30_000_000, 40_000_000, 50_000_000, 60_000_000,
    ]);
    expect(ticks[0]!.label).toBe('10 Mb');
    expect(ticks[5]!.label).toBe('60 Mb');
    expect(ticks[0]!.fraction).toBeCloseTo(10_000_000 / 64_444_167, 5);
  });

  it('local 100-kb context around 50 Mb produces 20-kb ticks', () => {
    const ticks = computeTicks(
      { chrom: 'chr20', start: 50_000_000n, end: 50_100_000n },
      5,
    );
    // 50_000_000 lands on a multiple of 20_000 → could appear as first tick,
    // but `edgeFraction=0.05` (default) means fraction=0 is dropped.
    const positions = ticks.map((t) => Number(t.posBp));
    expect(positions).toEqual([
      50_020_000, 50_040_000, 50_060_000, 50_080_000,
    ]);
  });

  it('skips ticks strictly inside the edge padding band', () => {
    const ticks = computeTicks(
      { chrom: 'chr20', start: 0n, end: 100n },
      10,
      0.15,
    );
    // span=100, interval=10 → tick fractions 0.1..0.9 in steps of 0.1.
    // edge=0.15 drops fractions <0.15 and >0.85: leaves 0.2..0.8.
    expect(ticks.map((t) => Number(t.posBp))).toEqual([20, 30, 40, 50, 60, 70, 80]);
  });

  it('returns [] on a zero-span domain', () => {
    expect(computeTicks({ chrom: 'chr20', start: 100n, end: 100n })).toEqual([]);
  });
});

describe('formatSpan / formatPosition', () => {
  it.each([
    [50, '50 bp'],
    [999, '999 bp'],
    [1_000, '1.00 kb'],
    [9_999, '10.00 kb'],   // 9.999 rounds up to 10.00
    [10_000, '10.0 kb'],
    [999_999, '1000.0 kb'],
    [1_000_000, '1.00 Mb'],
    [10_500_000, '10.50 Mb'],
  ])('formatSpan(%i) = "%s"', (bp, want) => {
    expect(formatSpan(bp)).toBe(want);
  });

  it.each([
    [500n, '500 bp'],
    [12_345n, '12.3 kb'],
    [50_020_000n, '50.02 Mb'],
  ])('formatPosition(%s) = "%s"', (bp, want) => {
    expect(formatPosition(bp)).toBe(want);
  });
});
