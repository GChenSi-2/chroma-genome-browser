/**
 * BigWig signal renderer.
 *
 * Consumes `SignalTile` (ARCHITECTURE §2.5) — same Float32Array-of-bin-values
 * shape as `CoverageTile` but a different semantic (continuous signal vs read
 * depth). Implementation deliberately mirrors `bam-coverage.ts`: one instanced
 * unit quad per bin, bottom-anchored, height = value / maxValue.
 *
 * Differences vs coverage:
 *   - `u_logScale` uniform (0 = linear, 1 = log) per TWO_DAY_SPRINT T1.B.5.
 *     Log path is `log(1 + v) / log(1 + max)` so the value 0 still maps to
 *     height 0 and growth is monotonic.
 *   - Default color is `--strand-forward` (#6699cc, 0.40 / 0.60 / 0.80). The
 *     scheduler passes the final color in any case (TrackConfig may override).
 *
 * Hot-path discipline (BENCHMARKS §6):
 *   - No `new` inside `draw()` beyond pool growth.
 *   - All uniform / attribute locations cached at construction.
 *   - For-loops only.
 *
 * Decision (KISS): code is intentionally duplicated with `bam-coverage.ts`
 * rather than lifted into a shared `histogram-renderer.ts`. The two callers
 * have already diverged on the uniform list (`u_logScale`) and will diverge
 * further in M2 when signal-specific features arrive (negative values, dual
 * baseline, summary statistics). One screen of duplication beats a premature
 * abstraction that would need to be unwound.
 */

import { createProgram, type Program } from '../webgl/program';
import { float32Pool } from '../webgl/buffer-pool';
import { buildViewMatrix } from '../coord';
import type { SignalTile, Viewport } from '~state/types';

const VERT_SRC = /* glsl */ `#version 300 es
precision highp float;
in vec2 a_quad;
in vec2 a_pos;      // (relStartBp, binWidthBp)
in float a_value;
uniform mat3 u_view;
uniform float u_maxValue;
uniform int u_logScale;
void main() {
  float v = a_value;
  float m = max(u_maxValue, 1e-6);
  float h;
  if (u_logScale == 1) {
    // log(1+v) / log(1+max) — keeps v=0 → h=0 and is monotonic.
    h = clamp(log(1.0 + max(v, 0.0)) / log(1.0 + m), 0.0, 1.0);
  } else {
    h = clamp(v / m, 0.0, 1.0);
  }
  // Bottom-anchored: yLocal goes 1 (bottom) up to (1 - h) (top of bar).
  float yLocal = 1.0 - a_quad.y * h;
  vec2 localPos = vec2(a_pos.x + a_quad.x * a_pos.y, yLocal);
  vec3 ndc = u_view * vec3(localPos, 1.0);
  gl_Position = vec4(ndc.xy, 0.0, 1.0);
}
`;

const FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 u_color;
out vec4 outColor;
void main() {
  outColor = vec4(u_color, 1.0);
}
`;

export interface BigWigRenderer {
  /**
   * Draw a single SignalTile bottom-anchored within the band `[yTopPx,
   * yTopPx + heightPx]`. `maxValue` normalizes the bar heights — caller is
   * responsible for computing a stable max across tiles for the same band so
   * adjacent tiles don't flicker as they paint.
   */
  draw: (
    tile: SignalTile,
    viewport: Viewport,
    yTopPx: number,
    heightPx: number,
    maxValue: number,
    color: readonly [number, number, number],
  ) => void;
  /** Toggle log-scale display. Default linear. */
  setScale: (scale: 'linear' | 'log') => void;
  dispose: () => void;
}

const FLOATS_PER_INSTANCE = 3; // posX, binWidthBp, value
const STRIDE = FLOATS_PER_INSTANCE * 4;

export function createBigWigRenderer(gl: WebGL2RenderingContext): BigWigRenderer {
  const program: Program = createProgram(gl, {
    vertSrc: VERT_SRC,
    fragSrc: FRAG_SRC,
    attribs: ['a_quad', 'a_pos', 'a_value'],
    uniforms: ['u_view', 'u_maxValue', 'u_color', 'u_logScale'],
    label: 'bigwig',
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

  const aValue = program.attribs.a_value ?? -1;
  if (aValue >= 0) {
    gl.enableVertexAttribArray(aValue);
    gl.vertexAttribPointer(aValue, 1, gl.FLOAT, false, STRIDE, 8);
    gl.vertexAttribDivisor(aValue, 1);
  }

  gl.bindVertexArray(null);

  // Cache uniform locations once.
  const uView = program.uniforms.u_view;
  const uMaxValue = program.uniforms.u_maxValue;
  const uColor = program.uniforms.u_color;
  const uLogScale = program.uniforms.u_logScale;

  let scratch: Float32Array | null = null;
  let logScale: 0 | 1 = 0;

  const draw = (
    tile: SignalTile,
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

    // tile.start is bigint; bring it into Float32-safe range by subtracting
    // viewport.start (delta < 1e7 in practice, ARCHITECTURE §3.1).
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
    if (uMaxValue !== undefined) gl.uniform1f(uMaxValue, Math.max(maxValue, 1e-6));
    if (uColor !== undefined) gl.uniform3f(uColor, color[0], color[1], color[2]);
    if (uLogScale !== undefined) gl.uniform1i(uLogScale, logScale);

    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, binCount);
    gl.bindVertexArray(null);
  };

  return {
    draw,
    setScale(scale: 'linear' | 'log'): void {
      logScale = scale === 'log' ? 1 : 0;
    },
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
export function maxAcrossSignalTiles(tiles: Iterable<SignalTile>): number {
  let max = 0;
  for (const t of tiles) {
    for (let i = 0; i < t.values.length; i++) {
      const v = t.values[i]!;
      if (v > max) max = v;
    }
  }
  return max;
}
