/**
 * Reference (FASTA) renderer.
 *
 * Path A (always-on): one colored 1-bp-wide instanced quad per base. The base
 * code (A/C/G/T/N) maps to a constant color array inside the vertex shader.
 *
 * Path B (letters): at `basePixelWidth >= 12 px` we composite A/C/G/T/N glyphs
 * sampled from a Canvas2D-baked atlas over the colored band. The atlas is
 * built once at renderer construction (5 cells of 64 x 64, R8 single-channel)
 * and bound to texture unit 0 in every draw.
 *
 * Encoding contract (`ReferenceTile.packed`):
 *   - 4-bit per base, 2 bases per byte. Codes: A=0 C=1 G=2 T=3 N=4.
 *   - Byte `i >> 1` carries base `i` in the low nibble; base `i+1` in the
 *     high nibble. Trailing nibble of an odd-length packing is padding.
 *   - This is the inverse of `packReferenceSequence` in parser.worker.ts.
 *
 * Hot-path discipline (BENCHMARKS Sec 6):
 *   - draw() does not allocate beyond pool growth.
 *   - 4-bit decode runs once per draw into a Float32 scratch [relStartBp,
 *     baseCode] pair per base.
 *   - One instanced draw call per tile.
 */

import { createProgram, type Program } from '../webgl/program';
import { float32Pool } from '../webgl/buffer-pool';
import { buildViewMatrix } from '../coord';
import type { ReferenceTile, Viewport } from '~state/types';

// Base colors from DESIGN_SYSTEM Sec 2.2.
//   A: #4caf50, C: #2196f3, G: #ff9800, T: #f44336, N: #9e9e9e
const VERT_SRC = /* glsl */ `#version 300 es
precision highp float;

in vec2 a_quad;
in vec2 a_pos;   // (relStartBp, baseCode)  baseCode in {0,1,2,3,4}

uniform mat3 u_view;

out vec3 v_color;
out vec2 v_localUV;
flat out int v_baseCode;

const vec3 BASE_COLORS[5] = vec3[5](
  vec3(0.298, 0.686, 0.314),  // A
  vec3(0.129, 0.588, 0.953),  // C
  vec3(1.000, 0.596, 0.000),  // G
  vec3(0.957, 0.263, 0.212),  // T
  vec3(0.620, 0.620, 0.620)   // N
);

void main() {
  vec2 localPos = vec2(a_pos.x + a_quad.x, a_quad.y);
  vec3 ndc = u_view * vec3(localPos, 1.0);
  gl_Position = vec4(ndc.xy, 0.0, 1.0);

  int code = int(clamp(a_pos.y, 0.0, 4.0));
  v_color = BASE_COLORS[code];
  v_baseCode = code;
  // Flip y so the rasterized canvas (origin top-left) lines up with the
  // quad's y axis (0 at top of band, 1 at bottom).
  v_localUV = vec2(a_quad.x, a_quad.y);
}
`;

const FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;

in vec3 v_color;
in vec2 v_localUV;
flat in int v_baseCode;

uniform sampler2D u_letters;
uniform float u_showLetters;

out vec4 outColor;

