import { describe, it, expect } from 'vitest';
import { defaultContextRange } from '~state/context-range';

describe('defaultContextRange', () => {
  it.each([
    ['chr1', 248_956_422n],
    ['chr20', 64_444_167n],
    ['chrX', 156_040_895n],
    ['chrM', 16_569n],
  ] as const)('returns GRCh38 length for %s', (chrom, expected) => {
    const r = defaultContextRange(chrom);
    expect(r.chrom).toBe(chrom);
    expect(r.start).toBe(0n);
    expect(r.end).toBe(expected);
  });

  it.each([
    ['1', 248_956_422n], // bare chrom name → normalized to chr1
    ['20', 64_444_167n],
    ['X', 156_040_895n],
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
