/**
 * Reference (FASTA) renderer — Path A: one colored 1-bp-wide quad per base.
 *
 * TWO_DAY_SPRINT T1.B.6. Letter overlay (Path B) is intentionally deferred —
 * a real SDF font atlas is out of M2 prep scope and the task explicitly
 * forbids adding binary atlas assets. Letters land in a follow-up commit.
 *
 * Encoding contract (`ReferenceTile.packed`):
 *   - Per `~state/types`: 2-bit packed bases, A=0 / C=1 / G=2 / T=3, N=4 via
 *     overflow byte. Agent-data hasn't shipped the FASTA worker yet, so we
 *     decode the 2-bit core and fall back to N for any out-of-range code.
 *     Bases are packed MSB-first within each byte (4 bases per byte). When
 *     agent-data's worker lands, verify by snapshot test against a known
 *     reference slice; this comment is the canonical decoder contract.
 *   - `baseCount` is the authoritative valid-base count; the trailing bits
 *     of the last byte may be padding.
 *
 * Hot-path discipline (BENCHMARKS §6):
 *   - draw() does not allocate beyond pool growth.
 *   - 2-bit decode runs once per draw into a Float32 scratch [relStartBp,
 *     baseCode] pair per base. Per-base color lookup happens in the vertex
 *     shader via a constant `vec3 BASE_COLORS[5]` array indexed by baseCode.
 *   - One instanced draw call per tile.
 *
 * Path B (letters) hand-off:
 *   - Skipped in this commit. Approach when picked up: Canvas2D pre-bake a
 *     1×5 texture atlas of A/C/G/T/N glyphs at module init (allowed because
 *     it's one-shot, not per-frame canvas2d). Sample in the fragment shader
 *     gated on a `u_showLetters` uniform when basePixelWidth ≥ 12.
 */

import { createProgram, type Program } from '../webgl/program';
import { float32Pool } from '../webgl/buffer-pool';
import { buildViewMatrix } from '../coord';
import type { ReferenceTile, Viewport } from '~state/types';

// Base colors from DESIGN_SYSTEM §2.2.
//   A: #4caf50  (0.298, 0.686, 0.314)
//   C: #2196f3  (0.129, 0.588, 0.953)
//   G: #ff9800  (1.000, 0.596, 0.000)
//   T: #f44336  (0.957, 0.263, 0.212)
//   N: #9e9e9e  (0.620, 0.620, 0.620)
const VERT_SRC = /* glsl */ `#version 300 es
precision highp float;

in vec2 a_quad;
in vec2 a_pos;   // (relStartBp, baseCode)  baseCode ∈ {0,1,2,3,4}

uniform mat3 u_view;

out vec3 v_color;

const vec3 BASE_COLORS[5] = vec3[5](
  vec3(0.298, 0.686, 0.314),  // A
  vec3(0.129, 0.588, 0.953),  // C
  vec3(1.000, 0.596, 0.000),  // G
  vec3(0.957, 0.263, 0.212),  // T
  vec3(0.620, 0.620, 0.620)   // N
);

void main() {
  // Each base is a 1-bp-wide column spanning the full track band (y ∈ [0,1]).
  vec2 localPos = vec2(a_pos.x + a_quad.x, a_quad.y);
  vec3 ndc = u_view * vec3(localPos, 1.0);
  gl_Position = vec4(ndc.xy, 0.0, 1.0);

  int code = int(clamp(a_pos.y, 0.0, 4.0));
  v_color = BASE_COLORS[code];
}
`;

const FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_color;
out vec4 outColor;
void main() {
  outColor = vec4(v_color, 1.0);
}
`;

export interface ReferenceRenderer {
  /** Draw a reference tile into the band `[yTopPx, yTopPx + heightPx]`. */
  draw: (tile: ReferenceTile, viewport: Viewport, yTopPx: number, heightPx: number) => void;
  dispose: () => void;
}

const FLOATS_PER_INSTANCE = 2; // posX, baseCode
const STRIDE = FLOATS_PER_INSTANCE * 4;

/**
 * Decode 2-bit packed bases into the per-instance scratch buffer.
 *
 * Layout per packed byte (MSB-first):
 *   bits 7..6 = base 0
 *   bits 5..4 = base 1
 *   bits 3..2 = base 2
 *   bits 1..0 = base 3
 *
 * `out[2*i]   = relStart + i`
 * `out[2*i+1] = baseCode in [0..4]`
 *
 * Caller guarantees `out.length >= tile.baseCount * 2`.
 */
export function decodePackedBases(
  tile: ReferenceTile,
  relStart: number,
  out: Float32Array,
): void {
  const packed = tile.packed;
  const n = tile.baseCount;
  for (let i = 0; i < n; i++) {
    const byteIdx = i >> 2;
    const bitShift = 6 - ((i & 3) << 1);
    const raw = (packed[byteIdx] ?? 0) >> bitShift;
    const code = raw & 0x3;
    // Defensive: a future format extension may use code=4 for N. For pure
    // 2-bit packing every code is in 0..3 (ACGT). The shader clamps to
    // [0..4] so we just pass `code` through.
    const o = i << 1;
    out[o] = relStart + i;
    out[o + 1] = code;
  }
}

export function createReferenceRenderer(gl: WebGL2RenderingContext): ReferenceRenderer {
  const program: Program = createProgram(gl, {
    vertSrc: VERT_SRC,
    fragSrc: FRAG_SRC,
    attribs: ['a_quad', 'a_pos'],
    uniforms: ['u_view'],
    label: 'reference',
  });

  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    gl.STATIC_DRAW,
  );

  const instBuf = gl.createBuffer();
  let instCapacityBytes = 0;

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  const aQuad = program.attribs.a_quad ?? -1;
  if (aQuad >= 0) {
    gl.enableVertexAttribArray(aQuad);
    gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0);
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  const aPos = program.attribs.a_pos ?? -1;
  if (aPos >= 0) {
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, STRIDE, 0);
    gl.vertexAttribDivisor(aPos, 1);
  }

  gl.bindVertexArray(null);

  const uView = program.uniforms.u_view;

  let scratch: Float32Array | null = null;

  const draw = (
    tile: ReferenceTile,
    viewport: Viewport,
    yTopPx: number,
    heightPx: number,
  ): void => {
    const baseCount = tile.baseCount;
    if (baseCount === 0) return;

    const neededFloats = baseCount * FLOATS_PER_INSTANCE;
    if (!scratch || scratch.length < neededFloats) {
      if (scratch) float32Pool.release(scratch);
      scratch = float32Pool.acquire(neededFloats);
    }

    const tileStart = Number(tile.start - viewport.start);
    decodePackedBases(tile, tileStart, scratch);

    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    const byteLen = baseCount * STRIDE;
    // Orphan every draw — see bam-pileup.ts for rationale.
    const cap = byteLen > instCapacityBytes
      ? 1 << Math.ceil(Math.log2(byteLen))
      : instCapacityBytes;
    gl.bufferData(gl.ARRAY_BUFFER, cap, gl.DYNAMIC_DRAW);
    instCapacityBytes = cap;
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, scratch, 0, neededFloats);

    program.use();
    const view = buildViewMatrix(viewport, heightPx, yTopPx);
    if (uView !== undefined) gl.uniformMatrix3fv(uView, false, view);

    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, baseCount);
    gl.bindVertexArray(null);
  };

  return {
    draw,
    dispose() {
      gl.deleteBuffer(quadBuf);
      gl.deleteBuffer(instBuf);
      gl.deleteVertexArray(vao);
      program.dispose();
      if (scratch) float32Pool.release(scratch);
    },
  };
}
