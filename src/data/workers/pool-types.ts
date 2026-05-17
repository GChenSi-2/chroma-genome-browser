/**
 * Request types shared between the worker pool facade (main thread) and the
 * parser worker. Pure types — no runtime — so the worker bundle does not
 * pull in main-thread code.
 */

import type {
  BinSize,
  CoverageTile,
  ReadTile,
  ReferenceTile,
  SignalTile,
  VariantTile,
} from '~state/types';

export interface ParseBamRequest {
  url: string;
  indexUrl: string;
  chrom: string;
  start: number;
  end: number;
  binSize: BinSize;
  /** Pileup-tier read cap; see BamTrack.maxReads for semantics. Ignored at
   *  coverage tier (binSize >= COVERAGE_BIN_THRESHOLD in parser.worker). */
  maxReads?: number;
}

export interface ParseBigWigRequest {
  url: string;
  chrom: string;
  start: number;
  end: number;
  binSize: BinSize;
}

export interface ParseFastaRequest {
  url: string;
  faiUrl: string;
  chrom: string;
  start: number;
  end: number;
}

export interface ParseVcfRequest {
  url: string;
  indexUrl: string;
  chrom: string;
  start: number;
  end: number;
  binSize: BinSize;
}

export interface ParserApi {
  parseBamTile(req: ParseBamRequest, signal: AbortSignal): Promise<ReadTile | CoverageTile>;
  parseBigWigTile(req: ParseBigWigRequest, signal: AbortSignal): Promise<SignalTile>;
  parseFastaTile(req: ParseFastaRequest, signal: AbortSignal): Promise<ReferenceTile>;
  parseVcfTile(req: ParseVcfRequest, signal: AbortSignal): Promise<VariantTile>;
}
