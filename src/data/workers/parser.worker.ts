/**
 * Parser worker entry — exposes the ParserApi over Comlink.
 *
 * Per-format status:
 *   - BAM      → implemented via @gmod/bam (T1.A.3)
 *   - BigWig   → implemented via @gmod/bbi (T1.A.4, this commit)
 *   - FASTA    → implemented via @gmod/indexedfasta (T1.A.5, this commit)
 *   - VCF      → stub (T2.E.1)
 *
 * Abort-across-the-boundary protocol:
 *   The main thread creates a MessageChannel per task and passes one port
 *   to the worker as the first argument. The worker stores `aborted = true`
 *   the moment any message is received on the port; long parsers poll this
 *   flag at I/O boundaries and throw `DOMException('aborted', 'AbortError')`.
 *
 * Filehandle wiring (M2 prep):
 *   - BamFile / BigWig accept `{ url: string }` and build their own
 *     RemoteFile internally.
 *   - IndexedFasta only accepts filehandles, so the worker ships a minimal
 *     `MinimalRemoteFile` class that implements the `read`/`readFile`/`stat`/
 *     `close` surface IndexedFasta touches, directly over `fetch`. This
 *     avoids a hard dep on `generic-filehandle2` (currently transitive only;
 *     see NEEDS_DEPS.md if we'd rather pull it in as a direct dep).
 */

import * as Comlink from 'comlink';
import { BamFile } from '@gmod/bam';
import { BigWig } from '@gmod/bbi';
import { IndexedFasta } from '@gmod/indexedfasta';
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

/**
 * Uniform decimation: pick every (n/want)-th element so the kept reads
 * still span the full source range. Reads are sorted by start in BAM
 * indices, so floor(i * step) preserves left→right ordering and gives an
 * even visual coverage of the tile. Cheaper than reservoir sampling and
 * deterministic across calls — important for cache reuse and snapshot
 * tests.
 */
function decimateUniform<T>(items: T[], want: number): T[] {
  const n = items.length;
  if (want <= 0 || n <= want) return items;
  const step = n / want;
  const out: T[] = new Array(want);
  for (let i = 0; i < want; i++) {
    out[i] = items[Math.floor(i * step)]!;
  }
  return out;
}

/** Below this binSize, callers want per-read detail; above, a histogram. */
const COVERAGE_BIN_THRESHOLD = 8192;

/**
 * Per-worker instance cache for the heavy index/header parsers.
 *
 * @gmod/bam, @gmod/bbi and @gmod/indexedfasta all parse a substantial
 * index/header on first use (BAI is 8.7 MB for HG00096; BBI headers can be
 * MBs). Constructing a fresh instance per tile call means re-parsing the
 * same index N times — and that JS-side parse work, not the network, was
 * the dominant cost of B1 cold load (~4-5 s for a single 32 kb BAM tile).
 *
 * Keyed by URL (BAM uses bamUrl, BigWig uses url, FASTA uses fasta+fai pair).
 * Bounded growth: in practice we open 1-3 distinct files per session.
 */
const bamCache = new Map<string, BamFile>();
const bigWigCache = new Map<string, BigWig>();
const fastaCache = new Map<string, IndexedFasta>();

function getBamFile(bamUrl: string, baiUrl: string): BamFile {
  const key = `${bamUrl}#${baiUrl}`;
  let f = bamCache.get(key);
  if (!f) {
    f = new BamFile({ bamUrl, baiUrl });
    bamCache.set(key, f);
  }
  return f;
}

function getBigWig(url: string): BigWig {
  let f = bigWigCache.get(url);
  if (!f) {
    f = new BigWig({ url });
    bigWigCache.set(url, f);
  }
  return f;
}

function getIndexedFasta(fastaUrl: string, faiUrl: string): IndexedFasta {
  const key = `${fastaUrl}#${faiUrl}`;
  let f = fastaCache.get(key);
  if (!f) {
    type IFasta = ConstructorParameters<typeof IndexedFasta>[0];
    f = new IndexedFasta({
      fasta: new MinimalRemoteFile(fastaUrl) as unknown as NonNullable<IFasta['fasta']>,
      fai: new MinimalRemoteFile(faiUrl) as unknown as NonNullable<IFasta['fai']>,
    });
    fastaCache.set(key, f);
  }
  return f;
}

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

