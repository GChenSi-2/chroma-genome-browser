/**
 * Parser worker entry — exposes the ParserApi over Comlink.
 *
 * Per-format status:
 *   - BAM      → implemented (T1.A.3, this commit) via @gmod/bam
 *   - BigWig   → stub (T1.A.4)
 *   - FASTA    → stub (T1.A.5)
 *   - VCF      → stub (T2.E.1)
 *
 * Abort-across-the-boundary protocol:
 *   The main thread creates a MessageChannel per task and passes one port
 *   to the worker as the first argument. The worker stores `aborted = true`
 *   the moment any message is received on the port; long parsers poll this
 *   flag at I/O boundaries and throw `DOMException('aborted', 'AbortError')`.
 */

import * as Comlink from 'comlink';
import { BamFile } from '@gmod/bam';
// We deliberately pass `bamUrl` / `baiUrl` strings to BamFile rather than
// constructing `RemoteFile` instances ourselves: `generic-filehandle2` is a
// transitive dep of @gmod/bam (not a direct one), so importing it would
// require a package.json change. Internally BamFile builds the same
// RemoteFile, so this is equivalent at runtime.
import type {
  CoverageTile,
  ReadTile,
  ReferenceTile,
  SignalTile,
  VariantTile,
} from '~state/types';
import type {
  ParseBamRequest,
  ParseBigWigRequest,
  ParseFastaRequest,
  ParseVcfRequest,
} from './pool-types';

// In a real (browser) worker `self` is a DedicatedWorkerGlobalScope. We type
// it loosely here so the same module also imports cleanly from main-thread
// type-only test contexts. `selfOrUndefined` lets us no-op the `Comlink.expose`
// call when this module is imported under Node (e.g. unit tests calling the
// API functions directly).
declare const self: DedicatedWorkerGlobalScope | undefined;
const selfOrUndefined: DedicatedWorkerGlobalScope | undefined =
  typeof self === 'undefined' ? undefined : self;

/** SoA cap — keeps a single tile bounded regardless of region density. */
const MAX_READS = 100_000;

/** Below this binSize, callers want per-read detail; above, a histogram. */
const COVERAGE_BIN_THRESHOLD = 8192;

/** Set up an abort-watcher on a per-task MessagePort. */
function createAbortWatcher(port: MessagePort): { aborted: () => boolean } {
  let aborted = false;
  port.onmessage = (): void => {
    aborted = true;
  };
  port.start();
  return { aborted: (): boolean => aborted };
}

/** Convenience for the stub bodies — also useful inside the real parsers. */
function abortError(): DOMException {
  return new DOMException('aborted', 'AbortError');
}

