/**
 * Worker pool — main-thread facade for parser workers.
 *
 * Spawns N Comlink-wrapped parser workers (default min(6, max(2, hwc-1))),
 * round-robins task assignment, and bridges AbortSignal across the worker
 * boundary via a per-task MessageChannel. See parser.worker.ts for the
 * matching abort-watcher.
 *
 * Per ARCHITECTURE §2.1 + AGENT_PLAYBOOK §2.2 (agent-data ownership).
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
  ParserApi,
} from './pool-types';

export type {
  ParseBamRequest,
  ParseBigWigRequest,
  ParseFastaRequest,
  ParseVcfRequest,
  ParserApi,
} from './pool-types';

/** Comlink view of the worker (matches `WorkerApi` in parser.worker.ts). */
interface RemoteParser {
  parseBamTile(
    abortPort: MessagePort,
    req: ParseBamRequest,
  ): Promise<ReadTile | CoverageTile>;
  parseBigWigTile(
    abortPort: MessagePort,
    req: ParseBigWigRequest,
  ): Promise<SignalTile>;
  parseFastaTile(
    abortPort: MessagePort,
    req: ParseFastaRequest,
  ): Promise<ReferenceTile>;
  parseVcfTile(
    abortPort: MessagePort,
    req: ParseVcfRequest,
  ): Promise<VariantTile>;
}

export interface WorkerPoolStats {
  size: number;
  active: number;
  queued: number;
}

export interface WorkerPool extends ParserApi {
  dispose(): void;
  stats(): WorkerPoolStats;
}

export interface WorkerPoolOptions {
  /** Override the auto-detected pool size. */
  size?: number;
  /**
   * Override the worker factory. Defaults to spawning the bundled
   * parser.worker.ts module. Tests pass an in-process worker.
   */
  workerFactory?: () => Worker;
}

const MIN_SIZE = 2;
const MAX_SIZE = 6;

function defaultPoolSize(): number {
  const hwc = globalThis.navigator?.hardwareConcurrency ?? 4;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, hwc - 1));
}

function defaultWorkerFactory(): Worker {
  return new Worker(new URL('./parser.worker.ts', import.meta.url), {
    type: 'module',
    name: 'chroma-parser',
  });
}

interface PoolWorker {
  worker: Worker;
  remote: Comlink.Remote<RemoteParser>;
}

export function createWorkerPool(opts: WorkerPoolOptions = {}): WorkerPool {
  const size = Math.max(1, opts.size ?? defaultPoolSize());
  const workerFactory = opts.workerFactory ?? defaultWorkerFactory;

  const workers: PoolWorker[] = [];
  for (let i = 0; i < size; i++) {
    const w = workerFactory();
    const remote = Comlink.wrap<RemoteParser>(w);
    workers.push({ worker: w, remote });
  }

  let rrCounter = 0;
  let active = 0;
  let disposed = false;

  function nextWorker(): PoolWorker {
    if (workers.length === 0) {
      throw new Error('Worker pool is empty');
    }
    const idx = rrCounter % workers.length;
    rrCounter = (rrCounter + 1) % Number.MAX_SAFE_INTEGER;
    const w = workers[idx];
    if (!w) throw new Error('Worker pool index miss');
    return w;
  }

  /**
   * Wraps a worker RPC with the per-task MessagePort abort protocol.
   *
   * `invoke` must call the remote method with the worker side of the
   * channel as its first argument (Comlink will transfer the port).
   */
  async function withAbortPort<T>(
    signal: AbortSignal,
    invoke: (workerPort: MessagePort) => Promise<T>,
  ): Promise<T> {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const channel = new MessageChannel();
    const mainPort = channel.port1;
    const workerPort = channel.port2;

    // Explicit annotation: the `if (signal.aborted) throw` above narrows
    // `signal.aborted` to `false`, which would make TS infer this `let` as
    // the literal `false` and reject the `= true` assignment below.
    let aborted: boolean = signal.aborted;
    const onAbort = (): void => {
      aborted = true;
      // Notify worker side; any message triggers its abort flag.
      try {
        mainPort.postMessage('abort');
      } catch {
        // port already closed — fine
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });

    active++;
    try {
      const result = await invoke(Comlink.transfer(workerPort, [workerPort]));
      // If the caller aborted but the worker still resolved, prefer the
      // abort outcome (consistent with fetch + AbortController semantics).
      if (aborted) throw new DOMException('aborted', 'AbortError');
      return result;
    } finally {
      signal.removeEventListener('abort', onAbort);
      try {
        mainPort.close();
      } catch {
        // ignore
      }
      active--;
    }
  }

  const api: WorkerPool = {
    // The explicit generic on withAbortPort works around Comlink.Remote
    // distributing unions through Promise — without it TS would see the BAM
    // call as `Promise<ReadTile> | Promise<CoverageTile>` and reject the
    // assignment to `Promise<ReadTile | CoverageTile>`.
    parseBamTile(req, signal) {
      if (disposed) {
        return Promise.reject(new Error('WorkerPool disposed'));
      }
      const target = nextWorker();
      return withAbortPort<ReadTile | CoverageTile>(signal, (port) =>
        target.remote.parseBamTile(port, req),
      );
    },

    parseBigWigTile(req, signal) {
      if (disposed) {
        return Promise.reject(new Error('WorkerPool disposed'));
      }
      const target = nextWorker();
      return withAbortPort<SignalTile>(signal, (port) =>
        target.remote.parseBigWigTile(port, req),
      );
    },

    parseFastaTile(req, signal) {
      if (disposed) {
        return Promise.reject(new Error('WorkerPool disposed'));
      }
      const target = nextWorker();
      return withAbortPort<ReferenceTile>(signal, (port) =>
        target.remote.parseFastaTile(port, req),
      );
    },

    parseVcfTile(req, signal) {
      if (disposed) {
        return Promise.reject(new Error('WorkerPool disposed'));
      }
      const target = nextWorker();
      return withAbortPort<VariantTile>(signal, (port) =>
        target.remote.parseVcfTile(port, req),
      );
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const w of workers) {
        try {
          w.remote[Comlink.releaseProxy]();
        } catch {
          // ignore proxy-release failures
        }
        try {
          w.worker.terminate();
        } catch {
          // ignore
        }
      }
      workers.length = 0;
    },

    stats() {
      return {
        size: workers.length,
        active,
        queued: 0,
      };
    },
  };

  return api;
}
