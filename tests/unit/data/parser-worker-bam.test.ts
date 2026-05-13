// @vitest-environment node
/**
 * BAM parser worker tests.
 *
 * `@gmod/bam` is mocked at the module boundary so these tests never touch
 * the network and remain deterministic. The mock supplies a configurable
 * array of fake `BamRecord`-shaped objects and the worker is exercised
 * through its exported `__api` test hook (which is the same object passed
 * to `Comlink.expose` at module bottom — Comlink itself is not involved).
 *
 * Worker tests run under the `node` vitest environment because happy-dom's
 * MessageChannel + Worker stubs are incomplete for this kind of test.
 */
import '@vitest/web-worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoverageTile, ReadTile } from '~state/types';
import type { ParseBamRequest } from '~data/workers/pool-types';

// ─────────────────────────────────────────────────────────────────────────────
// @gmod/bam mock — produce a configurable record list from each test.
// ─────────────────────────────────────────────────────────────────────────────

interface FakeRecord {
  start: number;
  flags: number;
  mq: number;
  length_on_ref: number;
}

let mockRecords: FakeRecord[] = [];
let lastBamFileArgs: { bamUrl?: string; baiUrl?: string } | undefined;
/** Delay in ms applied inside getRecordsForRange — used by abort tests. */
let mockFetchDelayMs = 0;

vi.mock('@gmod/bam', () => {
  class FakeBamFile {
    constructor(args: { bamUrl?: string; baiUrl?: string }) {
      lastBamFileArgs = args;
    }
    async getHeader(): Promise<unknown[]> {
      return [];
    }
    async getRecordsForRange(
      _chr: string,
      _min: number,
      _max: number,
      opts?: { signal?: AbortSignal },
    ): Promise<FakeRecord[]> {
      if (opts?.signal?.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      if (mockFetchDelayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const handle = setTimeout(resolve, mockFetchDelayMs);
          opts?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(handle);
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      }
      return mockRecords;
    }
  }
  return { BamFile: FakeBamFile };
});

// The worker module imports lazily so the mock above is in place before the
// SUT touches it. Top-level await isn't needed — vi.mock is hoisted.
const importWorker = async (): Promise<
  typeof import('~data/workers/parser.worker')
> => import('~data/workers/parser.worker');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Create a port pair; return the worker-side port (what the API expects). */
function makeAbortPorts(): { workerPort: MessagePort; mainPort: MessagePort } {
  const channel = new MessageChannel();
  return { workerPort: channel.port2, mainPort: channel.port1 };
}

function rec(
  start: number,
  length: number,
  flags = 0,
  mq = 60,
): FakeRecord {
  return { start, length_on_ref: length, flags, mq };
}

const BASE_REQ: ParseBamRequest = {
  url: 'https://example.com/test.bam',
  indexUrl: 'https://example.com/test.bam.bai',
  chrom: 'chr1',
  start: 1000,
  end: 2000,
  binSize: 128,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockRecords = [];
  lastBamFileArgs = undefined;
  mockFetchDelayMs = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parser.worker parseBamTile — read tile path (binSize < 8192)', () => {
  it('returns a ReadTile with SoA arrays populated and sorted by start', async () => {
    mockRecords = [
      // Deliberately out of order — the worker must sort.
      rec(1500, 100, 16 /* reverse */, 30),
      rec(1100, 150, 0, 60),
      rec(1300, 50, 0, 0),
    ];

    const { __api } = await importWorker();
    const { workerPort } = makeAbortPorts();

    const result = (await __api.parseBamTile(workerPort, BASE_REQ)) as ReadTile;

    expect(result.payload).toBe('reads');
    expect(result.count).toBe(3);
    expect(result.chrom).toBe('chr1');
    expect(result.binSize).toBe(128);
    expect(result.start).toBe(1000n);
    expect(result.end).toBe(2000n);

    // Sorted ascending
    expect(Array.from(result.starts)).toEqual([1100, 1300, 1500]);
    expect(Array.from(result.lengths)).toEqual([150, 50, 100]);
    expect(Array.from(result.flags)).toEqual([0, 0, 16]);
    expect(Array.from(result.mapq)).toEqual([60, 0, 30]);
    // startsHi all zero (lo32 covers <2^31)
    expect(Array.from(result.startsHi)).toEqual([0, 0, 0]);

    // Exact SoA typed-array types
    expect(result.starts).toBeInstanceOf(Int32Array);
    expect(result.startsHi).toBeInstanceOf(Int32Array);
    expect(result.lengths).toBeInstanceOf(Uint16Array);
    expect(result.flags).toBeInstanceOf(Uint16Array);
    expect(result.mapq).toBeInstanceOf(Uint8Array);

    // Forwarded to the BamFile constructor
    expect(lastBamFileArgs).toEqual({
      bamUrl: BASE_REQ.url,
      baiUrl: BASE_REQ.indexUrl,
    });
  });

  it('caps the read tile at 100,000 records (first N by start order)', async () => {
    // Generate 100_050 reads with strictly increasing start so we can verify
    // the cap drops the *tail*.
    const n = 100_050;
    mockRecords = new Array(n);
    for (let i = 0; i < n; i++) mockRecords[i] = rec(1000 + i, 50);

    const { __api } = await importWorker();
    const { workerPort } = makeAbortPorts();

    const req: ParseBamRequest = {
      ...BASE_REQ,
      // Widen the region so coverage thresholds don't kick in.
      start: 1000,
      end: 1000 + n + 100,
      binSize: 128,
    };
    const result = (await __api.parseBamTile(workerPort, req)) as ReadTile;

    expect(result.count).toBe(100_000);
    expect(result.starts.length).toBe(100_000);
    // First read should be the smallest start (1000), last in the cap should
    // be 1000 + 99_999 since we drop the tail after sort.
    expect(result.starts[0]).toBe(1000);
    expect(result.starts[99_999]).toBe(1000 + 99_999);
  });

  it('clamps oversized lengths into Uint16 range without throwing', async () => {
    mockRecords = [rec(1000, 200_000)]; // > 65_535
    const { __api } = await importWorker();
    const { workerPort } = makeAbortPorts();
    const result = (await __api.parseBamTile(workerPort, BASE_REQ)) as ReadTile;
    expect(result.lengths[0]).toBe(65_535);
  });
});

