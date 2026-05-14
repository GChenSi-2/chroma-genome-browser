import { describe, it, expect } from 'vitest';
import { createBigWigRenderer, maxAcrossSignalTiles } from '~render/tracks-render/bigwig';
import type { SignalTile, Viewport } from '~state/types';

/**
 * Same WebGL2 stubbing pattern as `bam-pileup.test.ts` — happy-dom doesn't
 * implement WebGL2, so we fake the surface that `bigwig.ts` actually touches.
 */

interface CallLog {
  bufferData: number;
  bufferSubData: number;
  drawArraysInstanced: Array<{ mode: number; first: number; count: number; instanceCount: number }>;
  uniform1i: Array<{ name: string; value: number }>;
  uniform1f: Array<{ name: string; value: number }>;
  uniform3f: Array<{ name: string; r: number; g: number; b: number }>;
}

function fakeGL(): { gl: WebGL2RenderingContext; log: CallLog } {
  const log: CallLog = {
    bufferData: 0,
    bufferSubData: 0,
    drawArraysInstanced: [],
    uniform1i: [],
    uniform1f: [],
    uniform3f: [],
  };

  let nextHandle = 1;
  const handle = (tag: string) => ({ __id: nextHandle++, tag });

  const gl: Record<string, unknown> = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    TRIANGLE_STRIP: 0x0005,

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
    getAttribLocation: (_p: unknown, name: string) => name.length,
    getUniformLocation: (_p: unknown, name: string) => ({ __uniformId: name, name }),

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

    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},

    uniform1f: (loc: unknown, value: number) => {
      const name = (loc as { name?: string }).name ?? '';
      log.uniform1f.push({ name, value });
    },
    uniform1i: (loc: unknown, value: number) => {
      const name = (loc as { name?: string }).name ?? '';
      log.uniform1i.push({ name, value });
    },
    uniform3f: (loc: unknown, r: number, g: number, b: number) => {
      const name = (loc as { name?: string }).name ?? '';
      log.uniform3f.push({ name, r, g, b });
    },
    uniformMatrix3fv: () => {},

    drawArraysInstanced: (mode: number, first: number, count: number, instanceCount: number) => {
      log.drawArraysInstanced.push({ mode, first, count, instanceCount });
    },
  };

  return { gl: gl as unknown as WebGL2RenderingContext, log };
}

function makeSignalTile(values: number[], binSize: 128 | 1024 | 8192 = 1024): SignalTile {
  return {
    payload: 'signal',
    key: `test:chr1:${binSize}:0`,
    trackId: 'test',
    chrom: 'chr1',
    binSize,
    binIndex: 0,
    start: 0n,
    end: BigInt(values.length * binSize),
    values: Float32Array.from(values),
  };
}

function makeViewport(start: bigint, end: bigint, pxWidth = 1000, pxHeight = 400): Viewport {
  return { chrom: 'chr1', start, end, pxWidth, pxHeight };
}

const RED: readonly [number, number, number] = [1, 0, 0];

describe('createBigWigRenderer', () => {
  it('returns an object with draw, setScale, dispose', () => {
    const { gl } = fakeGL();
    const r = createBigWigRenderer(gl);
    expect(typeof r.draw).toBe('function');
    expect(typeof r.setScale).toBe('function');
    expect(typeof r.dispose).toBe('function');
    r.dispose();
  });

  it('draw with empty values is a no-op', () => {
    const { gl, log } = fakeGL();
    const r = createBigWigRenderer(gl);
    r.draw(makeSignalTile([]), makeViewport(0n, 1000n), 0, 80, 1, RED);
    expect(log.drawArraysInstanced).toHaveLength(0);
    r.dispose();
  });

  it('draws one instanced quad per bin', () => {
    const { gl, log } = fakeGL();
    const r = createBigWigRenderer(gl);
    r.draw(makeSignalTile([1, 2, 3, 4, 5]), makeViewport(0n, 5120n), 0, 80, 5, RED);
    expect(log.drawArraysInstanced).toHaveLength(1);
    expect(log.drawArraysInstanced[0]!.instanceCount).toBe(5);
    expect(log.drawArraysInstanced[0]!.count).toBe(4); // unit-quad strip verts
    r.dispose();
  });

  it('uniform u_logScale defaults to 0 (linear)', () => {
    const { gl, log } = fakeGL();
    const r = createBigWigRenderer(gl);
    r.draw(makeSignalTile([1, 2]), makeViewport(0n, 2048n), 0, 80, 2, RED);
    const logCalls = log.uniform1i.filter((c) => c.name === 'u_logScale');
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]!.value).toBe(0);
    r.dispose();
  });

  it('setScale("log") flips u_logScale to 1 on next draw', () => {
    const { gl, log } = fakeGL();
    const r = createBigWigRenderer(gl);
    r.setScale('log');
    r.draw(makeSignalTile([1, 2]), makeViewport(0n, 2048n), 0, 80, 2, RED);
    const logCalls = log.uniform1i.filter((c) => c.name === 'u_logScale');
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]!.value).toBe(1);
    r.setScale('linear');
    r.draw(makeSignalTile([1, 2]), makeViewport(0n, 2048n), 0, 80, 2, RED);
    const all = log.uniform1i.filter((c) => c.name === 'u_logScale').map((c) => c.value);
    expect(all).toEqual([1, 0]);
    r.dispose();
  });

  it('uploads tile data via bufferSubData each draw', () => {
    const { gl, log } = fakeGL();
    const r = createBigWigRenderer(gl);
    r.draw(makeSignalTile([1, 2, 3]), makeViewport(0n, 3072n), 0, 80, 3, RED);
    r.draw(makeSignalTile([1, 2, 3]), makeViewport(0n, 3072n), 0, 80, 3, RED);
    expect(log.bufferSubData).toBe(2);
    r.dispose();
  });

  it('passes the supplied color to u_color', () => {
    const { gl, log } = fakeGL();
    const r = createBigWigRenderer(gl);
    r.draw(makeSignalTile([1]), makeViewport(0n, 1024n), 0, 80, 1, [0.4, 0.6, 0.8]);
    const c = log.uniform3f.find((u) => u.name === 'u_color');
    expect(c).toBeDefined();
    expect(c!.r).toBeCloseTo(0.4);
    expect(c!.g).toBeCloseTo(0.6);
    expect(c!.b).toBeCloseTo(0.8);
    r.dispose();
  });
});

describe('maxAcrossSignalTiles', () => {
  it('returns 0 for empty iterable', () => {
    expect(maxAcrossSignalTiles([])).toBe(0);
  });

  it('returns the global max across tiles', () => {
    const a = makeSignalTile([1, 2, 3]);
    const b = makeSignalTile([5, 4, 0]);
    expect(maxAcrossSignalTiles([a, b])).toBe(5);
  });
});
