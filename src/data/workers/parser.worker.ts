/**
 * Parser worker entry — exposes the ParserApi over Comlink.
 *
 * This commit ships the RPC plumbing only; the per-format parsers are
 * stubs that throw `not implemented yet`. T1.A.3-5 (per TWO_DAY_SPRINT)
 * fill in @gmod/bam, @gmod/bbi, @gmod/indexedfasta, @gmod/vcf parsing.
 *
 * Abort-across-the-boundary protocol:
 *   The main thread creates a MessageChannel per task and passes one port
 *   to the worker as the first argument. The worker stores `aborted = true`
 *   the moment any message is received on the port; long parsers poll this
 *   flag at I/O boundaries and throw `DOMException('aborted', 'AbortError')`.
 */

import * as Comlink from 'comlink';
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
// type-only test contexts.
declare const self: DedicatedWorkerGlobalScope;

/** Set up an abort-watcher on a per-task MessagePort. */
function createAbortWatcher(port: MessagePort): { aborted: () => boolean } {
  let aborted = false;
  port.onmessage = () => {
    aborted = true;
  };
  port.start();
  return { aborted: () => aborted };
}

/** Convenience for the stub bodies — also useful once real parsers land. */
function abortError(): DOMException {
  return new DOMException('aborted', 'AbortError');
}

function notImplemented(format: string): Error {
  return new Error(
    `${format} parsing not implemented yet — see TWO_DAY_SPRINT T1.A.3-5`,
  );
}

const api = {
  async parseBamTile(
    abortPort: MessagePort,
    _req: ParseBamRequest,
  ): Promise<ReadTile | CoverageTile> {
    const w = createAbortWatcher(abortPort);
    if (w.aborted()) throw abortError();
    throw notImplemented('BAM');
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

Comlink.expose(api, self as unknown as Comlink.Endpoint);
