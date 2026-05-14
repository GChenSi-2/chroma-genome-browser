import { describe, it, expect } from 'vitest';
import {
  createReferenceRenderer,
  decodePackedBases,
} from '~render/tracks-render/reference';
import type { ReferenceTile, Viewport } from '~state/types';

/**
 * happy-dom has no WebGL2 — same stub pattern as the other renderer tests.
 * decodePackedBases is exported so we can also unit-test the 2-bit decode
 * directly without going through GL.
 */

interface CallLog {
  bufferData: number;
  bufferSubData: number;
  drawArraysInstanced: Array<{ mode: number; count: number; instanceCount: number }>;
}

function fakeGL(): { gl: WebGL2RenderingContext; log: CallLog } {
  const log: CallLog = {
    bufferData: 0,
    bufferSubData: 0,
    drawArraysInstanced: [],
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

    uniformMatrix3fv: () => {},

    drawArraysInstanced: (mode: number, _first: number, count: number, instanceCount: number) => {
      log.drawArraysInstanced.push({ mode, count, instanceCount });
    },
  };

  return { gl: gl as unknown as WebGL2RenderingContext, log };
}

/**
 * Build a ReferenceTile from a base-code sequence (0..4). Packs MSB-first,
 * 4 bases per byte. This is the inverse of `decodePackedBases`'s contract.
 */
function makeRefTile(codes: ReadonlyArray<number>): ReferenceTile {
  const byteCount = Math.ceil(codes.length / 4);
  const packed = new Uint8Array(byteCount);
  for (let i = 0; i < codes.length; i++) {
    const byteIdx = i >> 2;
    const shift = 6 - ((i & 3) << 1);
    packed[byteIdx]! |= ((codes[i]! & 0x3) << shift);
  }
  return {
    payload: 'reference',
    key: 'test:chr1:65536:0',
    trackId: 'test',
    chrom: 'chr1',
    binSize: 65_536,
    binIndex: 0,
    start: 0n,
    end: BigInt(codes.length),
    packed,
    baseCount: codes.length,
  };
}

function makeViewport(start: bigint, end: bigint, pxWidth = 1000, pxHeight = 400): Viewport {
  return { chrom: 'chr1', start, end, pxWidth, pxHeight };
}

describe('decodePackedBases', () => {
  it('decodes a 4-base byte MSB-first', () => {
    // A=0, C=1, G=2, T=3 → bits: 00 01 10 11 → 0b00011011 = 0x1B
    const tile = makeRefTile([0, 1, 2, 3]);
    expect(tile.packed[0]).toBe(0x1b);
    const out = new Float32Array(8);
    decodePackedBases(tile, 0, out);
    // Expect [posX, code, posX, code, ...]
    expect(out[0]).toBe(0); expect(out[1]).toBe(0); // A
    expect(out[2]).toBe(1); expect(out[3]).toBe(1); // C
    expect(out[4]).toBe(2); expect(out[5]).toBe(2); // G
    expect(out[6]).toBe(3); expect(out[7]).toBe(3); // T
  });

  it('respects baseCount when packed has trailing padding bits', () => {
    // 5 bases → 2 bytes, last byte has 3 bases worth of padding.
    const codes = [3, 2, 1, 0, 3];
    const tile = makeRefTile(codes);
    const out = new Float32Array(10);
    decodePackedBases(tile, 100, out);
    for (let i = 0; i < codes.length; i++) {
      expect(out[i * 2]).toBe(100 + i);
      expect(out[i * 2 + 1]).toBe(codes[i]);
    }
  });

  it('applies the relStart offset to every position', () => {
    const tile = makeRefTile([0, 1, 2]);
    const out = new Float32Array(6);
    decodePackedBases(tile, 500, out);
    expect(out[0]).toBe(500);
    expect(out[2]).toBe(501);
    expect(out[4]).toBe(502);
  });
});

describe('createReferenceRenderer', () => {
  it('returns { draw, dispose }', () => {
    const { gl } = fakeGL();
    const r = createReferenceRenderer(gl);
    expect(typeof r.draw).toBe('function');
    expect(typeof r.dispose).toBe('function');
    r.dispose();
  });

  it('draw with baseCount=0 is a no-op', () => {
    const { gl, log } = fakeGL();
    const r = createReferenceRenderer(gl);
    r.draw(makeRefTile([]), makeViewport(0n, 100n), 0, 20);
    expect(log.drawArraysInstanced).toHaveLength(0);
    r.dispose();
  });

  it('draws one instanced quad per base', () => {
    const { gl, log } = fakeGL();
    const r = createReferenceRenderer(gl);
    r.draw(makeRefTile([0, 1, 2, 3, 0]), makeViewport(0n, 100n), 0, 20);
    expect(log.drawArraysInstanced).toHaveLength(1);
    expect(log.drawArraysInstanced[0]!.instanceCount).toBe(5);
    expect(log.drawArraysInstanced[0]!.count).toBe(4); // unit-quad strip
    r.dispose();
  });

  it('uploads instance data via bufferSubData each draw', () => {
    const { gl, log } = fakeGL();
    const r = createReferenceRenderer(gl);
    r.draw(makeRefTile([0, 1, 2]), makeViewport(0n, 100n), 0, 20);
    r.draw(makeRefTile([0, 1, 2]), makeViewport(0n, 100n), 0, 20);
    expect(log.bufferSubData).toBe(2);
    r.dispose();
  });
});
