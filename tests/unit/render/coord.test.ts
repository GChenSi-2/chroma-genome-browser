import { describe, it, expect, vi } from 'vitest';
import {
  toRelative,
  buildViewMatrix,
  semanticLevel,
  pxToGenomic,
  genomicToPx,
} from '~render/coord';
import type { Viewport } from '~state/types';

const VP = (start: bigint, end: bigint): Viewport => ({
  chrom: 'chr1',
  start,
  end,
  pxWidth: 1200,
  pxHeight: 600,
});

describe('coord precision', () => {
  it('preserves precision at chr1 end (~248Mb)', () => {
    const origin = 247_000_000n;
    const pos = 247_000_001n;
    expect(toRelative(pos, origin)).toBe(1);
  });

  it('preserves precision at 1bp resolution near 1e9', () => {
    const origin = 1_000_000_000n;
    const pos = 1_000_000_005n;
    expect(toRelative(pos, origin)).toBe(5);
  });

  it('preserves precision at chrom-scale offsets (~1.5e9)', () => {
    // Locks bigint subtraction: tiny delta survives the cast even when
    // both endpoints exceed Float32's 2^24 integer-precision boundary.
    expect(toRelative(1_500_000_000n, 1_499_999_990n)).toBe(10);
  });

  it('warns but does not throw on huge delta', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    toRelative(2_000_000_000n, 0n);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('view matrix', () => {
  it('maps relative bp 0 to NDC -1 in x', () => {
    const m = buildViewMatrix(VP(0n, 1_000_000n), 8);
    // Apply matrix to (0, 0, 1) — should give x = -1
    // Result.x = m[0]*0 + m[3]*0 + m[6]*1 = m[6]
    expect(m[6]).toBeCloseTo(-1);
  });

  it('maps relative bp = span to NDC +1 in x', () => {
    const span = 1_000_000;
    const m = buildViewMatrix(VP(0n, BigInt(span)), 8);
    // Result.x = m[0]*span + m[6] = +1
    const x = m[0]! * span + m[6]!;
    expect(x).toBeCloseTo(1);
  });

  it('y axis is flipped (top-down)', () => {
    const m = buildViewMatrix(VP(0n, 1000n), 10, 0);
    // sy < 0 means top-down
    expect(m[4]).toBeLessThan(0);
  });
});

describe('semantic level', () => {
  // VP() uses pxWidth = 1200. basePixelWidth = 1200 / span.
  // Thresholds: < 0.001 overview, < 0.05 coverage, < 4 pileup, else base.
  // (Spike's table mislabeled the 10M and 100K rows; fixed here to match
  //  the function's actual boundaries — see report.)
  it.each([
    [1n, 1_000_000_000n, 'overview'], // bpw 1.2e-6
    [1n, 100_000_000n, 'overview'],   // bpw 1.2e-5
    [1n, 10_000_000n, 'overview'],    // bpw 1.2e-4
    [1n, 1_000_000n, 'coverage'],     // bpw 1.2e-3
    [1n, 100_000n, 'coverage'],       // bpw 1.2e-2
    [1n, 1_000n, 'pileup'],           // bpw 1.2
    [1n, 100n, 'base'],               // bpw 12
  ] as const)('start=%s end=%s -> %s', (start, end, expected) => {
    expect(semanticLevel(VP(start, end))).toBe(expected);
  });
});

describe('px <-> genomic roundtrip', () => {
  it('roundtrips within 1bp tolerance', () => {
    const vp = VP(1_000_000n, 1_001_200n); // 1bp/px
    for (const px of [0, 100, 600, 1199]) {
      const pos = pxToGenomic(px, vp);
      const backPx = genomicToPx(pos, vp);
      expect(Math.abs(backPx - px)).toBeLessThanOrEqual(1);
    }
  });
});
