import { describe, it, expect } from 'vitest';
import {
  policyFor,
  bamBinSizeForSpan,
  bamTileWidthForSpan,
  bigWigBinSizeForSpan,
  bigWigTileWidthForSpan,
  REFERENCE_BIN_SIZE,
  REFERENCE_TILE_WIDTH_BP,
} from '~data/tile-policy';
import type { TrackKind } from '~state/types';

describe('policyFor', () => {
  it.each([
    ['bam', 10_000, 1024, 32_768],
    ['bam', 50_000, 1024, 32_768],
    ['bam', 50_001, 8192, 524_288],
    ['bam', 1_000_000, 8192, 524_288],
    ['bam', 5_000_000, 65_536, 4_194_304],
    ['bam', 100_000_000, 524_288, 33_554_432],

    ['bigwig', 10_000, 1024, 32_768],
    ['bigwig', 5_000_000, 65_536, 4_194_304],

    ['reference', 10_000, 65_536, 65_536],
    ['reference', 1_000_000, 65_536, 65_536],

    // Gene ladder
    ['gene', 10_000, 1024, 65_536],
    ['gene', 50_000, 1024, 65_536],
    ['gene', 500_000, 8192, 1_048_576],
    ['gene', 5_000_000, 65_536, 4_194_304],
  ] as const)(
    'kind=%s span=%i → binSize=%i tileWidthBp=%i',
    (kind, span, binSize, tileWidthBp) => {
      const p = policyFor(kind as TrackKind, span);
      expect(p).not.toBeNull();
      expect(p!.binSize).toBe(binSize);
      expect(p!.tileWidthBp).toBe(tileWidthBp);
    },
  );

  it.each(['vcf', 'bed'] as const)(
    'returns null for unsupported kind %s',
    (kind) => {
      expect(policyFor(kind, 1000)).toBeNull();
    },
  );

  it('every policy has tileWidthBp >= binSize and an integer ratio', () => {
    for (const kind of ['bam', 'bigwig', 'reference', 'gene'] as const) {
      for (const span of [1_000, 100_000, 1_000_000, 100_000_000]) {
        const p = policyFor(kind, span)!;
        expect(p.tileWidthBp).toBeGreaterThanOrEqual(p.binSize);
        expect(p.tileWidthBp % p.binSize).toBe(0);
      }
    }
  });
});

describe('back-compat shims', () => {
  it('bamBinSizeForSpan / bamTileWidthForSpan agree with policyFor', () => {
    const p = policyFor('bam', 500_000)!;
    expect(bamBinSizeForSpan(500_000)).toBe(p.binSize);
    expect(bamTileWidthForSpan(500_000)).toBe(p.tileWidthBp);
  });

  it('bigWig variants agree', () => {
    const p = policyFor('bigwig', 5_000_000)!;
    expect(bigWigBinSizeForSpan(5_000_000)).toBe(p.binSize);
    expect(bigWigTileWidthForSpan(5_000_000)).toBe(p.tileWidthBp);
  });

  it('REFERENCE constants match the reference policy', () => {
    const p = policyFor('reference', 0)!;
    expect(REFERENCE_BIN_SIZE).toBe(p.binSize);
    expect(REFERENCE_TILE_WIDTH_BP).toBe(p.tileWidthBp);
  });
});