/**
 * Bridge our port-driven abort flag to a real AbortController. Libraries
 * (@gmod/bam, @gmod/bbi, @gmod/indexedfasta) all consume `signal?: AbortSignal`
 * so this is how we cancel in-flight `fetch()` work inside them. Returns the
 * signal plus a stop fn the caller must invoke in `finally`.
 */
function bridgeAbortWatcher(
  abortWatcher: { aborted: () => boolean },
): { signal: AbortSignal; stop: () => void } {
  const inner = new AbortController();
  const handle = setInterval(() => {
    if (abortWatcher.aborted() && !inner.signal.aborted) inner.abort();
  }, 25);
  return {
    signal: inner.signal,
    stop: (): void => {
      clearInterval(handle);
    },
  };
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

  // Cached per (bamUrl, baiUrl) inside this worker — reusing the parsed BAI
  // turns repeat tile queries from ~5 s into ~50 ms.
  const bam = getBamFile(req.url, req.indexUrl);

  // BamFile lazily fetches the header on first use; force it now so an abort
  // during header parse is caught here rather than mid-region-fetch. Idempotent
  // — `getHeader` no-ops on a cached instance after the first call.
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

  // Cap-at-N for pileup tier (high-coverage BAMs like GIAB 300×).
  // Coverage tier intentionally bypasses the cap — its histogram depends
  // on counting every read in the range.
  if (req.binSize < COVERAGE_BIN_THRESHOLD && req.maxReads !== undefined && req.maxReads > 0) {
    records = decimateUniform(records, req.maxReads);
  }

  return req.binSize >= COVERAGE_BIN_THRESHOLD
    ? buildCoverageTile(records, req)
    : packReadTile(records, req);
}

// ─────────────────────────────────────────────────────────────────────────────
// BigWig parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal view of `@gmod/bbi` Feature that the binning loop reads. The
 * library returns full `Feature` objects with optional `score`/`summary`
 * extras; we only need start/end/score.
 */
interface BigWigFeatureView {
  start: number;
  end: number;
  score?: number;
}

/**
 * Aggregate per-feature scores into `bins` using a coverage-weighted mean.
 *
 *   bins[i] = Σ (score · overlap_bp) / binSize
 *
 * If `@gmod/bbi` returned features from a pre-aggregated zoom level whose
 * reduction matches `req.binSize`, each feature already represents one bin
 * and the formula collapses to `score`. For finer source data, multiple
 * features may overlap a bin and we accumulate. For coarser source data,
 * one feature may span multiple bins and we distribute by overlap.
 *
 * NaN / undefined scores are skipped (defensive: bbi sometimes returns
 * sparse arrays where missing bins have no `score` property).
 */
function aggregateBigWigFeatures(
  features: ReadonlyArray<BigWigFeatureView>,
  regionStart: number,
  regionEnd: number,
  binSize: number,
): Float32Array {
  const nBins = Math.max(0, Math.ceil((regionEnd - regionStart) / binSize));
  const bins = new Float32Array(nBins);
  if (nBins === 0) return bins;

  for (const f of features) {
    const score = typeof f.score === 'number' && Number.isFinite(f.score) ? f.score : NaN;
    if (Number.isNaN(score)) continue;
    const s = Math.max(regionStart, f.start);
    const e = Math.min(regionEnd, f.end);
    if (e <= s) continue;
    const firstBin = Math.floor((s - regionStart) / binSize);
    const lastBin = Math.min(nBins - 1, Math.floor((e - 1 - regionStart) / binSize));
    for (let b = firstBin; b <= lastBin; b++) {
      const binLo = regionStart + b * binSize;
      const binHi = binLo + binSize;
      const overlap = Math.min(e, binHi) - Math.max(s, binLo);
      if (overlap <= 0) continue;
      const cur = bins[b];
      bins[b] = (cur ?? 0) + (score * overlap) / binSize;
    }
  }
  return bins;
}

