/**
 * Coverage / histogram renderer.
 *
 * Used by:
 *   - BAM coverage track (counts of reads at each bin)
 *   - BigWig track (signal value at each bin)
 *
 * Strategy:
 *   - One instance per bin
 *   - Quad shape, bottom-anchored
 *   - Vertex shader scales height by per-instance `value`
 *
 * For 1M bins (whole chr1 at 1bp resolution) this is fast,
 * but normally we render <10k bins (decimated to viewport pixels).
 */

import { createProgram } from '../webgl/program';
import { float32Pool } from '../webgl/buffer-pool';
import {
  buildViewMatrix,
  type Viewport,
} from '../coord';

const VERT_SRC = /* glsl */ `#version 300 es
precision highp float;
in vec2 a_quad;
in vec2 a_pos;        // (relStartBp, binWidthBp)
in float a_value;     // raw value (0..maxValue)
uniform mat3 u_view;
uniform float u_maxValue;
uniform float u_trackHeight; // in "row units" — typically 1
out float v_height01;
void main() {
  // Normalize to 0..1, then scale to track height
  float h = clamp(a_value / max(u_maxValue, 1e-6), 0.0, 1.0);
  v_height01 = h * (1.0 - a_quad.y); // for gradient if needed

  // Bottom of bar = row 1, top = row (1 - h * trackHeight)
  float yLocal = 1.0 - a_quad.y * h * u_trackHeight;
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

export interface CoverageTile {
  binCount: number;
  /** Genomic start of bin 0. */
  startBp: number;
  /** Width of each bin in bp. */
  binWidthBp: number;
  /** Value per bin. */
  values: Float32Array;
  /** Max value (for normalization). */
  maxValue: number;
}

export interface CoverageRenderer {
  draw: (tile: CoverageTile, viewport: Viewport, yTopPx: number, heightPx: number, color: [number, number, number]) => void;
  dispose: () => void;
}

export function createCoverageRenderer(
  gl: WebGL2RenderingContext,
): CoverageRenderer {
  const program = createProgram(gl, {
    vertSrc: VERT_SRC,
    fragSrc: FRAG_SRC,
    attribs: ['a_quad', 'a_pos', 'a_value'],
    uniforms: ['u_view', 'u_maxValue', 'u_trackHeight', 'u_color'],
    label: 'coverage',
  });

  // Quad
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    gl.STATIC_DRAW,
  );

  // Instance buffer
  const instBuf = gl.createBuffer();
  let instCapacityBytes = 0;
  const FLOATS_PER = 3; // posX, binWidth, value
  const STRIDE = FLOATS_PER * 4;

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
    color: [number, number, number],
  ): void => {
    if (tile.binCount === 0) return;

    const neededFloats = tile.binCount * FLOATS_PER;
    if (!scratch || scratch.length < neededFloats) {
      if (scratch) float32Pool.release(scratch);
      scratch = float32Pool.acquire(neededFloats);
    }

    // Pack
    const origin = Number(viewport.start & 0xffffffffn);
    for (let i = 0; i < tile.binCount; i++) {
      const o = i * FLOATS_PER;
      scratch[o] = tile.startBp + i * tile.binWidthBp - origin;
      scratch[o + 1] = tile.binWidthBp;
      scratch[o + 2] = tile.values[i]!;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    const byteLen = tile.binCount * STRIDE;
    if (byteLen > instCapacityBytes) {
      const cap = 1 << Math.ceil(Math.log2(byteLen));
      gl.bufferData(gl.ARRAY_BUFFER, cap, gl.DYNAMIC_DRAW);
      instCapacityBytes = cap;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, scratch, 0, neededFloats);

    program.use();
    // Build matrix with a "fake row" — coverage occupies one rowHeight = heightPx
    const view = buildViewMatrix(viewport, heightPx, yTopPx);
    gl.uniformMatrix3fv(program.uniforms.u_view!, false, view);
    gl.uniform1f(program.uniforms.u_maxValue!, tile.maxValue);
    gl.uniform1f(program.uniforms.u_trackHeight!, 1.0);
    gl.uniform3f(program.uniforms.u_color!, color[0], color[1], color[2]);

    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, tile.binCount);
    gl.bindVertexArray(null);
  };

  return {
    draw,
    dispose: () => {
      gl.deleteBuffer(quadBuf);
      gl.deleteBuffer(instBuf);
      gl.deleteVertexArray(vao);
      program.dispose();
      if (scratch) float32Pool.release(scratch);
    },
  };
}

/**
 * Decimate a per-bp coverage array to viewport pixel resolution.
 * Returns max-pooled values — preserves peaks (important for signal viz).
 */
export function decimateToViewport(
  rawValues: Float32Array,
  rawStartBp: number,
  rawBinWidthBp: number,
  viewport: Viewport,
): CoverageTile {
  const spanBp = Number(viewport.end - viewport.start);
  const targetBins = Math.min(viewport.pxWidth, rawValues.length);
  const binWidthBp = spanBp / targetBins;

  const out = float32Pool.acquire(targetBins);
  let maxVal = 0;

  for (let i = 0; i < targetBins; i++) {
    const binStartBp = Number(viewport.start) + i * binWidthBp;
    const binEndBp = binStartBp + binWidthBp;
    const srcStartIdx = Math.max(0, Math.floor((binStartBp - rawStartBp) / rawBinWidthBp));
    const srcEndIdx = Math.min(rawValues.length, Math.ceil((binEndBp - rawStartBp) / rawBinWidthBp));
    let m = 0;
    for (let j = srcStartIdx; j < srcEndIdx; j++) {
      const v = rawValues[j]!;
      if (v > m) m = v;
    }
    out[i] = m;
    if (m > maxVal) maxVal = m;
  }

  return {
    binCount: targetBins,
    startBp: Number(viewport.start),
    binWidthBp,
    values: out,
    maxValue: maxVal,
  };
}