describe('parser.worker parseBamTile — coverage path (binSize >= 8192)', () => {
  it('returns a CoverageTile with values.length === ceil(span / binSize)', async () => {
    const req: ParseBamRequest = {
      ...BASE_REQ,
      start: 0,
      end: 100_000,
      binSize: 8192,
    };

    // 3 reads, all entirely inside bin 0 (covers [0, 8192)).
    mockRecords = [rec(100, 50), rec(200, 50), rec(300, 50)];

    const { __api } = await importWorker();
    const { workerPort } = makeAbortPorts();
    const result = (await __api.parseBamTile(
      workerPort,
      req,
    )) as CoverageTile;

    expect(result.payload).toBe('coverage');
    expect(result.values).toBeInstanceOf(Float32Array);
    const expectedBins = Math.ceil((req.end - req.start) / req.binSize);
    expect(result.values.length).toBe(expectedBins);

    // All 3 reads land in bin 0.
    expect(result.values[0]).toBe(3);
    for (let i = 1; i < result.values.length; i++) {
      expect(result.values[i]).toBe(0);
    }
  });

  it('counts a read in every bin its [start, end) overlaps', async () => {
    const req: ParseBamRequest = {
      ...BASE_REQ,
      start: 0,
      end: 32_768,
      binSize: 8192,
    };

    // One read covering bins 1 and 2 ([8192, 24576) hits bins 1 + 2).
    mockRecords = [rec(8200, 16_000)];

    const { __api } = await importWorker();
    const { workerPort } = makeAbortPorts();
    const result = (await __api.parseBamTile(
      workerPort,
      req,
    )) as CoverageTile;

    expect(result.values.length).toBe(4);
    expect(result.values[0]).toBe(0);
    expect(result.values[1]).toBe(1);
    expect(result.values[2]).toBe(1);
    expect(result.values[3]).toBe(0);
  });
});

describe('parser.worker parseBamTile — abort handling', () => {
  it('throws AbortError when the abort port fires during the fetch', async () => {
    mockRecords = [rec(1000, 50)];
    // The worker polls the abort watcher every 25ms; give the fetch enough
    // time for at least one poll tick after the abort message.
    mockFetchDelayMs = 300;

    const { __api } = await importWorker();
    const { workerPort, mainPort } = makeAbortPorts();

    const pending = __api.parseBamTile(workerPort, BASE_REQ);
    setTimeout(() => mainPort.postMessage('abort'), 50);

    await expect(pending).rejects.toThrow(/aborted/);
  });
});
