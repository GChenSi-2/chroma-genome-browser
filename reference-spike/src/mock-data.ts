/**
 * Mock BAM data generator for the spike.
 *
 * Generates a plausible-looking ReadTile with N reads distributed
 * across a region. Read lengths follow Illumina-like distribution
 * (mean ~150bp). Strand 50/50. MAPQ skewed toward 60 with a tail.
 *
 * NOT to be copied into product code. agent-data uses real @gmod/bam.
 */

import type { ReadTile } from './render/tracks-render/bam-pileup';
import type { CoverageTile } from './render/tracks-render/bam-coverage';

export interface MockOptions {
  count: number;
  regionStartBp: number;
  regionLengthBp: number;
  readLengthMean?: number;
  readLengthStd?: number;
  /** Deterministic seed for reproducible benchmarks. */
  seed?: number;
}

// Simple LCG for reproducibility
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller for normal distribution
function gaussian(rng: () => number, mean: number, std: number): number {
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * std;
}

export function generateMockReads(opts: MockOptions): ReadTile {
  const {
    count,
    regionStartBp,
    regionLengthBp,
    readLengthMean = 150,
    readLengthStd = 20,
    seed = 42,
  } = opts;

  const rng = mulberry32(seed);

  const starts = new Int32Array(count);
  const startsHi = new Int32Array(count);
  const lengths = new Uint16Array(count);
  const flags = new Uint16Array(count);
  const mapq = new Uint8Array(count);

  // Generate then sort by start (BAM is coord-sorted)
  const tmp: Array<[number, number, number, number]> = [];
  for (let i = 0; i < count; i++) {
    const startBp = regionStartBp + Math.floor(rng() * regionLengthBp);
    const len = Math.max(20, Math.round(gaussian(rng, readLengthMean, readLengthStd)));
    const isReverse = rng() < 0.5;
    // MAPQ distribution: 70% are 60, 15% are 30-59, 10% are 1-29, 5% are 0
    let q: number;
    const qr = rng();
    if (qr < 0.7) q = 60;
    else if (qr < 0.85) q = 30 + Math.floor(rng() * 30);
    else if (qr < 0.95) q = 1 + Math.floor(rng() * 29);
    else q = 0;
    // SAM flags: 0x1 paired, 0x10 reverse strand
    const f = (isReverse ? 0x10 : 0) | 0x1;
    tmp.push([startBp, len, f, q]);
  }
  tmp.sort((a, b) => a[0] - b[0]);

  for (let i = 0; i < count; i++) {
    starts[i] = tmp[i]![0];
    lengths[i] = tmp[i]![1];
    flags[i] = tmp[i]![2];
    mapq[i] = tmp[i]![3];
  }

  return { count, starts, startsHi, lengths, flags, mapq };
}

/**
 * Generate a coverage tile by binning the same mock reads.
 * Useful for matching BAM coverage with raw reads.
 */
export function generateMockCoverage(
  reads: ReadTile,
  regionStartBp: number,
  regionLengthBp: number,
  binWidthBp: number = 100,
): CoverageTile {
  const binCount = Math.ceil(regionLengthBp / binWidthBp);
  const values = new Float32Array(binCount);
  let maxValue = 0;

  for (let i = 0; i < reads.count; i++) {
    const s = reads.starts[i]! - regionStartBp;
    const e = s + reads.lengths[i]!;
    const binS = Math.max(0, Math.floor(s / binWidthBp));
    const binE = Math.min(binCount, Math.ceil(e / binWidthBp));
    for (let b = binS; b < binE; b++) {
      values[b]! += 1;
      if (values[b]! > maxValue) maxValue = values[b]!;
    }
  }

  return {
    binCount,
    startBp: regionStartBp,
    binWidthBp,
    values,
    maxValue,
  };
}
