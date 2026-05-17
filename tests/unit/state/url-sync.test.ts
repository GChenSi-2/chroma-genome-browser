import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startUrlSync } from '~state/url-sync';
import { viewport, setViewport, DEFAULT_VIEWPORT } from '~state/viewport';
import { tracks, setTracks } from '~state/tracks';
import type { BamTrack, BigWigTrack, TrackConfig } from '~state/types';

/**
 * url-sync tests run under happy-dom (vitest config default), where
 * `window.location.hash`, `window.location.search` and `history.replaceState`
 * are all mutable.
 */

let disposer: (() => void) | null = null;

function resetWindowUrl(): void {
  // happy-dom honours `history.replaceState` for path / search / hash.
  history.replaceState(null, '', '/');
}

function resetState(): void {
  setViewport({ ...DEFAULT_VIEWPORT });
  setTracks([]);
}

beforeEach(() => {
  resetWindowUrl();
  resetState();
});

afterEach(() => {
  if (disposer !== null) {
    disposer();
    disposer = null;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetWindowUrl();
  resetState();
});

describe('startUrlSync — initial read', () => {
  it('reads viewport from hash on mount', () => {
    history.replaceState(null, '', '/#chr1:1000-2000');
    disposer = startUrlSync();
    const v = viewport();
    expect(v.chrom).toBe('chr1');
    expect(v.start).toBe(1000n);
    expect(v.end).toBe(2000n);
  });

  it('reads tracks from query on mount', () => {
    const sample: TrackConfig[] = [
      {
        id: 't1',
        kind: 'bam',
        label: 'sample',
        url: 'https://example/foo.bam',
        indexUrl: 'https://example/foo.bam.bai',
        visible: true,
      },
    ];
    const encoded = encodeURIComponent(btoa(JSON.stringify(sample)));
    history.replaceState(null, '', `/?t=${encoded}`);
    disposer = startUrlSync();
    expect(tracks().length).toBe(1);
    expect(tracks()[0]?.id).toBe('t1');
    expect(tracks()[0]?.kind).toBe('bam');
  });

  it('ignores garbage in query string (does not crash, leaves tracks empty)', () => {
    history.replaceState(null, '', '/?t=garbage!!!');
    disposer = startUrlSync();
    expect(tracks()).toEqual([]);
  });

  it('ignores a query payload whose JSON is not an array', () => {
    const encoded = encodeURIComponent(btoa(JSON.stringify({ not: 'an array' })));
    history.replaceState(null, '', `/?t=${encoded}`);
    disposer = startUrlSync();
    expect(tracks()).toEqual([]);
  });

  it('ignores tracks payload with bad shape', () => {
    const bad = [{ id: 't1' }];
    const encoded = encodeURIComponent(btoa(JSON.stringify(bad)));
    history.replaceState(null, '', `/?t=${encoded}`);
    disposer = startUrlSync();
    expect(tracks()).toEqual([]);
  });

  it('leaves viewport at default when hash is missing', () => {
    disposer = startUrlSync();
    expect(viewport()).toEqual(DEFAULT_VIEWPORT);
  });
});

describe('startUrlSync — viewport → URL (debounced 100ms)', () => {
  it('writes hash after debounce window', () => {
    vi.useFakeTimers();
    disposer = startUrlSync();
    setViewport({
      chrom: 'chr2',
      start: 500_000n,
      end: 600_000n,
      pxWidth: 1200,
      pxHeight: 600,
    });
    // Before debounce flushes, hash should still be empty.
    expect(window.location.hash).toBe('');
    vi.advanceTimersByTime(150);
    expect(window.location.hash).toContain('chr2');
    expect(window.location.hash).toContain('500,000');
    expect(window.location.hash).toContain('600,000');
  });

  it('coalesces multiple viewport changes within debounce window', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(history, 'replaceState');
    disposer = startUrlSync();
    setViewport({
      chrom: 'chr2',
      start: 1n,
      end: 2n,
      pxWidth: 1200,
      pxHeight: 600,
    });
    setViewport({
      chrom: 'chr3',
      start: 1n,
      end: 2n,
      pxWidth: 1200,
      pxHeight: 600,
    });
    setViewport({
      chrom: 'chr4',
      start: 1n,
      end: 2n,
      pxWidth: 1200,
      pxHeight: 600,
    });
    vi.advanceTimersByTime(150);
    // Only one replaceState call should fire.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toContain('chr4');
  });
});

describe('startUrlSync — tracks → URL (debounced 200ms)', () => {
  it('writes query string after debounce window', () => {
    vi.useFakeTimers();
    disposer = startUrlSync();
    const sample: TrackConfig[] = [
      {
        id: 'tA',
        kind: 'bigwig',
        label: 'A',
        url: 'https://example/a.bw',
        visible: true,
      },
    ];
    setTracks(sample);
    expect(window.location.search).toBe('');
    vi.advanceTimersByTime(250);
    expect(window.location.search).toContain('t=');
    // Decode and verify shape.
    const param = window.location.search.replace(/^\?t=/, '');
    const decoded = JSON.parse(atob(decodeURIComponent(param))) as unknown;
    expect(Array.isArray(decoded)).toBe(true);
    expect((decoded as TrackConfig[])[0]?.id).toBe('tA');
  });
});

