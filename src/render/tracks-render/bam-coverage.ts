/**
 * Coverage / histogram renderer.
 *
 * Consumes `CoverageTile` from ~state/types directly — one instance per bin,
 * bottom-anchored, height = value / maxValue. Same instanced-quad pattern
 * as the pileup renderer; one draw call covers the whole tile.
 *
 * Adapted from reference-spike/.../bam-coverage.ts; the spike used a local
 * tile shape, this version is aligned to the product type contract.
 *
 * Hot-path discipline (BENCHMARKS §6):
 *   - draw() does not allocate except resizing the scratch via buffer-pool
 *   - no Array.map / spread; for-loops only
 *   - uniforms / attribute locations resolved at construction
 */

import { createProgram, type Program } from '../webgl/program';
import { float32Pool } from '../webgl/buffer-pool';
import { buildViewMatrix } from '../coord';
import type { CoverageTile, Viewport } from '~state/types';

const VERT_SRC = /* glsl */ `#version 300 es
precision highp float;
in vec2 a_quad;
in vec2 a_pos;      // (relStartBp, binWidthBp)
in float a_value;
uniform mat3 u_view;
uniform float u_maxValue;
out float v_height01;
void main() {
  float h = clamp(a_value / max(u_maxValue, 1e-6), 0.0, 1.0);
  v_height01 = h * (1.0 - a_quad.y);
  // bottom = row 1, top = (1 - h) when a_quad.y = 1
  float yLocal = 1.0 - a_quad.y * h;
  vec2 localPos = vec2(a_pos.x + a_quad.x * a_pos.y, yLocal);
  vec3 ndc = u_view * vec3(localPos, 1.0);
  gl_Position = vec4(ndc.xy, 0.0, 1.0);
}
`;

const FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;
in float v_height01;
uniform vec3 u_color;
out vec4 outColor;
void main() {
  outColor = vec4(u_color, 1.0);
}
`;

export interface CoverageRenderer {
  /**
   * Draw a single coverage tile at the given vertical band.
   * `maxValue` is supplied by the scheduler so multi-tile tracks normalize
   * consistently; pass `tile.values`-derived max for single-tile draws.
   */
  draw: (
    tile: CoverageTile,
    viewport: Viewport,
    yTopPx: number,
    heightPx: number,
    maxValue: number,
    color: readonly [number, number, number],
  ) => void;
  dispose: () => void;
}

const FLOATS_PER_INSTANCE = 3; // posX, binWidthBp, value
const STRIDE = FLOATS_PER_INSTANCE * 4;

export function createCoverageRenderer(gl: WebGL2RenderingContext): CoverageRenderer {
  const program: Program = createProgram(gl, {
    vertSrc: VERT_SRC,
    fragSrc: FRAG_SRC,
    attribs: ['a_quad', 'a_pos', 'a_value'],
    uniforms: ['u_view', 'u_maxValue', 'u_color'],
    label: 'coverage',
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
  const aQuad = program.attribs.a_quad!;
  gl.enableVertexAttribArray(aQuad);
  gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  const aPos = program.attribs.a_pos!;
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, STRIDE, 0);
  gl.vertexAttribDivisor(aPos, 1);

  const aValue = program.attribs.a_value!;
  gl.enableVertexAttribArray(aValue);
  gl.vertexAttribPointer(aValue, 1, gl.FLOAT, false, STRIDE, 8);
  gl.vertexAttribDivisor(aValue, 1);

  gl.bindVertexArray(null);

  let scratch: Float32Array | null = null;

  const draw = (
    tile: CoverageTile,
    viewport: Viewport,
    yTopPx: number,
    heightPx: number,
    maxValue: number,
    color: readonly [number, number, number],
  ): void => {
    const binCount = tile.values.length;
    if (binCount === 0) return;

    const neededFloats = binCount * FLOATS_PER_INSTANCE;
    if (!scratch || scratch.length < neededFloats) {
      if (scratch) float32Pool.release(scratch);
      scratch = float32Pool.acquire(neededFloats);
    }
    const buf = scratch;

    // Pack: tile.start is bigint; viewport.start is bigint. Reduce both to
    // safe Float32 by subtracting viewport.start (delta < 1e7 in practice).
    const tileStart = Number(tile.start - viewport.start);
    const binWidth = tile.binSize;

    for (let i = 0; i < binCount; i++) {
      const o = i * FLOATS_PER_INSTANCE;
      buf[o] = tileStart + i * binWidth;
      buf[o + 1] = binWidth;
      buf[o + 2] = tile.values[i]!;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    const byteLen = binCount * STRIDE;
    if (byteLen > instCapacityBytes) {
      const cap = 1 << Math.ceil(Math.log2(byteLen));
      gl.bufferData(gl.ARRAY_BUFFER, cap, gl.DYNAMIC_DRAW);
      instCapacityBytes = cap;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf, 0, neededFloats);

    program.use();
    // Track occupies heightPx; pass heightPx as the "row height" so y=0..1
    // maps to that pixel band.
    const view = buildViewMatrix(viewport, heightPx, yTopPx);
    gl.uniformMatrix3fv(program.uniforms.u_view!, false, view);
    gl.uniform1f(program.uniforms.u_maxValue!, Math.max(maxValue, 1));
    gl.uniform3f(program.uniforms.u_color!, color[0], color[1], color[2]);

    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, binCount);
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

/** Helper for the render scheduler — find the largest value across an iterable of tiles. */
export function maxAcrossTiles(tiles: Iterable<CoverageTile>): number {
  let max = 0;
  for (const t of tiles) {
    for (let i = 0; i < t.values.length; i++) {
      const v = t.values[i]!;
      if (v > max) max = v;
    }
  }
  return max;
}
