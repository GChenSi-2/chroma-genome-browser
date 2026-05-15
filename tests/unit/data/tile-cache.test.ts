import { describe, it, expect, vi } from 'vitest';
import {
  createTileCache,
  parseTileKey,
  formatTileKey,
  type TileCacheSnapshot,
} from '~data/tiles';
import type { TileStatus, Viewport } from '~state/types';

const pending: TileStatus = { state: 'pending' };
const errored = (m: string): TileStatus => ({ state: 'error', message: m });

const vp = (chrom: string, start: bigint, end: bigint): Viewport => ({
  chrom,
  start,
  end,
  pxWidth: 1200,
  pxHeight: 600,
});

const key = (
  trackId: string,
  chrom: string,
  binSize: number,
  tileWidthBp: number,
  tileIndex: number,
) => `${trackId}:${chrom}:${binSize}:${tileWidthBp}:${tileIndex}`;

describe('parseTileKey / formatTileKey', () => {
  it('round-trips a valid key', () => {
    const k = 'tr1:chr20:1024:32768:42';
    const p = parseTileKey(k);
    expect(p).toEqual({
      trackId: 'tr1',
      chrom: 'chr20',
      binSize: 1024,
      tileWidthBp: 32768,
      tileIndex: 42,
    });
    expect(formatTileKey(p!)).toBe(k);
  });

  it.each([
    'tr1:chr20:1024:32768',           // too few parts
    'tr1:chr20:1024:32768:42:extra',  // too many parts
    'tr1:chr20:9999:32768:42',        // binSize not in BIN_SIZES
    'tr1:chr20:1024:32768:-1',        // negative tileIndex
    'tr1:chr20:1024:32768:abc',       // non-numeric tileIndex
    'tr1:chr20:1024:512:0',           // tileWidthBp < binSize
    'tr1:chr20:1024:abc:0',           // non-numeric tileWidthBp
    ':chr20:1024:32768:42',           // empty trackId
    'tr1::1024:32768:42',             // empty chrom
  ])('rejects %s', (bad) => {
    expect(parseTileKey(bad)).toBeNull();
  });
});

describe('TileCache basic ops', () => {
  it('put / get / has / delete', () => {
    const c = createTileCache();
    const k = key('t', 'chr1', 1024, 16384, 0);
    expect(c.has(k)).toBe(false);
    c.put(k, pending);
    expect(c.has(k)).toBe(true);
    expect(c.get(k)).toBe(pending);
    expect(c.size()).toBe(1);
    expect(c.delete(k)).toBe(true);
    expect(c.has(k)).toBe(false);
    expect(c.delete(k)).toBe(false);
  });

  it('throws on invalid key', () => {
    const c = createTileCache();
    expect(() => c.put('garbage', pending)).toThrow(/invalid tile key/);
  });

  it('snapshot is a fresh map each call', () => {
    const c = createTileCache();
    c.put(key('t', 'chr1', 1024, 16384, 0), pending);
    const a = c.snapshot();
    const b = c.snapshot();
    expect(a).not.toBe(b);
    expect([...a]).toEqual([...b]);
  });
});

describe('onChange', () => {
  it('fires on put and delete', () => {
    const onChange = vi.fn<(snap: TileCacheSnapshot) => void>();
    const c = createTileCache({ onChange });
    const k = key('t', 'chr1', 1024, 16384, 0);

    c.put(k, pending);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].size).toBe(1);

    c.delete(k);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1]![0].size).toBe(0);
  });

  it('does not fire on no-op delete', () => {
    const onChange = vi.fn<(snap: TileCacheSnapshot) => void>();
    const c = createTileCache({ onChange });
    c.delete(key('t', 'chr1', 1024, 16384, 0));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('eviction', () => {
  it('LRU when no viewport set', () => {
    let t = 1000;
    const c = createTileCache({ capacity: 3, now: () => t++ });
    c.put(key('t', 'chr1', 1024, 16384, 0), pending);
    c.put(key('t', 'chr1', 1024, 16384, 1), pending);
    c.put(key('t', 'chr1', 1024, 16384, 2), pending);
    c.put(key('t', 'chr1', 1024, 16384, 3), pending); // forces eviction

    expect(c.size()).toBe(3);
    expect(c.evictionCount()).toBe(1);
    // bin 0 is oldest -> evicted
    expect(c.has(key('t', 'chr1', 1024, 16384, 0))).toBe(false);
    expect(c.has(key('t', 'chr1', 1024, 16384, 3))).toBe(true);
  });

  it('viewport-distance dominates LRU', () => {
    let t = 1000;
    const c = createTileCache({ capacity: 2, now: () => t++ });
    // Viewport centered around tile-index 100 on chr1 (1024-bp tile width).
    c.setViewport(vp('chr1', 100_000n, 101_000n));

    // Far tile inserted first (oldest), but should be kept if score wasn't
    // distance-dominated. With distance-dominated, far tile evicts first.
    c.put(key('t', 'chr1', 1024, 1024, 0), pending);     // far
    c.put(key('t', 'chr1', 1024, 1024, 100), pending);   // near viewport
    c.put(key('t', 'chr1', 1024, 1024, 99), pending);    // near, newer

    expect(c.size()).toBe(2);
    expect(c.has(key('t', 'chr1', 1024, 1024, 0))).toBe(false);   // far -> evicted
    expect(c.has(key('t', 'chr1', 1024, 1024, 100))).toBe(true);
    expect(c.has(key('t', 'chr1', 1024, 1024, 99))).toBe(true);
  });

  it('different chrom is more evictable than same-chrom', () => {
    const c = createTileCache({ capacity: 1 });
    c.setViewport(vp('chr1', 0n, 1_000_000n));
    c.put(key('t', 'chr20', 1024, 1024, 0), pending); // off-viewport chrom
    c.put(key('t', 'chr1', 1024, 1024, 1000), pending); // on-chrom but far
    expect(c.size()).toBe(1);
    expect(c.has(key('t', 'chr20', 1024, 1024, 0))).toBe(false);
    expect(c.has(key('t', 'chr1', 1024, 1024, 1000))).toBe(true);
  });

  it('preserves error and ready entries equally — eviction is status-blind', () => {
    let t = 1000;
    const c = createTileCache({ capacity: 2, now: () => t++ });
    c.put(key('t', 'chr1', 1024, 16384, 0), errored('x'));
    c.put(key('t', 'chr1', 1024, 16384, 1), pending);
    c.put(key('t', 'chr1', 1024, 16384, 2), pending); // evicts the oldest = errored
    expect(c.has(key('t', 'chr1', 1024, 16384, 0))).toBe(false);
  });
});

describe('lifecycle', () => {
  it('dispose clears entries and fires onChange', () => {
    const onChange = vi.fn<(snap: TileCacheSnapshot) => void>();
    const c = createTileCache({ onChange });
    c.put(key('t', 'chr1', 1024, 16384, 0), pending);
    onChange.mockClear();

    c.dispose();
    expect(c.size()).toBe(0);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]![0].size).toBe(0);

    // subsequent put is a no-op
    c.put(key('t', 'chr1', 1024, 16384, 1), pending);
    expect(c.size()).toBe(0);
  });
});