describe('startUrlSync — round-trip', () => {
  it('viewport survives URL serialization', () => {
    vi.useFakeTimers();
    disposer = startUrlSync();
    const original = {
      chrom: 'chr7',
      start: 12_345_678n,
      end: 23_456_789n,
      pxWidth: 1200,
      pxHeight: 600,
    };
    setViewport(original);
    vi.advanceTimersByTime(150);
    const writtenHash = window.location.hash;

    // Tear down and re-mount: state is reset, then sync reads URL.
    disposer();
    disposer = null;
    vi.useRealTimers();
    setViewport({ ...DEFAULT_VIEWPORT });
    // Keep the hash so the re-mount reads it.
    history.replaceState(null, '', `/${writtenHash}`);

    disposer = startUrlSync();
    const v = viewport();
    expect(v.chrom).toBe('chr7');
    expect(v.start).toBe(12_345_678n);
    expect(v.end).toBe(23_456_789n);
  });
});

describe('startUrlSync — hashchange (back/forward)', () => {
  it('reacts to hashchange events', () => {
    disposer = startUrlSync();
    // Simulate a back-button navigation by mutating hash then firing event.
    history.replaceState(null, '', '/#chr9:42-43');
    window.dispatchEvent(new Event('hashchange'));
    const v = viewport();
    expect(v.chrom).toBe('chr9');
    expect(v.start).toBe(42n);
    expect(v.end).toBe(43n);
  });

  it('ignores hashchange with invalid locus', () => {
    disposer = startUrlSync();
    const before = viewport();
    history.replaceState(null, '', '/#not-a-locus');
    window.dispatchEvent(new Event('hashchange'));
    expect(viewport()).toEqual(before);
  });
});

describe('startUrlSync — blob-backed tracks', () => {
  it('omits blob: tracks from the ?t= query (not shareable)', () => {
    vi.useFakeTimers();
    disposer = startUrlSync();

    const remote: BigWigTrack = {
      id: 'remote',
      kind: 'bigwig',
      label: 'Remote',
      url: 'https://example.com/x.bw',
      visible: true,
    };
    const local: BamTrack = {
      id: 'local',
      kind: 'bam',
      label: 'Local',
      url: 'blob:http://localhost/abc',
      indexUrl: 'blob:http://localhost/abc.bai',
      visible: true,
    };
    setTracks([remote, local]);
    vi.advanceTimersByTime(500);

    // Only the remote track should be encoded in the query string.
    const qs = window.location.search;
    expect(qs).toContain('t=');
    const t = qs.match(/t=([^&]+)/)![1]!;
    const decoded = JSON.parse(atob(decodeURIComponent(t)));
    expect(Array.isArray(decoded)).toBe(true);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].id).toBe('remote');
  });

  it('omits a track if EITHER the primary OR the index URL is blob:', () => {
    vi.useFakeTimers();
    disposer = startUrlSync();
    const mixed: BamTrack = {
      id: 'mixed',
      kind: 'bam',
      label: 'Mixed',
      url: 'https://example.com/x.bam',
      indexUrl: 'blob:http://localhost/index-only-local',
      visible: true,
    };
    setTracks([mixed]);
    vi.advanceTimersByTime(500);
    // Empty tracks → no t= param at all.
    expect(window.location.search).not.toContain('t=');
  });
});

describe('startUrlSync — disposer', () => {
  it('stops further URL writes after disposal', () => {
    vi.useFakeTimers();
    disposer = startUrlSync();
    disposer();
    disposer = null;
    const spy = vi.spyOn(history, 'replaceState');

    setViewport({
      chrom: 'chrZ',
      start: 1n,
      end: 2n,
      pxWidth: 1200,
      pxHeight: 600,
    });
    vi.advanceTimersByTime(500);
    expect(spy).not.toHaveBeenCalled();
  });

  it('clears pending debounce timer on dispose', () => {
    vi.useFakeTimers();
    disposer = startUrlSync();
    setViewport({
      chrom: 'chrZ',
      start: 1n,
      end: 2n,
      pxWidth: 1200,
      pxHeight: 600,
    });
    // Dispose before timer fires.
    disposer();
    disposer = null;
    const spy = vi.spyOn(history, 'replaceState');
    vi.advanceTimersByTime(500);
    expect(spy).not.toHaveBeenCalled();
  });

  it('stops listening for hashchange after disposal', () => {
    disposer = startUrlSync();
    disposer();
    disposer = null;
    history.replaceState(null, '', '/#chr9:42-43');
    window.dispatchEvent(new Event('hashchange'));
    // viewport must not have updated.
    expect(viewport().chrom).toBe('chr1');
  });
});

describe('startUrlSync — write guard (no redundant replaceState)', () => {
  it('does not call replaceState when nothing changed', () => {
    vi.useFakeTimers();
    history.replaceState(
      null,
      '',
      '/#' + 'chr1:0-1,000,000', // same as DEFAULT_VIEWPORT formatLocus
    );
    disposer = startUrlSync();
    const spy = vi.spyOn(history, 'replaceState');
    // setViewport with same values triggers no signal change (equals fn).
    setViewport({ ...DEFAULT_VIEWPORT });
    vi.advanceTimersByTime(150);
    expect(spy).not.toHaveBeenCalled();
  });
});
