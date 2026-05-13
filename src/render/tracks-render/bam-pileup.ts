/**
 * BAM pileup renderer — Chroma's flagship track type.
 *
 * Ported from `reference-spike/src/render/tracks-render/bam-pileup.ts` with:
 *   - `ReadTile` / `Viewport` consumed from `~state/types` (lead-frozen).
 *   - Shaders sourced from `./shaders/*.glsl?raw` (DESIGN_SYSTEM §2.2 strand
 *     colors baked into the vertex shader).
 *   - `u_showMismatches` uniform plumbed for the future per-base atlas
 *     (ARCHITECTURE §3.3). Atlas binding ships in T1.A.3.5.
 *
 * Pipeline (per draw):
 *   1. Pileup row assignment (CPU, greedy first-fit, O(n × maxRows))
 *   2. Pack per-instance data into a Float32 scratch buffer (zero-alloc via pool)
 *   3. Upload + single `drawArraysInstanced`
 *
 * Hot-path discipline (BENCHMARKS §6):
 *   - No allocations inside `draw()` beyond pool-managed scratch growth.
 *   - No `Array.map/filter/reduce`, no spread.
 *   - No `getAttribLocation` / `getUniformLocation` — looked up once at
 *     construction by `createProgram`.
 *
 * Coord assumption (v1): `tile.startsHi[i]` is treated as 0. Human autosomes
 * fit in Int32 so this holds for the demo data set. When BAM workers begin
 * emitting non-zero `startsHi` (post-T1.A.3.5), `packInstances` will need
 * to subtract the 64-bit origin via `toRelative` from `~render/coord`.
 */

import type { ReadTile, Viewport } from '~state/types';
import { createProgram } from '~render/webgl/program';
import { float32Pool, uint16Pool } from '~render/webgl/buffer-pool';
import { basePixelWidth, buildViewMatrix } from '~render/coord';

import VERT_SRC from './shaders/pileup.vert.glsl?raw';
import FRAG_SRC from './shaders/pileup.frag.glsl?raw';

// ─────────────────────────────────────────────────────────────────────────────
// Instance layout
// ─────────────────────────────────────────────────────────────────────────────

/** Per-instance: posX, posY, row, mapq, flags(reinterpreted as uint32). */
const FLOATS_PER_INSTANCE = 5;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;
/** Default pileup row cap per HANDOFF §3 — overflow collapses to last row. */
const DEFAULT_MAX_ROWS = 200;
/** Default row height in CSS px (DESIGN_SYSTEM §5 BAM pileup band). */
const DEFAULT_ROW_HEIGHT_PX = 8;

// ─────────────────────────────────────────────────────────────────────────────
// Pileup row assignment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Greedy first-fit row assignment. Returns a Uint16Array of length
 * `tile.count`, mapping read index -> row, plus the highest row index used.
 *
 * Complexity: O(n × maxRows). For 1M+ reads switch to an indexed min-heap of
 * row-end positions (TODO Phase 2 — see ARCHITECTURE §3.2 follow-up).
 *
 * Overflow: when all rows are occupied, the read is collapsed onto the last
 * row, which produces visible overlap. The viewport scheduler must shrink
 * `maxRows` only when track height demands it.
 *
 * The returned Uint16Array is acquired from `uint16Pool` and the caller MUST
 * release it back to the pool when the frame is done.
 */
