import { describe, it, expect } from 'vitest';
import {
  toRelative,
  buildViewMatrix,
  basePixelWidth,
  semanticLevel,
  pxToGenomic,
  genomicToPx,
  type Viewport,
} from './index';

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
  it.each([
    [1n, 1_000_000_000n, 'overview'],
    [1n, 100_000_000n, 'overview'],
    [1n, 10_000_000n, 'coverage'],
    [1n, 1_000_000n, 'coverage'],
    [1n, 100_000n, 'pileup'],
    [1n, 1_000n, 'pileup'],
    [1n, 100n, 'base'],
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

// vitest globals fallback for environments without auto-globals
declare const vi: any;
