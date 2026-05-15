import { describe, it, expect } from 'vitest';
import { contextToFraction, fractionToContext } from '~render/coord';

const RANGE = { start: 1_000_000n, end: 2_000_000n };

describe('contextToFraction', () => {
  it('maps endpoints to 0 and 1', () => {
    expect(contextToFraction(1_000_000n, RANGE)).toBeCloseTo(0);
    expect(contextToFraction(2_000_000n, RANGE)).toBeCloseTo(1);
  });

  it('maps midpoint to 0.5', () => {
    expect(contextToFraction(1_500_000n, RANGE)).toBeCloseTo(0.5);
  });

  it('clamps below-range to 0', () => {
    expect(contextToFraction(0n, RANGE)).toBe(0);
    expect(contextToFraction(-1000n, RANGE)).toBe(0);
  });

  it('clamps above-range to 1', () => {
    expect(contextToFraction(3_000_000n, RANGE)).toBe(1);
  });

  it('handles zero-span range without dividing by zero', () => {
    const collapsed = { start: 500n, end: 500n };
    expect(contextToFraction(500n, collapsed)).toBe(0);
  });
});

describe('fractionToContext', () => {
  it('maps 0 and 1 to endpoints', () => {
    expect(fractionToContext(0, RANGE)).toBe(1_000_000n);
    expect(fractionToContext(1, RANGE)).toBe(2_000_000n);
  });

  it('maps 0.5 to midpoint', () => {
    expect(fractionToContext(0.5, RANGE)).toBe(1_500_000n);
  });

  it('clamps fraction to [0, 1]', () => {
    expect(fractionToContext(-0.1, RANGE)).toBe(1_000_000n);
    expect(fractionToContext(1.1, RANGE)).toBe(2_000_000n);
  });
});

describe('contextToFraction / fractionToContext round-trip', () => {
  it.each([1_000_001n, 1_250_000n, 1_750_000n, 1_999_999n])(
    'pos %s round-trips within 1 bp',
    (pos) => {
      const f = contextToFraction(pos, RANGE);
      const back = fractionToContext(f, RANGE);
      const delta = back > pos ? back - pos : pos - back;
      expect(delta <= 1n).toBe(true);
    },
  );
});

describe('contextToFraction at genome scale', () => {
  it('chr1 length range survives precision', () => {
    const chr1 = { start: 0n, end: 249_250_621n };
    expect(contextToFraction(124_625_310n, chr1)).toBeCloseTo(0.5, 4);
    expect(contextToFraction(249_250_621n, chr1)).toBe(1);
  });
});
