import { describe, it, expect, vi } from 'vitest';
import {
  assignPileupRows,
  createPileupRenderer,
} from '~render/tracks-render/bam-pileup';
import type { ReadTile, Viewport } from '~state/types';

/**
 * happy-dom does not implement WebGL2. We stub the surface that
 * `bam-pileup.ts` actually touches:
 *
 *   - shader compile + link (always succeeds — covered separately in
 *     `program.test.ts`)
 *   - attribute / uniform lookup
 *   - buffer / VAO lifecycle
 *   - vertex-attribute pointer / divisor calls
 *   - drawArraysInstanced
 *
 * The stub records calls so individual tests can assert on them.
 */

interface CallLog {
  bufferData: number;
  bufferSubData: number;
  drawArraysInstanced: Array<{ mode: number; first: number; count: number; instanceCount: number }>;
  uniform1i: Array<{ loc: unknown; value: number }>;
}

function fakeGL(): { gl: WebGL2RenderingContext; log: CallLog } {
  const log: CallLog = {
    bufferData: 0,
    bufferSubData: 0,
    drawArraysInstanced: [],
    uniform1i: [],
  };

  let nextHandle = 1;
  const handle = (tag: string) => ({ __id: nextHandle++, tag });

  const gl: Record<string, unknown> = {
    // Enums actually used (values mirror the WebGL2 spec).
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    UNSIGNED_INT: 0x1405,
    TRIANGLE_STRIP: 0x0005,

    // Shader / program lifecycle.
    createShader: () => handle('shader'),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: (_s: unknown, p: number) => p === 0x8b81,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    createProgram: () => handle('program'),
    attachShader: () => {},
    detachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: (_p: unknown, p: number) => p === 0x8b82,
    getProgramInfoLog: () => '',
    deleteProgram: () => {},
    useProgram: () => {},
    getAttribLocation: (_p: unknown, name: string) =>
      // Distinct, deterministic, all >= 0.
      name.length,
    getUniformLocation: (_p: unknown, name: string) =>
      ({ __uniformId: name, name }),

    // Buffer / VAO.
    createBuffer: () => handle('buf'),
    deleteBuffer: () => {},
    bindBuffer: () => {},
    bufferData: () => {
      log.bufferData++;
    },
    bufferSubData: () => {
      log.bufferSubData++;
    },
    createVertexArray: () => handle('vao'),
    deleteVertexArray: () => {},
    bindVertexArray: () => {},

    // Attribute pointers.
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribIPointer: () => {},
    vertexAttribDivisor: () => {},

    // Uniform setters.
    uniform1f: () => {},
    uniform1i: (loc: unknown, value: number) => {
      log.uniform1i.push({ loc, value });
    },
    uniform2f: () => {},
    uniformMatrix3fv: () => {},

    // Draw.
    drawArraysInstanced: (mode: number, first: number, count: number, instanceCount: number) => {
      log.drawArraysInstanced.push({ mode, first, count, instanceCount });
    },
  };

  return { gl: gl as unknown as WebGL2RenderingContext, log };
}

function makeTile(reads: ReadonlyArray<{ start: number; len: number; flags?: number; mapq?: number }>): ReadTile {
  const n = reads.length;
  const starts = new Int32Array(n);
  const startsHi = new Int32Array(n);
  const lengths = new Uint16Array(n);
  const flags = new Uint16Array(n);
  const mapq = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = reads[i]!;
    starts[i] = r.start;
    lengths[i] = r.len;
    flags[i] = r.flags ?? 0;
    mapq[i] = r.mapq ?? 60;
  }
  return {
    payload: 'reads',
    key: 'test:chr1:128:0',
    trackId: 'test',
    chrom: 'chr1',
    binSize: 128,
    binIndex: 0,
    start: 0n,
    end: 10_000n,
    count: n,
    starts,
    startsHi,
    lengths,
    flags,
    mapq,
  };
}

function makeViewport(start: bigint, end: bigint, pxWidth = 1000, pxHeight = 400): Viewport {
  return { chrom: 'chr1', start, end, pxWidth, pxHeight };
}

describe('assignPileupRows', () => {
  it('assigns three non-overlapping intervals to rows 0, 1, 0', () => {
    // [0..10] -> row 0; [5..15] overlaps row 0 -> row 1; [20..30] no overlap -> row 0
    const tile = makeTile([
      { start: 0, len: 10 },
      { start: 5, len: 10 },
      { start: 20, len: 10 },
    ]);
    const { rows, maxRowUsed } = assignPileupRows(tile, 8);
    expect(rows[0]).toBe(0);
    expect(rows[1]).toBe(1);
    expect(rows[2]).toBe(0);
    expect(maxRowUsed).toBe(1);
  });

  it('collapses overflow reads to the last row when maxRows is exceeded', () => {
    // 250 reads all starting at 0 with length 100 → need 250 rows, allowed 4.
    const reads = Array.from({ length: 250 }, () => ({ start: 0, len: 100 }));
    const tile = makeTile(reads);
    const { rows, maxRowUsed } = assignPileupRows(tile, 4);
    // First 4 fill rows 0..3, remaining 246 must collapse to row 3 (last).
    expect(rows[0]).toBe(0);
    expect(rows[1]).toBe(1);
    expect(rows[2]).toBe(2);
    expect(rows[3]).toBe(3);
    expect(rows[249]).toBe(3);
    expect(maxRowUsed).toBe(3);
  });

  it('returns maxRowUsed 0 when all reads pack onto a single row', () => {
    const tile = makeTile([
      { start: 0, len: 10 },
      { start: 20, len: 10 },
      { start: 40, len: 10 },
    ]);
    const { rows, maxRowUsed } = assignPileupRows(tile, 16);
    expect(rows[0]).toBe(0);
    expect(rows[1]).toBe(0);
    expect(rows[2]).toBe(0);
    expect(maxRowUsed).toBe(0);
  });
});

