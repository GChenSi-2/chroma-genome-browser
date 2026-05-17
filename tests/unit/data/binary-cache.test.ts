/**
 * @vitest-environment happy-dom
 *
 * happy-dom's bundled `indexedDB` shim is incomplete (writes silently
 * drop), so we polyfill with `fake-indexeddb/auto` — a real-ish in-memory
 * implementation maintained by the same crew as IDB itself. Tests run
 * under happy-dom for DOM types; fake-indexeddb wins on `indexedDB`
 * because import order matters.
 */
import 'fake-indexeddb/auto';

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCachedBinary,
  setCachedBinary,
  deleteCachedBinary,
  clearBinaryCache,
  _resetBinaryCacheState,
} from '~data/network/binary-cache';

describe('binary-cache (IndexedDB)', () => {
  beforeEach(async () => {
    _resetBinaryCacheState();
    await clearBinaryCache().catch(() => {});
  });

  it('returns null on miss', async () => {
    const out = await getCachedBinary('does-not-exist');
    expect(out).toBeNull();
  });

  it('round-trips a Uint8Array', async () => {
    const value = new Uint8Array([1, 2, 3, 4, 5]);
    await setCachedBinary('k1', value);
    const got = await getCachedBinary('k1');
    expect(got).toBeInstanceOf(Uint8Array);
    expect(Array.from(got!)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns most-recent value when set twice', async () => {
    await setCachedBinary('k2', new Uint8Array([1]));
    await setCachedBinary('k2', new Uint8Array([9, 9, 9]));
    const got = await getCachedBinary('k2');
    expect(Array.from(got!)).toEqual([9, 9, 9]);
  });

  it('deleteCachedBinary removes the entry', async () => {
    await setCachedBinary('k3', new Uint8Array([7]));
    await deleteCachedBinary('k3');
    expect(await getCachedBinary('k3')).toBeNull();
  });

  it('handles a moderately large blob (1 MB) without losing bytes', async () => {
    const big = new Uint8Array(1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    await setCachedBinary('big', big);
    const got = await getCachedBinary('big');
    expect(got).not.toBeNull();
    expect(got!.length).toBe(big.length);
    // Spot-check a handful of positions instead of comparing every byte.
    expect(got![0]).toBe(big[0]);
    expect(got![500_000]).toBe(big[500_000]);
    expect(got![big.length - 1]).toBe(big[big.length - 1]);
  });

  it('isolates keys', async () => {
    await setCachedBinary('a', new Uint8Array([1]));
    await setCachedBinary('b', new Uint8Array([2]));
    const a = await getCachedBinary('a');
    const b = await getCachedBinary('b');
    expect(Array.from(a!)).toEqual([1]);
    expect(Array.from(b!)).toEqual([2]);
  });
});
