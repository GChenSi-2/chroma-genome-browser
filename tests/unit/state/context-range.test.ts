import { describe, it, expect } from 'vitest';
import { defaultContextRange } from '~state/context-range';

// Until a reference .fai loads (via App.tsx onMount), the active assembly
// is the built-in hg19 / GRCh37 fallback in `~state/assembly`. These tests
// pin against those fallback values; the hot-swap behaviour is exercised
// separately in `assembly.test.ts`.

describe('defaultContextRange', () => {
  it.each([
    ['chr1', 249_250_621n],
    ['chr20', 63_025_520n],
    ['chrX', 155_270_560n],
    ['chrM', 16_571n],
  ] as const)('returns the active-assembly length for %s', (chrom, expected) => {
    const r = defaultContextRange(chrom);
    expect(r.chrom).toBe(chrom);
    expect(r.start).toBe(0n);
    expect(r.end).toBe(expected);
  });

  it.each([
    ['1', 249_250_621n], // bare chrom name → normalized to chr1
    ['20', 63_025_520n],
    ['X', 155_270_560n],
  ] as const)('normalizes bare chrom %s to chr-prefixed table lookup', (chrom, expected) => {
    const r = defaultContextRange(chrom);
    expect(r.chrom).toBe(chrom); // preserves caller's chrom name
    expect(r.end).toBe(expected);
  });

  it('falls back for unknown contigs', () => {
    const r = defaultContextRange('chrUn_gl000200');
    expect(r.start).toBe(0n);
    expect(r.end).toBe(250_000_000n);
  });
});
