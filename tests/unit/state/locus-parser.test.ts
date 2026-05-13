import { describe, it, expect } from 'vitest';
import { parseLocus, formatLocus } from '~state/locus-parser';

describe('parseLocus — accepted inputs', () => {
  it('chr1:1,000,000-2,000,000 (comma thousands)', () => {
    const result = parseLocus('chr1:1,000,000-2,000,000');
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        locus: { chrom: 'chr1', start: 1_000_000n, end: 2_000_000n },
      }),
    );
  });

  it('chr1:1000000-2000000 (bare digits)', () => {
    const result = parseLocus('chr1:1000000-2000000');
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        locus: { chrom: 'chr1', start: 1_000_000n, end: 2_000_000n },
      }),
    );
  });

  it('chr1:1000000 (single position → 1bp range)', () => {
    const result = parseLocus('chr1:1000000');
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        locus: { chrom: 'chr1', start: 1_000_000n, end: 1_000_001n },
      }),
    );
  });

  it('1:1M-2M (bare chrom prepends chr; M=1e6)', () => {
    const result = parseLocus('1:1M-2M');
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        locus: { chrom: 'chr1', start: 1_000_000n, end: 2_000_000n },
      }),
    );
  });

  it('chrX:1-1k (k=1e3, case insensitive)', () => {
    const result = parseLocus('chrX:1-1k');
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        locus: { chrom: 'chrX', start: 1n, end: 1_000n },
      }),
    );
  });

  it('chr20:30M-31m (mixed case suffix)', () => {
    const result = parseLocus('chr20:30M-31m');
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        locus: { chrom: 'chr20', start: 30_000_000n, end: 31_000_000n },
      }),
    );
  });

  it('MT:1-100 (non-numeric chrom names pass through)', () => {
    const result = parseLocus('MT:1-100');
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        locus: { chrom: 'MT', start: 1n, end: 100n },
      }),
    );
  });

  it('  chr3:1,500-2,500   (trims whitespace)', () => {
    const result = parseLocus('  chr3:1,500-2,500   ');
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        locus: { chrom: 'chr3', start: 1_500n, end: 2_500n },
      }),
    );
  });

  it('Y:1-1G (case insensitive g suffix, bare chrom)', () => {
    const result = parseLocus('Y:1-1G');
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        locus: { chrom: 'chrY', start: 1n, end: 1_000_000_000n },
      }),
    );
  });

  it('chr1:5-5 (zero-length range OK; end == start is not < start)', () => {
    const result = parseLocus('chr1:5-5');
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        locus: { chrom: 'chr1', start: 5n, end: 5n },
      }),
    );
  });
});

describe('parseLocus — rejected inputs', () => {
  it('missing colon', () => {
    const result = parseLocus('chr1 1000-2000');
    expect(result.ok).toBe(false);
  });

  it('end < start', () => {
    const result = parseLocus('chr1:2000-1000');
    expect(result.ok).toBe(false);
  });

  it('negative start', () => {
    const result = parseLocus('chr1:-100-200');
    expect(result.ok).toBe(false);
  });

  it('negative end (after dash)', () => {
    const result = parseLocus('chr1:100--200');
    expect(result.ok).toBe(false);
  });

  it('non-numeric range', () => {
    const result = parseLocus('chr1:abc-def');
    expect(result.ok).toBe(false);
  });

  it('unsupported suffix (t)', () => {
    const result = parseLocus('chr1:1t-2t');
    expect(result.ok).toBe(false);
  });

  it('empty chrom', () => {
    const result = parseLocus(':1000-2000');
    expect(result.ok).toBe(false);
  });

  it('empty string', () => {
    const result = parseLocus('');
    expect(result.ok).toBe(false);
  });

  it('whitespace-only', () => {
    const result = parseLocus('     ');
    expect(result.ok).toBe(false);
  });

  it('missing end after dash', () => {
    const result = parseLocus('chr1:1000-');
    expect(result.ok).toBe(false);
  });
});

describe('formatLocus', () => {
  it('formats with comma thousands', () => {
    expect(formatLocus({ chrom: 'chr1', start: 1_000_000n, end: 2_000_000n })).toBe(
      'chr1:1,000,000-2,000,000',
    );
  });

  it('handles small numbers', () => {
    expect(formatLocus({ chrom: 'chrX', start: 1n, end: 1000n })).toBe('chrX:1-1,000');
  });

  it('round-trips with parseLocus', () => {
    const original = { chrom: 'chr20', start: 30_000_000n, end: 31_500_000n };
    const formatted = formatLocus(original);
    const reparsed = parseLocus(formatted);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.locus).toEqual(original);
    }
  });
});