async function runBigWigParse(
  abortWatcher: { aborted: () => boolean },
  req: ParseBigWigRequest,
): Promise<SignalTile> {
  if (abortWatcher.aborted()) throw abortError();

  // Cached per URL — see note next to bamCache.
  const bw = getBigWig(req.url);
  await bw.getHeader();
  if (abortWatcher.aborted()) throw abortError();

  const { signal, stop } = bridgeAbortWatcher(abortWatcher);
  let features: BigWigFeatureView[];
  try {
    // `basesPerSpan` selects a coarser zoom level (AGENT_PLAYBOOK 9.2). We
    // hand bbi the target bin width so it picks a precomputed summary near
    // that resolution rather than reading the finest unzoomed data.
    features = (await bw.getFeatures(req.chrom, req.start, req.end, {
      basesPerSpan: req.binSize,
      signal,
    })) as unknown as BigWigFeatureView[];
  } catch (err) {
    if (
      abortWatcher.aborted() ||
      (err instanceof Error && err.name === 'AbortError')
    ) {
      throw abortError();
    }
    throw err;
  } finally {
    stop();
  }

  if (abortWatcher.aborted()) throw abortError();

  const values = aggregateBigWigFeatures(
    features,
    req.start,
    req.end,
    req.binSize,
  );

  return {
    key: `:${req.chrom}:${req.binSize}:${Math.floor(req.start / req.binSize)}`,
    trackId: '',
    chrom: req.chrom,
    binSize: req.binSize,
    binIndex: Math.floor(req.start / req.binSize),
    start: BigInt(req.start),
    end: BigInt(req.end),
    payload: 'signal',
    values,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FASTA parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal `GenericFilehandle`-compatible class for FASTA over HTTP. We
 * implement only the operations IndexedFasta actually invokes:
 *
 *   - `readFile(opts?)` — fetches the entire body. Used for the .fai sidecar
 *     (small text, fine to slurp).
 *   - `read(length, position, opts?)` — fetches a byte range. Used for the
 *     .fa body during `getSequence`. Maps to a Range request.
 *   - `stat()` / `close()` — required by the interface; close is a no-op,
 *     stat returns size from a HEAD or Content-Length on a 0-byte range.
 *
 * Note: typed as `unknown` at the IndexedFasta boundary because we do not
 * import the `GenericFilehandle` type (that would re-introduce the
 * `generic-filehandle2` dep). The runtime contract holds — IndexedFasta
 * calls these by name.
 */
interface MinimalFilehandleOpts {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

class MinimalRemoteFile {
  private url: string;
  private cachedSize: number | undefined;

  constructor(url: string) {
    this.url = url;
  }

  async read(
    length: number,
    position: number,
    opts: MinimalFilehandleOpts = {},
  ): Promise<Uint8Array> {
    const end = position + length - 1;
    const res = await fetch(this.url, {
      method: 'GET',
      headers: {
        ...(opts.headers ?? {}),
        Range: `bytes=${position}-${end}`,
      },
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`fetch ${this.url} failed: ${res.status} ${res.statusText}`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  async readFile(opts: MinimalFilehandleOpts = {}): Promise<Uint8Array> {
    const res = await fetch(this.url, {
      method: 'GET',
      headers: opts.headers ?? {},
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    if (!res.ok) {
      throw new Error(`fetch ${this.url} failed: ${res.status} ${res.statusText}`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  async stat(): Promise<{ size: number }> {
    if (this.cachedSize !== undefined) return { size: this.cachedSize };
    const res = await fetch(this.url, { method: 'HEAD' });
    const len = res.headers.get('content-length');
    const size = len ? Number(len) : 0;
    this.cachedSize = size;
    return { size };
  }

  async close(): Promise<void> {
    // nothing to release — every read opens its own fetch
  }
}

/** Encode a single base char to a 4-bit code. */
function codeOfBase(ch: string): number {
  switch (ch) {
    case 'A':
    case 'a':
      return 0;
    case 'C':
    case 'c':
      return 1;
    case 'G':
    case 'g':
      return 2;
    case 'T':
    case 't':
      return 3;
    default:
      return 4; // N or any other IUPAC code
  }
}

/**
 * Pack a sequence string into 4 bits per base (one nibble each).
 *
 * ARCHITECTURE Sec 3.3 originally specified 2-bit packing — but 2 bits only
 * encodes ACGT, so N (and any ambiguous IUPAC code) would either alias to a
 * real base or require an out-of-band sentinel. 4-bit packing is the smallest
 * representation that fits {A, C, G, T, N} with room for soft-clip / IUPAC
 * codes in later milestones. Memory cost is 2x the 2-bit scheme; for a 65,536
 * bp tile this is 32 KB → 16 KB → still well under the cache budget.
 *
 * Layout: byte `i >> 1` carries base `i` in the low nibble and base `i+1` in
 * the high nibble. Odd-length tails leave the high nibble of the last byte
 * as 0 (interpreted as 'A' — callers must clamp at `baseCount` to avoid
 * reading the padding).
 */
function packReferenceSequence(seq: string): Uint8Array {
  const packed = new Uint8Array(Math.ceil(seq.length / 2));
  for (let i = 0; i < seq.length; i++) {
    const ch = seq.charAt(i);
    const code = codeOfBase(ch);
    const byteIdx = i >> 1;
    if ((i & 1) === 0) {
      packed[byteIdx] = code;
    } else {
      packed[byteIdx] = (packed[byteIdx] ?? 0) | (code << 4);
    }
  }
  return packed;
}

async function runFastaParse(
  abortWatcher: { aborted: () => boolean },
  req: ParseFastaRequest,
): Promise<ReferenceTile> {
  if (abortWatcher.aborted()) throw abortError();

  // Cached per (fasta, fai) pair — see note next to bamCache.
  const fasta = getIndexedFasta(req.url, req.faiUrl);

  const { signal, stop } = bridgeAbortWatcher(abortWatcher);
  let seq: string;
  try {
    const result = await fasta.getSequence(req.chrom, req.start, req.end, {
      signal,
    });
    seq = result ?? '';
  } catch (err) {
    if (
      abortWatcher.aborted() ||
      (err instanceof Error && err.name === 'AbortError')
    ) {
      throw abortError();
    }
    throw err;
  } finally {
    stop();
  }

  if (abortWatcher.aborted()) throw abortError();

  const packed = packReferenceSequence(seq);
  // For reference tiles we use a fixed conceptual binSize so the cache key
  // ladder stays consistent; track-engine drives this via REFERENCE_BIN_SIZE.
  // We mirror that here (65_536) as the binSize encoded in the key/metadata.
  const binSize = 65_536;
  const binIndex = Math.floor(req.start / binSize);

  return {
    key: `:${req.chrom}:${binSize}:${binIndex}`,
    trackId: '',
    chrom: req.chrom,
    binSize,
    binIndex,
    start: BigInt(req.start),
    end: BigInt(req.end),
    payload: 'reference',
    packed,
    baseCount: seq.length,
  };
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
    req: ParseBigWigRequest,
  ): Promise<SignalTile> {
    const w = createAbortWatcher(abortPort);
    const tile = await runBigWigParse(w, req);
    return Comlink.transfer(tile, [tile.values.buffer]) as SignalTile;
  },

  async parseFastaTile(
    abortPort: MessagePort,
    req: ParseFastaRequest,
  ): Promise<ReferenceTile> {
    const w = createAbortWatcher(abortPort);
    const tile = await runFastaParse(w, req);
    return Comlink.transfer(tile, [tile.packed.buffer]) as ReferenceTile;
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

/** Test-only re-export of the uniform decimator. Real code reaches it
 *  through the read-cap branch in `runBamParse`. */
export const _decimateUniform = decimateUniform;

if (selfOrUndefined) {
  Comlink.expose(api, selfOrUndefined as unknown as Comlink.Endpoint);
}
