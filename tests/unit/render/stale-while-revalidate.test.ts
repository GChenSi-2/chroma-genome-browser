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

  it('greedy-covers the viewport with left- AND right-side stale tiles', () => {
    // A pan to the right: viewport now starts halfway into the old tile's
    // range AND extends into territory only the next-region cached tile
    // covers. Returning just one stale tile would leave the other half of
    // the band empty — the user's reported flicker.
    const leftCached = makeReadTile(9_995_000n, 10_005_000n, 'left'); // covers viewport's left half
    const rightCached = makeReadTile(10_005_000n, 10_015_000n, 'right'); // covers viewport's right half
    const v = { ...VIEWPORT, start: 10_000_000n, end: 10_010_000n };
    const out = _collectTilesForTrack(snap(leftCached, rightCached), 'bam', v, VP_POLICY);

    // Both tiles together cover the viewport — the greedy cover picks both.
    expect(out).toHaveLength(2);
    const starts = new Set(out.map((t) => t.start));
    expect(starts.has(9_995_000n)).toBe(true);
    expect(starts.has(10_005_000n)).toBe(true);
  });

  it('greedy cover stops once the viewport is covered (no over-pick)', () => {
    // Three candidates; the leftmost two together already cover the
    // viewport, so the third should be dropped.
    const a = makeReadTile(9_990_000n, 10_005_000n, 'a');
    const b = makeReadTile(10_004_000n, 10_012_000n, 'b');
    const c = makeReadTile(10_006_000n, 10_011_000n, 'c-redundant');
    const v = { ...VIEWPORT, start: 10_000_000n, end: 10_010_000n };
    const out = _collectTilesForTrack(snap(a, b, c), 'bam', v, VP_POLICY);
    expect(out.length).toBeLessThanOrEqual(2);
    // The redundant 'c' tile (starts AFTER the running covered pointer
    // already reached its end) must be skipped.
    expect(out.find((t) => t.key === 'c-redundant')).toBeUndefined();
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
    // 30 cached tiles that all overlap the viewport but with random
    // shifts — greedy cover should pick at most MAX_STALE_TILES (6) of
    // them, choosing those that extend the running covered pointer.
    const many = Array.from({ length: 30 }, (_, i) =>
      makeCoverageTile(
        9_900_000n + BigInt(i * 50_000),
        9_900_000n + BigInt((i + 1) * 50_000),
        1024,
        `stale-${i}`,
      ),
    );
    const out = _collectTilesForTrack(snap(...many), 'bam', VIEWPORT, COVERAGE_POLICY);
    // MAX_STALE_TILES = 6 per the scheduler.
    expect(out.length).toBeLessThanOrEqual(6);
  });
});
