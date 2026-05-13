// @vitest-environment node
/**
 * Worker pool unit tests.
 *
 * Workers and happy-dom do not play well together, so this file opts into
 * the `node` environment and uses an injected `workerFactory` to construct
 * fakes that mimic the Comlink endpoint contract — no actual `Worker`
 * threads are spawned.
 *
 * (The pool also ships a default factory that uses
 * `new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' })`
 * which Vite handles in production. For test stability we don't exercise it
 * here because it requires the full bundler pipeline.)
 */
import { describe, expect, it } from 'vitest';
import { createWorkerPool } from '~data/workers/pool';
import type { BinSize } from '~state/types';

// ─────────────────────────────────────────────────────────────────────────────
// A minimal Worker fake that implements Comlink's protocol locally.
//
// Comlink sends MessageEvents with `{ id, type, path, argumentList }` from
// proxy methods and listens for matching responses. For our purposes we hook
// the `message` listener directly and reply synchronously with a rejection
// (the worker's real behavior is "not implemented yet" — see
// parser.worker.ts).
// ─────────────────────────────────────────────────────────────────────────────

type Listener = (ev: MessageEvent) => void;

interface FakeWorker {
  addEventListener(type: 'message' | 'messageerror', l: Listener): void;
  removeEventListener(type: 'message' | 'messageerror', l: Listener): void;
  postMessage(msg: unknown): void;
  terminate(): void;
  /** Test hook — last APPLY message received. */
  lastApply?: unknown;
  /** Test hook — every MessagePort that the main thread transferred to us. */
  receivedPorts: MessagePort[];
  terminated: boolean;
}

type Reply = 'reject' | 'pending';

function makeFakeWorker(reply: Reply = 'reject'): FakeWorker {
  const listeners = new Set<Listener>();
  const fake: FakeWorker = {
    addEventListener(_type, l) {
      listeners.add(l);
    },
    removeEventListener(_type, l) {
      listeners.delete(l);
    },
    postMessage(msg) {
      const m = msg as {
        id?: string;
        type?: string;
        argumentList?: Array<{ type?: string; value?: unknown }>;
      };
      fake.lastApply = msg;
      // Capture transferred MessagePorts. Comlink serialises them as
      // { type: 'RAW', value: port } in the argumentList.
      if (m.argumentList) {
        for (const arg of m.argumentList) {
          if (arg && arg.type === 'RAW' && arg.value instanceof MessagePort) {
            fake.receivedPorts.push(arg.value);
          }
        }
      }
      if (reply === 'pending') return; // never replies; test drives abort

      setTimeout(() => {
        const id = m.id;
        if (id === undefined) return;
        const ev = new MessageEvent('message', {
          data: {
            id,
            type: 'HANDLER',
            name: 'throw',
            value: { isError: true, value: new Error('not implemented yet') },
          },
        });
        for (const l of listeners) l(ev);
      }, 0);
    },
    terminate() {
      fake.terminated = true;
      listeners.clear();
    },
    receivedPorts: [],
    terminated: false,
  };
  return fake;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_BAM = {
  url: 'https://x/a.bam',
  indexUrl: 'https://x/a.bam.bai',
  chrom: 'chr1',
  start: 0,
  end: 1000,
  binSize: 128 as BinSize,
};

describe('createWorkerPool', () => {
  it('spawns the requested number of workers', () => {
    const made: FakeWorker[] = [];
    const pool = createWorkerPool({
      size: 4,
      workerFactory: () => {
        const w = makeFakeWorker('reject');
        made.push(w);
        return w as unknown as Worker;
      },
    });

    expect(made).toHaveLength(4);
    expect(pool.stats().size).toBe(4);
    pool.dispose();
  });

  it('parseBamTile returns a rejected promise (proves RPC plumbing)', async () => {
    const pool = createWorkerPool({
      size: 1,
      workerFactory: () => makeFakeWorker('reject') as unknown as Worker,
    });

    const ac = new AbortController();
    await expect(pool.parseBamTile(SAMPLE_BAM, ac.signal)).rejects.toThrow(
      /not implemented/,
    );

    pool.dispose();
  });

  it('AbortSignal causes a message to be visible on the worker side', async () => {
    // 'pending' fake never replies — the RPC stays in-flight so the
    // abort handler remains attached for our abort() trigger.
    const fake = makeFakeWorker('pending');
    const pool = createWorkerPool({
      size: 1,
      workerFactory: () => fake as unknown as Worker,
    });

    const ac = new AbortController();
    // Fire and never await — the call stays pending. We don't care about
    // the result; we only care that aborting forwards a message through.
    void pool.parseBamTile(SAMPLE_BAM, ac.signal).catch(() => {
      // ignore; the worker never replies in this test
    });

    // Yield so the synchronous postMessage on the fake has run.
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.receivedPorts.length).toBe(1);

    const workerSidePort = fake.receivedPorts[0];
    expect(workerSidePort).toBeDefined();

    const sawAbortMessage = new Promise<unknown>((resolve) => {
      workerSidePort!.onmessage = (ev) => resolve(ev.data);
      workerSidePort!.start();
    });

    ac.abort();
    const seen = await sawAbortMessage;
    expect(seen).toBe('abort');

    pool.dispose();
  });

  it('dispose() terminates all workers and subsequent calls reject', async () => {
    const made: FakeWorker[] = [];
    const pool = createWorkerPool({
      size: 3,
      workerFactory: () => {
        const w = makeFakeWorker('reject');
        made.push(w);
        return w as unknown as Worker;
      },
    });

    pool.dispose();
    for (const w of made) expect(w.terminated).toBe(true);

    await expect(
      pool.parseBamTile(SAMPLE_BAM, new AbortController().signal),
    ).rejects.toThrow(/disposed/);
  });
});
