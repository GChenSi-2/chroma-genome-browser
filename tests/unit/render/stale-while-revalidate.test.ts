import { describe, it, expect } from 'vitest';
import { _collectTilesForTrack } from '~render/scheduler';
import type {
  CoverageTile,
  ReadTile,
  TileKey,
  TileStatus,
  Viewport,
} from '~state/types';
import type { TilePolicy } from '~data/tile-policy';

const VIEWPORT: Viewport = {
  chrom: 'chr20',
  start: 10_000_000n,
  end: 10_010_000n,
  pxWidth: 1000,
  pxHeight: 600,
};

const VP_POLICY: TilePolicy = { binSize: 1024, tileWidthBp: 10_000, vp: true };
const COVERAGE_POLICY: TilePolicy = { binSize: 8192, tileWidthBp: 524_288 };

function makeReadTile(start: bigint, end: bigint, key: string): ReadTile {
  return {
    key,
    trackId: 'bam',
    chrom: 'chr20',
    binSize: 1024,
    binIndex: 0,
    start,
    end,
    payload: 'reads',
    count: 0,
    starts: new Int32Array(0),
    startsHi: new Int32Array(0),
    lengths: new Uint16Array(0),
    flags: new Uint16Array(0),
    mapq: new Uint8Array(0),
  };
}

function makeCoverageTile(start: bigint, end: bigint, binSize: 1024 | 8192 | 65_536, key: string): CoverageTile {
  return {
    key,
    trackId: 'bam',
    chrom: 'chr20',
    binSize,
    binIndex: 0,
    start,
    end,
    payload: 'coverage',
    values: new Float32Array(0),
  };
}

function snap(...tiles: Array<ReadTile | CoverageTile>): ReadonlyMap<TileKey, TileStatus> {
  const m = new Map<TileKey, TileStatus>();
  for (const t of tiles) m.set(t.key, { state: 'ready', tile: t });
  return m;
}

describe('collectTilesForTrack — vp mode (BAM pileup)', () => {
  it('returns the exact-match tile when present', () => {
    const exact = makeReadTile(10_000_000n, 10_010_000n, 'k-exact');
    const out = _collectTilesForTrack(snap(exact), 'bam', VIEWPORT, VP_POLICY);
    expect(out).toHaveLength(1);
    expect(out[0]!.start).toBe(10_000_000n);
  });

  it('stale-while-revalidate: pan by 1 bp still renders the old tile', () => {
    // Cached tile at the previous viewport start.
    const stale = makeReadTile(10_000_000n, 10_010_000n, 'k-stale');
    // New viewport, shifted by 1 bp — no exact match yet.
    const v = { ...VIEWPORT, start: 10_000_001n, end: 10_010_001n };
    const out = _collectTilesForTrack(snap(stale), 'bam', v, VP_POLICY);
    expect(out).toHaveLength(1);
    expect(out[0]!.start).toBe(10_000_000n);
  });

  it('prefers exact match over stale when both are cached', () => {
    const stale = makeReadTile(9_999_000n, 10_009_000n, 'k-stale');
    const exact = makeReadTile(10_000_000n, 10_010_000n, 'k-exact');
    const out = _collectTilesForTrack(snap(stale, exact), 'bam', VIEWPORT, VP_POLICY);
    expect(out).toHaveLength(1);
    expect(out[0]!.start).toBe(10_000_000n); // exact
  });

  it('picks the closest-start stale tile when multiple overlap', () => {
    const farLeft = makeReadTile(9_990_000n, 10_000_000n - 1n, 'far-left');
    const close = makeReadTile(9_999_000n, 10_009_000n, 'close');
    const farRight = makeReadTile(10_005_000n, 10_015_000n, 'far-right');
    const v = { ...VIEWPORT, start: 10_000_001n, end: 10_010_001n };
    const out = _collectTilesForTrack(snap(farLeft, close, farRight), 'bam', v, VP_POLICY);
    expect(out).toHaveLength(1);
    // closest start to 10_000_001: 9_999_000 (delta 1001) — wins over 10_005_000 (4999).
    expect(out[0]!.start).toBe(9_999_000n);
  });

  it('returns [] when nothing overlaps', () => {
    const elsewhere = makeReadTile(50_000_000n, 50_010_000n, 'far-away');
    const out = _collectTilesForTrack(snap(elsewhere), 'bam', VIEWPORT, VP_POLICY);
    expect(out).toEqual([]);
  });
});

describe('collectTilesForTrack — tile-binning mode (coverage / signal)', () => {
  it('returns all exact-match tiles overlapping the viewport', () => {
    const a = makeCoverageTile(9_961_472n, 9_961_472n + 524_288n, 8192, 'a');
    const b = makeCoverageTile(9_961_472n + 524_288n, 9_961_472n + 2n * 524_288n, 8192, 'b');
    const out = _collectTilesForTrack(snap(a, b), 'bam', VIEWPORT, COVERAGE_POLICY);
    // viewport at 10_000_000..10_010_000 overlaps tile a (9.96M..10.48M).
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.every(t => t.binSize === 8192)).toBe(true);
  });

  it('stale fallback: returns different-binSize overlapping tiles when no exact match', () => {
    // Cached at a finer binSize (1024) from before a zoom-out to coverage tier.
    const stale = makeCoverageTile(9_961_472n, 9_961_472n + 524_288n, 1024, 'stale-fine');
    const out = _collectTilesForTrack(snap(stale), 'bam', VIEWPORT, COVERAGE_POLICY);
    expect(out).toHaveLength(1);
    expect(out[0]!.binSize).toBe(1024); // stale, different from policy 8192
  });

  it('caps stale fan-out so a zoom-out doesn\'t dump dozens of tiles at once', () => {
    // 10 cached tiles, none matching the coverage-policy width — all stale.
    const many = Array.from({ length: 10 }, (_, i) =>
      makeCoverageTile(
        9_900_000n + BigInt(i * 50_000),
        9_900_000n + BigInt((i + 1) * 50_000),
        1024,
        `stale-${i}`,
      ),
    );
    const out = _collectTilesForTrack(snap(...many), 'bam', VIEWPORT, COVERAGE_POLICY);
    // MAX_STALE_TILES = 4 per the scheduler.
    expect(out.length).toBeLessThanOrEqual(4);
  });
});
