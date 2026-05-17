import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  activeAssembly,
  chromLength,
  parseFaiLengths,
  loadReferenceAssembly,
  _setActiveAssembly,
  _resetAssemblyLoadState,
} from '~state/assembly';

const HG19_FALLBACK_LABEL = 'hg19 (built-in fallback)';

describe('parseFaiLengths', () => {
  it('parses a minimal valid .fai payload', () => {
    const text = [
      'chr1\t249250621\t6\t50\t51',
      'chr2\t243199373\t254235646\t50\t51',
      'chrM\t16571\t3157591135\t50\t51',
    ].join('\n');
    const map = parseFaiLengths(text);
    expect(map.size).toBe(3);
    expect(map.get('chr1')).toBe(249_250_621n);
    expect(map.get('chr2')).toBe(243_199_373n);
    expect(map.get('chrM')).toBe(16_571n);
  });

  it('tolerates CRLF line endings + trailing blanks', () => {
    const text = 'chr1\t249250621\t6\t50\t51\r\n\r\nchr2\t100\t0\t50\t51\r\n';
    const map = parseFaiLengths(text);
    expect(map.size).toBe(2);
    expect(map.get('chr1')).toBe(249_250_621n);
    expect(map.get('chr2')).toBe(100n);
  });

  it('drops malformed lines silently', () => {
    const text = [
      'chr1\t249250621\t6\t50\t51',     // valid
      'orphan-line-no-tabs',              // dropped: no columns
      '\tjust-an-empty-name\t100',        // dropped: empty name
      'chr2\tNaN\t0\t50\t51',             // dropped: bad length
      'chr3\t0\t0\t50\t51',               // dropped: zero length
      'chr4\t-50\t0\t50\t51',             // dropped: negative length
      'chr5\t100\t0\t50\t51',             // valid
    ].join('\n');
    const map = parseFaiLengths(text);
    expect([...map.keys()].sort()).toEqual(['chr1', 'chr5']);
  });

  it('returns empty map for empty input', () => {
    expect(parseFaiLengths('').size).toBe(0);
    expect(parseFaiLengths('   \n  \r\n').size).toBe(0);
  });
});

describe('chromLength', () => {
  it('reads from the active assembly with chr-prefix normalisation', () => {
    expect(chromLength('chr20')).toBe(63_025_520n);  // hg19 fallback
    expect(chromLength('20')).toBe(63_025_520n);
  });

  it('falls back to 250 Mb for unknown contigs', () => {
    expect(chromLength('chrUn_gl000200')).toBe(250_000_000n);
  });
});

describe('activeAssembly default state', () => {
  it('starts on the built-in hg19 fallback', () => {
    expect(activeAssembly().label).toBe(HG19_FALLBACK_LABEL);
    expect(activeAssembly().byChrom.get('chr1')).toBe(249_250_621n);
  });
});

describe('loadReferenceAssembly', () => {
  beforeEach(() => {
    _resetAssemblyLoadState();
    // Restore the fallback before each test so order doesn't matter.
    const HG19 = {
      label: HG19_FALLBACK_LABEL,
      byChrom: new Map<string, bigint>([
        ['chr1', 249_250_621n],
        ['chr20', 63_025_520n],
      ]),
    };
    _setActiveAssembly(HG19);
  });

  it('fetches + parses + installs a custom assembly', async () => {
    const text = 'chr1\t1000\t0\t50\t51\nchrSPECIAL\t42\t0\t50\t51\n';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => text,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await loadReferenceAssembly('https://example.com/x.fai', 'test fixture');
    expect(result).not.toBeNull();
    expect(result!.label).toBe('test fixture');
    expect(activeAssembly().label).toBe('test fixture');
    expect(chromLength('chrSPECIAL')).toBe(42n);
    expect(chromLength('chr1')).toBe(1000n);
    // chrom not in this .fai → fallback constant, NOT the previous hg19 value
    expect(chromLength('chr20')).toBe(250_000_000n);

    vi.unstubAllGlobals();
  });

  it('is idempotent per URL — second call short-circuits', async () => {
    const text = 'chr1\t999\t0\t50\t51\n';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => text,
    });
    vi.stubGlobal('fetch', fetchMock);

    await loadReferenceAssembly('https://example.com/x.fai', 'first');
    await loadReferenceAssembly('https://example.com/x.fai', 'second');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(activeAssembly().label).toBe('first');

    vi.unstubAllGlobals();
  });

  it('keeps the existing assembly when the .fai parses empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '\n\n',
    }));

    const before = activeAssembly();
    const result = await loadReferenceAssembly('https://example.com/empty.fai', 'empty');
    expect(result).toBeNull();
    expect(activeAssembly()).toBe(before);

    vi.unstubAllGlobals();
  });

  it('throws on non-2xx so callers can log', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => '',
    }));

    await expect(
      loadReferenceAssembly('https://example.com/missing.fai', 'missing'),
    ).rejects.toThrow(/404/);

    vi.unstubAllGlobals();
  });
});