describe('createPileupRenderer', () => {
  it('returns an object with draw, dispose, stats', () => {
    const { gl } = fakeGL();
    const r = createPileupRenderer(gl);
    expect(typeof r.draw).toBe('function');
    expect(typeof r.dispose).toBe('function');
    expect(typeof r.stats).toBe('function');
    r.dispose();
  });

  it('draw with count: 0 is a no-op (no drawArraysInstanced)', () => {
    const { gl, log } = fakeGL();
    const r = createPileupRenderer(gl);
    const tile = makeTile([]);
    r.draw(tile, makeViewport(0n, 1000n), 0);
    expect(log.drawArraysInstanced).toHaveLength(0);
    expect(r.stats()).toEqual({ readCount: 0, drawTimeMs: 0, rowsUsed: 0 });
    r.dispose();
  });

  it('draw with N reads invokes drawArraysInstanced with instanceCount === N', () => {
    const { gl, log } = fakeGL();
    const r = createPileupRenderer(gl);
    const tile = makeTile([
      { start: 0, len: 50 },
      { start: 100, len: 50 },
      { start: 200, len: 50 },
      { start: 300, len: 50 },
    ]);
    r.draw(tile, makeViewport(0n, 1000n), 0);
    expect(log.drawArraysInstanced).toHaveLength(1);
    expect(log.drawArraysInstanced[0]!.instanceCount).toBe(4);
    expect(log.drawArraysInstanced[0]!.count).toBe(4); // TRIANGLE_STRIP verts
    r.dispose();
  });

  it('uploads instance data via bufferSubData every draw', () => {
    const { gl, log } = fakeGL();
    const r = createPileupRenderer(gl);
    const tile = makeTile([{ start: 0, len: 50 }]);
    r.draw(tile, makeViewport(0n, 1000n), 0);
    r.draw(tile, makeViewport(0n, 1000n), 0);
    // Each draw issues exactly one bufferSubData (no per-frame growth here).
    expect(log.bufferSubData).toBe(2);
    r.dispose();
  });

  it('mismatch uniform is wired and defaults to 0 (T1.B.3 atlas disabled)', () => {
    const { gl, log } = fakeGL();
    const r = createPileupRenderer(gl);
    const tile = makeTile([{ start: 0, len: 50 }]);
    r.draw(tile, makeViewport(0n, 1000n), 0);
    const calls = log.uniform1i.filter(
      (c) =>
        typeof c.loc === 'object' &&
        c.loc !== null &&
        (c.loc as { name?: string }).name === 'u_showMismatches',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.value).toBe(0);
    r.dispose();
  });

  it('stats reflect last draw — readCount and rowsUsed', () => {
    const { gl } = fakeGL();
    const r = createPileupRenderer(gl);
    // 3 fully overlapping reads → 3 rows.
    const tile = makeTile([
      { start: 0, len: 100 },
      { start: 0, len: 100 },
      { start: 0, len: 100 },
    ]);
    r.draw(tile, makeViewport(0n, 1000n), 0);
    expect(r.stats().readCount).toBe(3);
    expect(r.stats().rowsUsed).toBe(3);
    r.dispose();
  });

  it('orphans the instance buffer on every draw to break cross-tile races', () => {
    const { gl, log } = fakeGL();
    const r = createPileupRenderer(gl);
    // The renderer calls bufferData once for the static quad at construction;
    // every subsequent draw orphans the per-instance buffer via bufferData so
    // queued draws on the same buffer don't see overwritten contents from a
    // later draw in the same frame. See the inline note in `bam-pileup.ts`.
    const before = log.bufferData;

    r.draw(makeTile([
      { start: 0, len: 50 },
      { start: 100, len: 50 },
      { start: 200, len: 50 },
      { start: 300, len: 50 },
    ]), makeViewport(0n, 1000n), 0);
    const afterFirst = log.bufferData;
    expect(afterFirst).toBeGreaterThan(before);

    // Second draw same size: still orphans (count bumps by exactly 1).
    r.draw(makeTile([
      { start: 0, len: 50 },
      { start: 100, len: 50 },
      { start: 200, len: 50 },
      { start: 300, len: 50 },
    ]), makeViewport(0n, 1000n), 0);
    expect(log.bufferData).toBe(afterFirst + 1);
    r.dispose();
  });

  it('warns on unused attribute names (sanity — shaders compile)', () => {
    // This test exercises the construction path with a fresh stub. It also
    // ensures createPileupRenderer doesn't throw on an environment that
    // returns a sentinel for every name.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { gl } = fakeGL();
    const r = createPileupRenderer(gl);
    r.dispose();
    // Our stub does not flag any name as missing, so warn should be silent.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