function notImplemented(format: string): Error {
  return new Error(
    `${format} parsing not implemented yet — see TWO_DAY_SPRINT T1.A.3-5`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BAM parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal view of `@gmod/bam` BamRecord used by the worker. We feature-detect
 * both the snake_case getter (`length_on_ref`, current 7.x) and the camelCase
 * accessor (older releases) so the worker is resilient to library churn.
 */
interface BamRecordView {
  start: number;
  flags: number;
  mq?: number | undefined;
  mappingQuality?: number | undefined;
  length_on_ref?: number;
  lengthOnRef?: () => number;
  length?: number;
}

function readStart(r: BamRecordView): number {
  return r.start | 0;
}

function readLengthOnRef(r: BamRecordView): number {
  if (typeof r.lengthOnRef === 'function') return r.lengthOnRef();
  if (typeof r.length_on_ref === 'number') return r.length_on_ref;
  if (typeof r.length === 'number') return r.length;
  return 0;
}

function readMapq(r: BamRecordView): number {
  // BAM stores MQ in [0, 255]; 255 = unavailable. The gmod getter maps that
  // to `undefined`; older versions exposed a `mappingQuality` property.
  const v = r.mq ?? r.mappingQuality;
  return typeof v === 'number' ? v : 0;
}

/**
 * Pack reads into a Structure-of-Arrays ReadTile.
 *
 * `key` / `trackId` are placeholders — the pool layer (or higher tile-cache
 * integration) overwrites them with the real ids. We deliberately keep the
 * worker oblivious to track identity to keep its inputs small.
 */
function packReadTile(
  reads: BamRecordView[],
  req: ParseBamRequest,
): ReadTile {
  // Sort by start so callers can binary-search by genomic position and so the
  // "first N when truncating" path is deterministic.
  reads.sort((a, b) => readStart(a) - readStart(b));

  const count = Math.min(reads.length, MAX_READS);
  const starts = new Int32Array(count);
  const startsHi = new Int32Array(count); // 0 for human autosomes (lo32 covers up to 2^31 - 1)
  const lengths = new Uint16Array(count);
  const flags = new Uint16Array(count);
  const mapq = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const r = reads[i];
    if (!r) continue;
    starts[i] = readStart(r);
    // startsHi[i] = 0 implicitly (Int32Array default)
    const len = readLengthOnRef(r);
    lengths[i] = len < 0 ? 0 : len > 65_535 ? 65_535 : len | 0;
    flags[i] = r.flags & 0xffff;
    const mq = readMapq(r);
    mapq[i] = mq < 0 ? 0 : mq > 255 ? 255 : mq | 0;
  }

  return {
    key: `:${req.chrom}:${req.binSize}:${Math.floor(req.start / req.binSize)}`,
    trackId: '',
    chrom: req.chrom,
    binSize: req.binSize,
    binIndex: Math.floor(req.start / req.binSize),
    start: BigInt(req.start),
    end: BigInt(req.end),
    payload: 'reads',
    count,
    starts,
    startsHi,
    lengths,
    flags,
    mapq,
  };
}

/**
 * Build a coverage histogram by iterating reads and incrementing a per-bin
 * counter. `cov[b]` = number of reads whose [start, end) overlaps bin `b`.
 * This is the "good enough" approximation we use at zoomed-out levels — it's
 * cheaper than a per-base scan and the visual difference is invisible.
 */
function buildCoverageTile(
  reads: BamRecordView[],
  req: ParseBamRequest,
): CoverageTile {
  const span = req.end - req.start;
  const nBins = Math.max(0, Math.ceil(span / req.binSize));
  const values = new Float32Array(nBins);
  const regionStart = req.start;

  if (nBins > 0) {
    for (const r of reads) {
      const rs = readStart(r);
      const rlen = readLengthOnRef(r);
      const s = Math.max(req.start, rs);
      const e = Math.min(req.end, rs + rlen);
      if (e <= s) continue;
      const firstBin = Math.floor((s - regionStart) / req.binSize);
      const lastBin = Math.min(
        nBins - 1,
        Math.floor((e - 1 - regionStart) / req.binSize),
      );
      for (let b = firstBin; b <= lastBin; b++) {
        const cur = values[b];
        values[b] = (cur ?? 0) + 1;
      }
    }
  }

  return {
    key: `:${req.chrom}:${req.binSize}:${Math.floor(req.start / req.binSize)}`,
    trackId: '',
    chrom: req.chrom,
    binSize: req.binSize,
    binIndex: Math.floor(req.start / req.binSize),
    start: BigInt(req.start),
    end: BigInt(req.end),
    payload: 'coverage',
    values,
  };
}

/**
 * Core BAM parse. Constructs a `BamFile` over the request URLs and runs a
 * region query. We poll the abort watcher around the network round-trip and
 * again after packing, throwing `AbortError` if the caller cancelled.
 *
 * Returned typed-array buffers are passed back via `Comlink.transfer` for
 * zero-copy hand-off — see the `Comlink.transfer(...)` calls in `parseBamTile`.
 */
async function runBamParse(
  abortWatcher: { aborted: () => boolean },
  req: ParseBamRequest,
): Promise<ReadTile | CoverageTile> {
  if (abortWatcher.aborted()) throw abortError();

  const bam = new BamFile({
    bamUrl: req.url,
    baiUrl: req.indexUrl,
  });

  // BamFile lazily fetches the header on first use; force it now so an abort
  // during header parse is caught here rather than mid-region-fetch.
  await bam.getHeader();
  if (abortWatcher.aborted()) throw abortError();

  // The library accepts an AbortSignal in BamOpts; bridge our port-driven
  // watcher to a real AbortController so an abort cancels in-flight fetches
  // as well as our outer loops.
  const inner = new AbortController();
  const pollHandle = setInterval(() => {
    if (abortWatcher.aborted() && !inner.signal.aborted) inner.abort();
  }, 25);

  let records: BamRecordView[];
  try {
    records = (await bam.getRecordsForRange(req.chrom, req.start, req.end, {
      signal: inner.signal,
    })) as unknown as BamRecordView[];
  } catch (err) {
    if (
      abortWatcher.aborted() ||
      (err instanceof Error && err.name === 'AbortError')
    ) {
      throw abortError();
    }
    throw err;
  } finally {
    clearInterval(pollHandle);
  }

  if (abortWatcher.aborted()) throw abortError();

  return req.binSize >= COVERAGE_BIN_THRESHOLD
    ? buildCoverageTile(records, req)
    : packReadTile(records, req);
}

// ─────────────────────────────────────────────────────────────────────────────
// Comlink-exposed API
// ─────────────────────────────────────────────────────────────────────────────

const api = {
  async parseBamTile(
    abortPort: MessagePort,
    req: ParseBamRequest,
  ): Promise<ReadTile | CoverageTile> {
    const w = createAbortWatcher(abortPort);
    const tile = await runBamParse(w, req);
    if (tile.payload === 'reads') {
      return Comlink.transfer(tile, [
        tile.starts.buffer,
        tile.startsHi.buffer,
        tile.lengths.buffer,
        tile.flags.buffer,
        tile.mapq.buffer,
      ]) as ReadTile;
    }
    return Comlink.transfer(tile, [tile.values.buffer]) as CoverageTile;
  },

  async parseBigWigTile(
    abortPort: MessagePort,
    _req: ParseBigWigRequest,
  ): Promise<SignalTile> {
    const w = createAbortWatcher(abortPort);
    if (w.aborted()) throw abortError();
    throw notImplemented('BigWig');
  },

  async parseFastaTile(
    abortPort: MessagePort,
    _req: ParseFastaRequest,
  ): Promise<ReferenceTile> {
    const w = createAbortWatcher(abortPort);
    if (w.aborted()) throw abortError();
    throw notImplemented('FASTA');
  },

  async parseVcfTile(
    abortPort: MessagePort,
    _req: ParseVcfRequest,
  ): Promise<VariantTile> {
    const w = createAbortWatcher(abortPort);
    if (w.aborted()) throw abortError();
    throw notImplemented('VCF');
  },
};

export type WorkerApi = typeof api;

/**
 * Test hook: lets unit tests import this module and exercise the parse
 * functions directly without spawning a worker. Not part of the worker's
 * public RPC surface.
 */
export const __api = api;

if (selfOrUndefined) {
  Comlink.expose(api, selfOrUndefined as unknown as Comlink.Endpoint);
}
