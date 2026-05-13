/**
 * BAM pileup renderer — the core of Chroma's value prop.
 *
 * Pipeline:
 *   1. Pileup row assignment (CPU, O(n log n) using min-heap of row-end-positions)
 *   2. Pack per-instance data into Float32Array (zero-allocation via pool)
 *   3. Single drawArraysInstanced call
 *
 * agent-render T1.B.3 extends this with:
 *   - Mismatch coloring (per-fragment texture sample)
 *   - Soft-clip indicator at read ends
 *   - Insertion/deletion CIGAR ops
 */

import { createProgram, type Program } from '../webgl/program';
import { float32Pool, uint8Pool, uint16Pool } from '../webgl/buffer-pool';
import {
  buildViewMatrix,
  toRelative,
  basePixelWidth,
  type Viewport,
  type GenomicCoord,
} from '../coord';

// Inline shader sources. In production, Vite glob-imports the .glsl files
// with `?raw`. Spike inlines for portability.
const VERT_SRC = /* glsl */ `#version 300 es
precision highp float;
in vec2 a_quad;
in vec2 a_pos;
in float a_row;
in float a_mapq;
in uint  a_flags;
uniform mat3 u_view;
uniform float u_minWidthPx;
uniform float u_pxPerBp;
out vec4 v_color;
out vec2 v_uv;
flat out uint v_flags;
flat out float v_mapq;
void main() {
  float lengthBp = a_pos.y;
  float minLengthBp = u_minWidthPx / max(u_pxPerBp, 1e-6);
  float visualLength = max(lengthBp, minLengthBp);
  vec2 localPos = vec2(a_pos.x + a_quad.x * visualLength, a_row + a_quad.y);
  vec3 ndc = u_view * vec3(localPos, 1.0);
  gl_Position = vec4(ndc.xy, 0.0, 1.0);
  bool reverse = (a_flags & 16u) != 0u;
  vec3 baseColor = reverse ? vec3(0.80, 0.55, 0.58) : vec3(0.55, 0.68, 0.85);
  float mapqNorm = clamp(a_mapq / 30.0, 0.0, 1.0);
  vec3 color = mix(vec3(0.60), baseColor, mapqNorm);
  float alpha = mapqNorm < 0.05 ? 0.35 : 1.0;
  v_color = vec4(color, alpha);
  v_uv = a_quad;
  v_flags = a_flags;
  v_mapq = a_mapq;
}
`;

const FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;
in vec4 v_color;
in vec2 v_uv;
flat in uint v_flags;
flat in float v_mapq;
uniform vec2 u_rectPx;
uniform float u_edgeSoftnessPx;
out vec4 outColor;
void main() {
  vec2 distFromEdgeUV = min(v_uv, 1.0 - v_uv);
  vec2 distPx = distFromEdgeUV * u_rectPx;
  float edge = min(distPx.x, distPx.y);
  float alpha = smoothstep(0.0, u_edgeSoftnessPx, edge);
  outColor = vec4(v_color.rgb, v_color.a * alpha);
}
`;

/**
 * Read tile structure — Structure of Arrays for cache-friendly iteration.
 * In production, agent-data builds this in the BAM worker.
 */
export interface ReadTile {
  count: number;
  /** Genomic start position, low 32 bits. */
  starts: Int32Array;
  /** Genomic start position, high 32 bits (usually 0). */
  startsHi: Int32Array;
  /** Read length in bp. */
  lengths: Uint16Array;
  /** SAM flags bitfield. */
  flags: Uint16Array;
  /** Mapping quality 0..60. */
  mapq: Uint8Array;
}

/**
 * Pileup row assignment using greedy first-fit.
 *
 * Returns a Uint16Array of length `tile.count`, mapping read index -> row.
 * Max row used returned via output param so caller knows total height.
 *
 * Algorithm:
 *   Maintain a min-heap of (rowEndPos, rowIndex) pairs.
 *   For each read (sorted by start), find rows whose end <= read.start.
 *   If any: reuse the smallest-index such row.
 *   Else: assign new row.
 *
 * Spike uses linear scan instead of heap — for 100K reads, both are <5ms.
 * For 1M+ reads, switch to indexed heap (TODO before Phase 2).
 */
export function assignPileupRows(
  tile: ReadTile,
  maxRows: number = 200,
): { rows: Uint16Array; maxRowUsed: number } {
  const rows = uint16Pool.acquire(tile.count);
  rows.fill(0, 0, tile.count);

  // rowEnds[i] = genomic end pos of last read on row i (exclusive)
  // Using Int32Array for low 32 bits; spike assumes startsHi all zero.
  const rowEnds = new Int32Array(maxRows);
  let maxRowUsed = 0;

  for (let i = 0; i < tile.count; i++) {
    const start = tile.starts[i]!;
    const end = start + tile.lengths[i]!;

    // Find first row whose end <= start (no overlap, plus 1bp gap)
    let assignedRow = -1;
    for (let r = 0; r <= maxRowUsed; r++) {
      if (rowEnds[r]! <= start) {
        assignedRow = r;
        break;
      }
    }

    if (assignedRow === -1) {
      // Need new row
      if (maxRowUsed + 1 < maxRows) {
        maxRowUsed++;
        assignedRow = maxRowUsed;
      } else {
        // Pileup overflow — collapse to last row (will overlap)
        assignedRow = maxRows - 1;
      }
    }

    rows[i] = assignedRow;
    rowEnds[assignedRow] = end;
  }

  return { rows, maxRowUsed };
}

/**
 * Pack per-instance attribute data.
 *
 * Layout per instance (4 floats + 1 uint = 20 bytes, aligned to 24 with padding):
 *   [0] relStartBp (float32)
 *   [1] lengthBp   (float32)
 *   [2] row        (float32)
 *   [3] mapq       (float32)
 *   [4] flags      (uint32)
 *
 * We use a single interleaved buffer + setVertexAttribPointer with stride.
 */
const FLOATS_PER_INSTANCE = 5; // pos.x, pos.y, row, mapq, flags(reinterpreted)
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;

function packInstances(
  tile: ReadTile,
  rows: Uint16Array,
  origin: GenomicCoord,
  out: Float32Array,
  outUint: Uint32Array, // same buffer, different view
): void {
  // origin reduction in JS once (BigInt arithmetic is slow per-iter)
  const originLo = Number(origin & 0xffffffffn);
  // For spike we assume origin and reads in same 32-bit window;
  // production must do hi/lo subtraction. See coord/index.ts toRelative.

  for (let i = 0; i < tile.count; i++) {
    const o = i * FLOATS_PER_INSTANCE;
    const rel = tile.starts[i]! - originLo;
    out[o] = rel;
    out[o + 1] = tile.lengths[i]!;
    out[o + 2] = rows[i]!;
    out[o + 3] = tile.mapq[i]!;
    // flags written as uint via shared buffer view
    outUint[o + 4] = tile.flags[i]!;
  }
}

export interface PileupRenderer {
  draw: (tile: ReadTile, viewport: Viewport, yTopPx: number) => void;
  dispose: () => void;
  /** Diagnostic: last frame's read count + draw time. */
  stats: () => { readCount: number; drawTimeMs: number; rowsUsed: number };
}

export function createPileupRenderer(
  gl: WebGL2RenderingContext,
  rowHeightPx: number = 8,
): PileupRenderer {
  // 1. Compile program (once)
  const program = createProgram(gl, {
    vertSrc: VERT_SRC,
    fragSrc: FRAG_SRC,
    attribs: ['a_quad', 'a_pos', 'a_row', 'a_mapq', 'a_flags'],
    uniforms: ['u_view', 'u_minWidthPx', 'u_pxPerBp', 'u_rectPx', 'u_edgeSoftnessPx'],
    label: 'pileup',
  });

  // 2. Create static unit quad (vec2, 4 verts for TRIANGLE_STRIP)
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    gl.STATIC_DRAW,
  );

  // 3. Instance buffer (resized dynamically)
  const instBuf = gl.createBuffer();
  let instCapacityBytes = 0;

  // 4. VAO
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  // Quad attribute (per-vertex)
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  const aQuad = program.attribs.a_quad!;
  gl.enableVertexAttribArray(aQuad);
  gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0);

  // Instance attributes
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  const stride = BYTES_PER_INSTANCE;

  const aPos = program.attribs.a_pos!;
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, stride, 0);
  gl.vertexAttribDivisor(aPos, 1);

  const aRow = program.attribs.a_row!;
  gl.enableVertexAttribArray(aRow);
  gl.vertexAttribPointer(aRow, 1, gl.FLOAT, false, stride, 8);
  gl.vertexAttribDivisor(aRow, 1);

  const aMapq = program.attribs.a_mapq!;
  gl.enableVertexAttribArray(aMapq);
  gl.vertexAttribPointer(aMapq, 1, gl.FLOAT, false, stride, 12);
  gl.vertexAttribDivisor(aMapq, 1);

  const aFlags = program.attribs.a_flags!;
  gl.enableVertexAttribArray(aFlags);
  gl.vertexAttribIPointer(aFlags, 1, gl.UNSIGNED_INT, stride, 16);
  gl.vertexAttribDivisor(aFlags, 1);

  gl.bindVertexArray(null);

  // 5. Persistent scratch buffers (avoid per-frame alloc)
  let scratchFloat: Float32Array | null = null;
  let scratchUint: Uint32Array | null = null;

  let lastStats = { readCount: 0, drawTimeMs: 0, rowsUsed: 0 };

  const draw = (tile: ReadTile, viewport: Viewport, yTopPx: number): void => {
    if (tile.count === 0) return;
    const t0 = performance.now();

    // a. Row assignment
    const { rows, maxRowUsed } = assignPileupRows(tile);

    // b. Grow scratch if needed
    const neededFloats = tile.count * FLOATS_PER_INSTANCE;
    if (!scratchFloat || scratchFloat.length < neededFloats) {
      // Acquire from pool — pool rounds to power-of-2
      if (scratchFloat) float32Pool.release(scratchFloat);
      scratchFloat = float32Pool.acquire(neededFloats);
      scratchUint = new Uint32Array(scratchFloat.buffer);
    }

    // c. Pack instance data
    packInstances(tile, rows, viewport.start, scratchFloat, scratchUint!);

    // d. Upload to GPU
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    const byteLen = tile.count * BYTES_PER_INSTANCE;
    if (byteLen > instCapacityBytes) {
      // Reallocate — round up to next power of 2 to avoid frequent resizes
      const cap = 1 << Math.ceil(Math.log2(byteLen));
      gl.bufferData(gl.ARRAY_BUFFER, cap, gl.DYNAMIC_DRAW);
      instCapacityBytes = cap;
    }
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      scratchFloat,
      0,
      tile.count * FLOATS_PER_INSTANCE,
    );

    // e. Set uniforms + draw
    program.use();
    const view = buildViewMatrix(viewport, rowHeightPx, yTopPx);
    gl.uniformMatrix3fv(program.uniforms.u_view!, false, view);

    const pxPerBp = basePixelWidth(viewport);
    gl.uniform1f(program.uniforms.u_minWidthPx!, 1.0);
    gl.uniform1f(program.uniforms.u_pxPerBp!, pxPerBp);

    // Average read rect in px for AA — use median length
    const avgLengthBp = tile.lengths[tile.count >> 1] ?? 150;
    const avgWidthPx = Math.max(1, avgLengthBp * pxPerBp);
    gl.uniform2f(program.uniforms.u_rectPx!, avgWidthPx, rowHeightPx);
    gl.uniform1f(program.uniforms.u_edgeSoftnessPx!, 0.75);

    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, tile.count);
    gl.bindVertexArray(null);

    // f. Release rows (we don't need it next frame; renderer re-runs each frame)
    uint16Pool.release(rows);

    lastStats = {
      readCount: tile.count,
      drawTimeMs: performance.now() - t0,
      rowsUsed: maxRowUsed + 1,
    };
  };

  return {
    draw,
    dispose: () => {
      gl.deleteBuffer(quadBuf);
      gl.deleteBuffer(instBuf);
      gl.deleteVertexArray(vao);
      program.dispose();
      if (scratchFloat) float32Pool.release(scratchFloat);
    },
    stats: () => lastStats,
  };
}
