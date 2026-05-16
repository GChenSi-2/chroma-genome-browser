import { describe, it, expect } from 'vitest';
import {
  createReferenceRenderer,
  decodePackedBases,
} from '~render/tracks-render/reference';
import type { ReferenceTile, Viewport } from '~state/types';

/**
 * happy-dom has no WebGL2 — same stub pattern as the other renderer tests.
 * decodePackedBases is exported so we can also unit-test the 4-bit / 2-bp-
 * per-byte decode directly without going through GL.
 */

interface CallLog {
  bufferData: number;
  bufferSubData: number;
  drawArraysInstanced: Array<{ mode: number; count: number; instanceCount: number }>;
  uniform1f: Array<{ name: string; value: number }>;
  uniform1i: Array<{ name: string; value: number }>;
  glErrors: number;
}

function fakeGL(): { gl: WebGL2RenderingContext; log: CallLog } {
  const log: CallLog = {
    bufferData: 0,
    bufferSubData: 0,
    drawArraysInstanced: [],
    uniform1f: [],
    uniform1i: [],
    glErrors: 0,
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
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    RED: 0x1903,
    R8: 0x8229,
    UNSIGNED_BYTE: 0x1401,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    UNPACK_ALIGNMENT: 0x0cf5,
    NO_ERROR: 0,

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

    createTexture: () => handle('tex'),
    deleteTexture: () => {},
    bindTexture: () => {},
    activeTexture: () => {},
    texImage2D: () => {},
    texParameteri: () => {},
    pixelStorei: () => {},

    uniform1f: (loc: { name?: string }, value: number) => {
      log.uniform1f.push({ name: loc?.name ?? '?', value });
    },
    uniform1i: (loc: { name?: string }, value: number) => {
      log.uniform1i.push({ name: loc?.name ?? '?', value });
    },
    uniformMatrix3fv: () => {},

    drawArraysInstanced: (mode: number, _first: number, count: number, instanceCount: number) => {
      log.drawArraysInstanced.push({ mode, count, instanceCount });
    },

    getError: () => 0,
  };

  return { gl: gl as unknown as WebGL2RenderingContext, log };
}

/**
 * Build a ReferenceTile from a base-code sequence (0..4). Mirrors
 * `packReferenceSequence` in parser.worker.ts: 4 bits per base, 2 bases per
 * byte; byte `i>>1` carries base `i` in the low nibble and base `i+1` in the
 * high nibble. Codes: A=0 C=1 G=2 T=3 N=4.
 */
function makeRefTile(codes: ReadonlyArray<number>): ReferenceTile {
  const byteCount = Math.ceil(codes.length / 2);
  const packed = new Uint8Array(byteCount);
  for (let i = 0; i < codes.length; i++) {
    const byteIdx = i >> 1;
    const nibble = codes[i]! & 0x0f;
    if ((i & 1) === 0) {
      packed[byteIdx] = nibble;
    } else {
      packed[byteIdx] = (packed[byteIdx] ?? 0) | (nibble << 4);
    }
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
  it('decodes ACGTN with the 4-bit / 2-bp-per-byte writer layout', () => {
    // ACGTN -> codes [0,1,2,3,4].
    // Writer packs:
    //   byte 0 = (C<<4) | A = 0x10
    //   byte 1 = (T<<4) | G = 0x32
    //   byte 2 = (0<<4) | N = 0x04   (high nibble is padding)
    const tile = makeRefTile([0, 1, 2, 3, 4]);
    expect(tile.packed[0]).toBe(0x10);
    expect(tile.packed[1]).toBe(0x32);
    expect(tile.packed[2]).toBe(0x04);
    const out = new Float32Array(10);
    decodePackedBases(tile, 0, out);
    // (relStart + i, baseCode) pairs.
    expect(out[0]).toBe(0); expect(out[1]).toBe(0); // A
    expect(out[2]).toBe(1); expect(out[3]).toBe(1); // C
    expect(out[4]).toBe(2); expect(out[5]).toBe(2); // G
    expect(out[6]).toBe(3); expect(out[7]).toBe(3); // T
    expect(out[8]).toBe(4); expect(out[9]).toBe(4); // N
  });

  it('respects baseCount when packed has trailing padding nibble', () => {
    // 5 bases -> 3 bytes, last byte high nibble is padding.
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

  it('sets u_showLetters=0 below the 12px threshold and =1 above it', () => {
    // happy-dom does not implement canvas2d (`getContext('2d')` returns null),
    // so the renderer would normally fall back to Path A only. Patch the
    // canvas factory just for renderer construction so the atlas builds.
    const origCreate = document.createElement.bind(document);
    const stubImage = {
      data: new Uint8ClampedArray(320 * 64 * 4),
      width: 320,
      height: 64,
      colorSpace: 'srgb' as const,
    };
    const stubCtx = {
      clearRect: () => {},
      fillText: () => {},
      getImageData: () => stubImage,
      set font(_v: string) {},
      set fillStyle(_v: string) {},
      set textAlign(_v: string) {},
      set textBaseline(_v: string) {},
    };
    const orig = document.createElement;
    (document as { createElement: (tag: string) => HTMLElement }).createElement = ((
      tag: string,
    ) => {
      const el = origCreate(tag);
      if (tag === 'canvas') {
        (el as unknown as { getContext: (t: string) => unknown }).getContext = (t: string) =>
          t === '2d' ? stubCtx : null;
      }
      return el;
    }) as typeof document.createElement;

    try {
      const { gl, log } = fakeGL();
      const r = createReferenceRenderer(gl);
      // Low zoom: 100 bp across 1000 px -> 10 px / bp -> letters off.
      r.draw(makeRefTile([0, 1, 2, 3, 4]), makeViewport(0n, 100n, 1000, 400), 0, 20);
      // High zoom: 50 bp across 1000 px -> 20 px / bp -> letters on.
      r.draw(makeRefTile([0, 1, 2, 3, 4]), makeViewport(0n, 50n, 1000, 400), 0, 20);
      const showVals = log.uniform1f
        .filter((u) => u.name === 'u_showLetters')
        .map((u) => u.value);
      expect(showVals).toEqual([0.0, 1.0]);
      expect(log.drawArraysInstanced).toHaveLength(2);
      r.dispose();
    } finally {
      (document as { createElement: typeof orig }).createElement = orig;
    }
  });

  it('falls back to Path A when canvas2d is unavailable (no throw, no letters)', () => {
    // No stub: happy-dom returns null for getContext('2d'). Renderer must
    // build cleanly and produce uniform1f=0 even at high zoom.
    const { gl, log } = fakeGL();
    const r = createReferenceRenderer(gl);
    r.draw(makeRefTile([0, 1, 2, 3, 4]), makeViewport(0n, 50n, 1000, 400), 0, 20);
    const showVals = log.uniform1f
      .filter((u) => u.name === 'u_showLetters')
      .map((u) => u.value);
    expect(showVals).toEqual([0.0]);
    r.dispose();
  });
});
