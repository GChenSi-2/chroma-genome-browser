/**
 * BAM pileup CPU-side micro-benchmark.
 *
 * Only the CPU portion is benchmarked here — `assignPileupRows` and the
 * instance packing helper. GL upload + draw is measured separately by the
 * Playwright bench harness against the demo page (BENCHMARKS §3.3).
 *
 * Run via `pnpm bench`. This file is excluded from `pnpm test`
 * (see `vitest.config.ts → test.exclude → 'tests/bench/**'`).
 */

import { bench, describe } from 'vitest';
import { assignPileupRows } from '~render/tracks-render/bam-pileup';
import type { ReadTile } from '~state/types';

function makeMockTile(count: number, spanBp: number): ReadTile {
  const starts = new Int32Array(count);
  const startsHi = new Int32Array(count);
  const lengths = new Uint16Array(count);
  const flags = new Uint16Array(count);
  const mapq = new Uint8Array(count);
  // Pseudo-random but deterministic.
  let seed = 1;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) | 0;
    return ((seed >>> 0) / 0xffffffff);
  };
  for (let i = 0; i < count; i++) {
    starts[i] = Math.floor(rand() * spanBp);
    lengths[i] = 100 + Math.floor(rand() * 200);
    flags[i] = (rand() < 0.5 ? 0 : 16);
    mapq[i] = 60;
  }
  // Sort by start — `assignPileupRows` assumes sorted input.
  const idx = Array.from({ length: count }, (_, i) => i).sort(
    (a, b) => (starts[a] ?? 0) - (starts[b] ?? 0),
  );
  const sortedStarts = new Int32Array(count);
  const sortedLens = new Uint16Array(count);
  const sortedFlags = new Uint16Array(count);
  const sortedMapq = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const j = idx[i] ?? 0;
    sortedStarts[i] = starts[j] ?? 0;
    sortedLens[i] = lengths[j] ?? 0;
    sortedFlags[i] = flags[j] ?? 0;
    sortedMapq[i] = mapq[j] ?? 0;
  }
  return {
    payload: 'reads',
    key: 'bench:chr1:128:0',
    trackId: 'bench',
    chrom: 'chr1',
    binSize: 128,
    binIndex: 0,
    start: 0n,
    end: BigInt(spanBp),
    count,
    starts: sortedStarts,
    startsHi,
    lengths: sortedLens,
    flags: sortedFlags,
    mapq: sortedMapq,
  };
}

const tile100k = makeMockTile(100_000, 1_000_000);

describe('pileup row assignment', () => {
  bench('100k reads, 1Mb span, maxRows=200', () => {
    assignPileupRows(tile100k, 200);
  });
});