void main() {
  vec3 color = v_color;
  if (u_showLetters > 0.5) {
    // Atlas is 5 cells across, 1 row. Cell of code N spans u in [N/5, (N+1)/5].
    float u = (float(v_baseCode) + v_localUV.x) / 5.0;
    float v = v_localUV.y;
    float a = texture(u_letters, vec2(u, v)).r;
    // Composite opaque black glyph over the base color.
    color = mix(color, vec3(0.0), a);
  }
  outColor = vec4(color, 1.0);
}
`;

export interface ReferenceRenderer {
  /** Draw a reference tile into the band `[yTopPx, yTopPx + heightPx]`. */
  draw: (tile: ReferenceTile, viewport: Viewport, yTopPx: number, heightPx: number) => void;
  dispose: () => void;
}

const FLOATS_PER_INSTANCE = 2; // posX, baseCode
const STRIDE = FLOATS_PER_INSTANCE * 4;

// Atlas geometry: 5 cells (A,C,G,T,N) of 64 x 64 px, single row.
const ATLAS_CELL = 64;
const ATLAS_W = ATLAS_CELL * 5;
const ATLAS_H = ATLAS_CELL;
const LETTER_THRESHOLD_PX = 12;
const LETTERS = ['A', 'C', 'G', 'T', 'N'] as const;

/**
 * Decode 4-bit-per-base packed bases into the per-instance scratch buffer.
 *
 * Layout (matches packReferenceSequence in parser.worker.ts):
 *   - byte `i >> 1` low nibble  = base at position i (even i)
 *   - byte `i >> 1` high nibble = base at position i+1 (odd i)
 *   - codes: A=0, C=1, G=2, T=3, N=4
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
    const byteIdx = i >> 1;
    const byte = packed[byteIdx] ?? 0;
    const nibble = (i & 1) === 0 ? byte & 0x0f : (byte >> 4) & 0x0f;
    // Clamp to [0..4] for shader safety; future IUPAC codes alias to N.
    const code = nibble > 4 ? 4 : nibble;
    const o = i << 1;
    out[o] = relStart + i;
    out[o + 1] = code;
  }
}

/**
 * Bake A/C/G/T/N glyphs into a single R8 texture. Returns null if Canvas2D
 * isn't available (e.g. worker / happy-dom test context without canvas2d).
 */
function buildLetterAtlas(gl: WebGL2RenderingContext): WebGLTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = ATLAS_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, ATLAS_W, ATLAS_H);
  ctx.font = '48px JetBrains Mono, monospace';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < LETTERS.length; i++) {
    const cx = i * ATLAS_CELL + ATLAS_CELL / 2;
    const cy = ATLAS_CELL / 2;
    ctx.fillText(LETTERS[i]!, cx, cy);
  }

  let pixels: ImageData;
  try {
    pixels = ctx.getImageData(0, 0, ATLAS_W, ATLAS_H);
  } catch {
    return null;
  }
  // Text rasterizes as grayscale on transparent BG — the alpha channel
  // captures glyph coverage cleanly; rgb may be premultiplied to 0.
  const rgba = pixels.data;
  const r8 = new Uint8Array(ATLAS_W * ATLAS_H);
  for (let i = 0; i < r8.length; i++) {
    r8[i] = rgba[i * 4 + 3] ?? 0;
  }

  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R8,
    ATLAS_W,
    ATLAS_H,
    0,
    gl.RED,
    gl.UNSIGNED_BYTE,
    r8,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

export function createReferenceRenderer(gl: WebGL2RenderingContext): ReferenceRenderer {
  const program: Program = createProgram(gl, {
    vertSrc: VERT_SRC,
    fragSrc: FRAG_SRC,
    attribs: ['a_quad', 'a_pos'],
    uniforms: ['u_view', 'u_letters', 'u_showLetters'],
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
  const uLetters = program.uniforms.u_letters;
  const uShowLetters = program.uniforms.u_showLetters;

  // One-shot atlas bake. Falls back to Path A only when document is
  // unavailable (workers, test environments without DOM canvas).
  const letterAtlas = buildLetterAtlas(gl);

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

    const span = Number(viewport.end - viewport.start);
    const basePixelWidth = span > 0 ? viewport.pxWidth / span : 0;
    const showLetters = letterAtlas !== null && basePixelWidth >= LETTER_THRESHOLD_PX ? 1.0 : 0.0;

    if (letterAtlas !== null) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, letterAtlas);
    }
    if (uLetters !== undefined) gl.uniform1i(uLetters, 0);
    if (uShowLetters !== undefined) gl.uniform1f(uShowLetters, showLetters);

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
      if (letterAtlas !== null) gl.deleteTexture(letterAtlas);
      program.dispose();
      if (scratch) float32Pool.release(scratch);
    },
  };
}
