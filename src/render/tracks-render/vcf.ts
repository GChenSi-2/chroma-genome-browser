/**
 * VCF variant renderer.
 *
 * One instanced thin tick per variant, full band height. Colour by
 * variant type — DESIGN_SYSTEM Sec 2.2 var-* palette:
 *   SNV (yellow-orange #e69f00)
 *   INS (sky          #56b4e9)
 *   DEL (rose         #cc79a7)
 *   MNV (bluish-green #009e73)
 *   SV  (vermilion    #d55e00)
 *
 * Tick width = max(1.5 px, 1 bp on screen). For dense regions (1000G
 * phase3 ~ 1 SNV per few hundred bp) ticks visually merge into a band
 * — that's the desired Tufte-density read: more colour at zoom-out =
 * more variants there.
 *
 * Hot-path discipline (BENCHMARKS Sec 6):
 *   - No `new` inside `draw()` beyond pool growth.
 *   - All uniform / attribute locations cached at construction.
 *   - For-loop only.
 */

import { createProgram, type Program } from '../webgl/program';
import { float32Pool } from '../webgl/buffer-pool';
import { buildViewMatrix } from '../coord';
import type { VariantTile, Viewport } from '~state/types';

// Indexes here MUST match the type codes in parser.worker.ts
// (VARIANT_SNV=0, _INS=1, _DEL=2, _MNV=3, _SV=4).
const TYPE_COLORS: readonly (readonly [number, number, number])[] = [
  [0.902, 0.624, 0.000],  // SNV  #e69f00
  [0.337, 0.706, 0.914],  // INS  #56b4e9
  [0.800, 0.475, 0.655],  // DEL  #cc79a7
  [0.000, 0.620, 0.451],  // MNV  #009e73
  [0.835, 0.369, 0.000],  // SV   #d55e00
];

const VERT_SRC = /* glsl */ `#version 300 es
precision highp float;

in vec2 a_quad;
in vec2 a_pos;       // (relStartBp, widthBp)
in float a_typeCode; // 0..4

uniform mat3 u_view;
uniform vec3 u_typeColors[5];

out vec3 v_color;

void main() {
  vec2 localPos = vec2(a_pos.x + a_quad.x * a_pos.y, a_quad.y);
  vec3 ndc = u_view * vec3(localPos, 1.0);
  gl_Position = vec4(ndc.xy, 0.0, 1.0);
  int idx = int(clamp(a_typeCode, 0.0, 4.0));
  v_color = u_typeColors[idx];
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

export interface VcfRenderer {
  draw: (
    tile: VariantTile,
    viewport: Viewport,
    yTopPx: number,
    heightPx: number,
  ) => void;
  dispose: () => void;
}

const FLOATS_PER_INSTANCE = 3; // relStart, widthBp, typeCode
const STRIDE = FLOATS_PER_INSTANCE * 4;
/** Minimum on-screen tick width so single-bp variants stay visible at
 *  zoomed-out spans. */
const MIN_TICK_PX = 1.5;

export function createVcfRenderer(gl: WebGL2RenderingContext): VcfRenderer {
  const program: Program = createProgram(gl, {
    vertSrc: VERT_SRC,
    fragSrc: FRAG_SRC,
    attribs: ['a_quad', 'a_pos', 'a_typeCode'],
    uniforms: ['u_view', 'u_typeColors'],
    label: 'vcf',
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

  const aType = program.attribs.a_typeCode ?? -1;
  if (aType >= 0) {
    gl.enableVertexAttribArray(aType);
    gl.vertexAttribPointer(aType, 1, gl.FLOAT, false, STRIDE, 8);
    gl.vertexAttribDivisor(aType, 1);
  }

  gl.bindVertexArray(null);

  const uView = program.uniforms.u_view;
  const uColors = program.uniforms.u_typeColors;

  // Flat-pack the per-type colours once at construction.
  const colorArr = new Float32Array(15);
  for (let i = 0; i < 5; i++) {
    const c = TYPE_COLORS[i]!;
    colorArr[i * 3 + 0] = c[0];
    colorArr[i * 3 + 1] = c[1];
    colorArr[i * 3 + 2] = c[2];
  }

  let scratch: Float32Array | null = null;

  const draw = (
    tile: VariantTile,
    viewport: Viewport,
    yTopPx: number,
    heightPx: number,
  ): void => {
    const count = tile.count;
    if (count === 0) return;

    const neededFloats = count * FLOATS_PER_INSTANCE;
    if (!scratch || scratch.length < neededFloats) {
      if (scratch) float32Pool.release(scratch);
      scratch = float32Pool.acquire(neededFloats);
    }
    const buf = scratch;

    // Convert positions to viewport-relative space. positionsHi handles
    // sequence > 2^31 bp; we coerce to a single Number after subtracting
    // viewport.start (always small magnitude per ARCHITECTURE Sec 3.1).
    const viewportStart = viewport.start;
    const span = Number(viewport.end - viewportStart);
    if (!Number.isFinite(span) || span <= 0) return;
    const pxPerBp = viewport.pxWidth / span;
    // Width = max(1 bp, MIN_TICK_PX worth of bp) so single-bp ticks
    // stay visible at any zoom-out.
    const minWidthBp = Math.max(1, MIN_TICK_PX / Math.max(pxPerBp, 1e-9));

    for (let i = 0; i < count; i++) {
      const absPos = (tile.positionsHi[i]! * 4_294_967_296) + tile.positions[i]!;
      const rel = absPos - Number(viewportStart);
      const o = i * FLOATS_PER_INSTANCE;
      buf[o] = rel;
      buf[o + 1] = minWidthBp;
      buf[o + 2] = tile.types[i]!;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    const byteLen = count * STRIDE;
    // Orphan every draw — see bam-pileup.ts for rationale.
    const cap = byteLen > instCapacityBytes
      ? 1 << Math.ceil(Math.log2(byteLen))
      : instCapacityBytes;
    gl.bufferData(gl.ARRAY_BUFFER, cap, gl.DYNAMIC_DRAW);
    instCapacityBytes = cap;
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf, 0, neededFloats);

    program.use();
    const view = buildViewMatrix(viewport, heightPx, yTopPx);
    if (uView !== undefined) gl.uniformMatrix3fv(uView, false, view);
    if (uColors !== undefined) gl.uniform3fv(uColors, colorArr);

    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
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