export function assignPileupRows(
  tile: ReadTile,
  maxRows: number = DEFAULT_MAX_ROWS,
): { rows: Uint16Array; maxRowUsed: number } {
  const rows = uint16Pool.acquire(tile.count);
  rows.fill(0, 0, tile.count);

  // rowEnds[i] = genomic end pos of last read on row i (exclusive).
  // Int32Array suffices under the v1 `startsHi === 0` assumption.
  const rowEnds = new Int32Array(maxRows);
  let maxRowUsed = 0;

  for (let i = 0; i < tile.count; i++) {
    const start = tile.starts[i] ?? 0;
    const length = tile.lengths[i] ?? 0;
    const end = start + length;

    let assignedRow = -1;
    for (let r = 0; r <= maxRowUsed; r++) {
      if ((rowEnds[r] ?? 0) <= start) {
        assignedRow = r;
        break;
      }
    }

    if (assignedRow === -1) {
      if (maxRowUsed + 1 < maxRows) {
        maxRowUsed++;
        assignedRow = maxRowUsed;
      } else {
        // Pileup overflow — collapse to last row (overlap is intentional).
        assignedRow = maxRows - 1;
      }
    }

    rows[i] = assignedRow;
    rowEnds[assignedRow] = end;
  }

  return { rows, maxRowUsed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Instance packing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pack a `ReadTile` into the interleaved instance attribute buffer.
 *
 * `out` and `outUint` MUST alias the same underlying `ArrayBuffer` so the
 * flags slot is written through the Uint32 view (GLSL `in uint a_flags`).
 *
 * v1 assumes `startsHi` is zero; the relative start is `starts[i] - originLo`.
 */
function packInstances(
  tile: ReadTile,
  rows: Uint16Array,
  originLo: number,
  out: Float32Array,
  outUint: Uint32Array,
): void {
  for (let i = 0; i < tile.count; i++) {
    const o = i * FLOATS_PER_INSTANCE;
    const rel = (tile.starts[i] ?? 0) - originLo;
    out[o]     = rel;
    out[o + 1] = tile.lengths[i] ?? 0;
    out[o + 2] = rows[i] ?? 0;
    out[o + 3] = tile.mapq[i] ?? 0;
    outUint[o + 4] = tile.flags[i] ?? 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface PileupRenderer {
  /** Render `tile` at `yTopPx` within `viewport`. */
  draw: (tile: ReadTile, viewport: Viewport, yTopPx: number) => void;
  /** Free GPU resources. Safe to call once. */
  dispose: () => void;
  /** Diagnostic: last `draw()`'s read count, wall time, and rows used. */
  stats: () => { readCount: number; drawTimeMs: number; rowsUsed: number };
}

export interface PileupRendererOptions {
  /** Pixel height of each pileup row. Default 8 (DESIGN_SYSTEM §5). */
  rowHeightPx?: number;
  /** Maximum pileup rows. Default 200 (HANDOFF §3). */
  maxRows?: number;
}

export function createPileupRenderer(
  gl: WebGL2RenderingContext,
  opts: PileupRendererOptions = {},
): PileupRenderer {
  const rowHeightPx = opts.rowHeightPx ?? DEFAULT_ROW_HEIGHT_PX;
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;

  // 1. Compile + link once. All locations cached on the returned program.
  const program = createProgram(gl, {
    vertSrc: VERT_SRC,
    fragSrc: FRAG_SRC,
    attribs: ['a_quad', 'a_pos', 'a_row', 'a_mapq', 'a_flags'],
    uniforms: [
      'u_view',
      'u_minWidthPx',
      'u_pxPerBp',
      'u_rectPx',
      'u_edgeSoftnessPx',
      'u_showMismatches',
    ],
    label: 'pileup',
  });

  // 2. Static unit quad — 4 verts for TRIANGLE_STRIP.
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    gl.STATIC_DRAW,
  );

  // 3. Instance buffer (grown on demand inside `draw`).
  const instBuf = gl.createBuffer();
  let instCapacityBytes = 0;

  // 4. VAO captures the attribute layout once.
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  // Per-vertex quad attribute.
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  const aQuad = program.attribs.a_quad ?? -1;
  if (aQuad >= 0) {
    gl.enableVertexAttribArray(aQuad);
    gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0);
  }

  // Per-instance interleaved attributes (stride = BYTES_PER_INSTANCE).
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  const stride = BYTES_PER_INSTANCE;

  const aPos = program.attribs.a_pos ?? -1;
  if (aPos >= 0) {
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(aPos, 1);
  }
  const aRow = program.attribs.a_row ?? -1;
  if (aRow >= 0) {
    gl.enableVertexAttribArray(aRow);
    gl.vertexAttribPointer(aRow, 1, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(aRow, 1);
  }
  const aMapq = program.attribs.a_mapq ?? -1;
  if (aMapq >= 0) {
    gl.enableVertexAttribArray(aMapq);
    gl.vertexAttribPointer(aMapq, 1, gl.FLOAT, false, stride, 12);
    gl.vertexAttribDivisor(aMapq, 1);
  }
  const aFlags = program.attribs.a_flags ?? -1;
  if (aFlags >= 0) {
    gl.enableVertexAttribArray(aFlags);
    gl.vertexAttribIPointer(aFlags, 1, gl.UNSIGNED_INT, stride, 16);
    gl.vertexAttribDivisor(aFlags, 1);
  }

  gl.bindVertexArray(null);

  // 5. Persistent scratch buffers; the pool rounds to next pow2 so growth is
  //    rare. Pre-cache uniform locations into local consts so the hot path
  //    only touches numbers, never property lookups.
  const uView = program.uniforms.u_view;
  const uMinWidthPx = program.uniforms.u_minWidthPx;
  const uPxPerBp = program.uniforms.u_pxPerBp;
  const uRectPx = program.uniforms.u_rectPx;
  const uEdgeSoftnessPx = program.uniforms.u_edgeSoftnessPx;
  const uShowMismatches = program.uniforms.u_showMismatches;

  let scratchFloat: Float32Array | null = null;
  let scratchUint: Uint32Array | null = null;

  let lastStats = { readCount: 0, drawTimeMs: 0, rowsUsed: 0 };

  const draw = (tile: ReadTile, viewport: Viewport, yTopPx: number): void => {
    if (tile.count === 0) {
      lastStats = { readCount: 0, drawTimeMs: 0, rowsUsed: 0 };
      return;
    }
    const t0 = performance.now();

    // a. Row assignment.
    const { rows, maxRowUsed } = assignPileupRows(tile, maxRows);

    // b. Grow scratch if the current tile no longer fits.
    const neededFloats = tile.count * FLOATS_PER_INSTANCE;
    if (scratchFloat === null || scratchFloat.length < neededFloats) {
      if (scratchFloat !== null) float32Pool.release(scratchFloat);
      scratchFloat = float32Pool.acquire(neededFloats);
      scratchUint = new Uint32Array(scratchFloat.buffer);
    }

    // c. Pack instance data. originLo is `viewport.start mod 2^32`; v1 ignores
    //    `startsHi` per the file header assumption.
    const originLo = Number(viewport.start & 0xffffffffn);
    packInstances(tile, rows, originLo, scratchFloat, scratchUint!);

    // d. Upload — orphan via `bufferData` only when capacity grew.
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    const byteLen = tile.count * BYTES_PER_INSTANCE;
    if (byteLen > instCapacityBytes) {
      const cap = 1 << Math.ceil(Math.log2(byteLen));
      gl.bufferData(gl.ARRAY_BUFFER, cap, gl.DYNAMIC_DRAW);
      instCapacityBytes = cap;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, scratchFloat, 0, neededFloats);

    // e. Set uniforms.
    program.use();
    const view = buildViewMatrix(viewport, rowHeightPx, yTopPx);
    if (uView !== undefined) gl.uniformMatrix3fv(uView, false, view);

    const pxPerBp = basePixelWidth(viewport);
    if (uMinWidthPx !== undefined) gl.uniform1f(uMinWidthPx, 1.0);
    if (uPxPerBp !== undefined) gl.uniform1f(uPxPerBp, pxPerBp);

    // Median-ish read length feeds the AA softness — picks a sentinel that
    // matches what most fragments will see. Avoids per-instance px-rect.
    const medianLengthBp = tile.lengths[tile.count >> 1] ?? 150;
    const avgWidthPx = Math.max(1, medianLengthBp * pxPerBp);
    if (uRectPx !== undefined) gl.uniform2f(uRectPx, avgWidthPx, rowHeightPx);
    if (uEdgeSoftnessPx !== undefined) gl.uniform1f(uEdgeSoftnessPx, 0.75);

    // Mismatch atlas wiring is deferred to T1.A.3.5. See pileup.frag.glsl.
    if (uShowMismatches !== undefined) gl.uniform1i(uShowMismatches, 0);

    // f. Draw.
    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, tile.count);
    gl.bindVertexArray(null);

    // g. Return row buffer to the pool — renderer re-assigns every frame.
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
      if (scratchFloat !== null) {
        float32Pool.release(scratchFloat);
        scratchFloat = null;
        scratchUint = null;
      }
    },
    stats: () => lastStats,
  };
}
