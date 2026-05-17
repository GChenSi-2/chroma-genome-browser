import { describe, it, expect } from 'vitest';
import { _decimateUniform } from '~data/workers/parser.worker';

describe('decimateUniform — cap-at-N read sampling', () => {
  it('returns the input unchanged when count <= want', () => {
    const xs = [1, 2, 3, 4, 5];
    expect(_decimateUniform(xs, 10)).toBe(xs);   // same reference: zero-copy fast path
    expect(_decimateUniform(xs, 5)).toBe(xs);
  });

  it('returns the input unchanged for want <= 0 (safety: no-op)', () => {
    const xs = [1, 2, 3];
    expect(_decimateUniform(xs, 0)).toBe(xs);
    expect(_decimateUniform(xs, -1)).toBe(xs);
  });

  it('keeps exactly `want` items when downsampling', () => {
    const xs = Array.from({ length: 1000 }, (_, i) => i);
    const out = _decimateUniform(xs, 100);
    expect(out).toHaveLength(100);
  });

  it('preserves the source ordering (stable left→right)', () => {
    const xs = Array.from({ length: 1000 }, (_, i) => i);
    const out = _decimateUniform(xs, 50);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!).toBeGreaterThan(out[i - 1]!);
    }
  });

  it('spreads samples uniformly across the source — first ≈ 0, last ≈ end', () => {
    const xs = Array.from({ length: 10_000 }, (_, i) => i);
    const out = _decimateUniform(xs, 100);
    // First sample is index 0; last sample is floor((100-1) * 10_000/100) = 9_900.
    // Confirms reads near the tile's right edge are still represented.
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(9_900);
  });

  it('300× simulation: 18 500 reads → 5 000 samples, even spacing ~3.7', () => {
    const xs = Array.from({ length: 18_500 }, (_, i) => i);
    const out = _decimateUniform(xs, 5_000);
    expect(out.length).toBe(5_000);
    // Consecutive samples should differ by ~floor(18500/5000)=3 or 4 — never 0,
    // never far above ceil. Sanity check the step distribution.
    const diffs = new Set<number>();
    for (let i = 1; i < out.length; i++) {
      diffs.add(out[i]! - out[i - 1]!);
    }
    // With step=3.7 we expect deltas of 3 and 4 (and only those).
    expect([...diffs].sort()).toEqual([3, 4]);
  });
});
