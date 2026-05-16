/**
 * Gene annotation renderer.
 *
 * One band stacks gene / transcript / exon features into pileup-style rows.
 * Each feature draws as a single instanced quad; the feature type and strand
 * pick the color and the vertical position WITHIN a row:
 *
 *      transcript backbone:    thin horizontal line across the transcript
 *      exon:                   filled rectangle covering most of the row
 *      gene:                   subtle background tint behind transcripts
 *
 * Multiple transcripts of the same gene stack as separate rows. Genes that
 * overlap in genomic space also stack (greedy first-fit row assignment,
 * same algorithm as the pileup renderer but with a parent-aware grouping
 * pass so a gene + its transcripts + its exons share rows).
 *
 * Colors come from DESIGN_SYSTEM §2.2 — the `--accent` strand-neutral
 * tone for exons, surface-3 for backbones, accent-soft for gene tints.
 */

import type { GeneTile, GeneFeature, Viewport } from '~state/types';
import { createProgram, type Program } from '../webgl/program';
import { float32Pool, uint16Pool } from '../webgl/buffer-pool';
import { buildViewMatrix } from '../coord';

// ─── Shader ────────────────────────────────────────────────────────────────
//
// Instance attributes:
//   a_pos:   (relStartBp, lengthBp)
//   a_row:   pileup row index (float, integer-valued)
//   a_meta:  bit-packed (typeCode * 4 + (strand+1))
//             typeCode: 0=gene, 1=transcript, 2=exon
//             strand:   -1, 0, +1
//
// We pick height + color in the vertex shader using a tiny lookup driven by
// the meta uint — keeps the fragment shader trivial.

const VERT_SRC = /* glsl */ `#version 300 es
precision highp float;
in vec2  a_quad;
in vec2  a_pos;
in float a_row;
in uint  a_meta;
uniform mat3  u_view;
uniform float u_minWidthPx;
uniform float u_pxPerBp;

flat out uint v_type;

void main() {
  float lengthBp     = a_pos.y;
  float minLengthBp  = u_minWidthPx / max(u_pxPerBp, 1e-6);
  float visualLength = max(lengthBp, minLengthBp);

  uint typeCode = a_meta >> 2u;          // 0 gene, 1 transcript, 2 exon
  v_type = typeCode;

  // Per-type vertical layout within a row (row height = 1 in y).
  //   gene: full row, low alpha (drawn behind everything)
  //   transcript: thin backbone, vertically centred
  //   exon: thick band, centred
  vec2 box;
  if (typeCode == 0u) {            // gene
    box = vec2(0.05, 0.95);
  } else if (typeCode == 1u) {     // transcript backbone
    box = vec2(0.45, 0.55);
  } else {                         // exon
    box = vec2(0.20, 0.80);
  }

  float yLow  = a_row + box.x;
  float yHigh = a_row + box.y;
  float yLocal = mix(yLow, yHigh, a_quad.y);

  vec2 localPos = vec2(a_pos.x + a_quad.x * visualLength, yLocal);
  vec3 ndc = u_view * vec3(localPos, 1.0);
  gl_Position = vec4(ndc.xy, 0.0, 1.0);
}
`;

const FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;
flat in uint v_type;
out vec4 outColor;

void main() {
  // Colors from DESIGN_SYSTEM §2.2.
  // gene tint  = --accent-soft #dbeafe (light) at 0.4 alpha
  // transcript = --ink-tertiary #a1a1aa
  // exon       = --accent #2563eb
  if (v_type == 0u) {
    outColor = vec4(0.86, 0.91, 0.93, 0.35);   // accent-soft, faded
  } else if (v_type == 1u) {
    outColor = vec4(0.63, 0.63, 0.67, 1.0);    // ink-tertiary
  } else {
    outColor = vec4(0.145, 0.388, 0.922, 1.0); // accent
  }
}
`;

// ─── Pileup row assignment ────────────────────────────────────────────────
//
// We want a gene + its transcripts + its exons to share one row, with
// overlapping genes stacking. Strategy:
//   1. Pass 1: place gene features greedy first-fit.
//   2. Pass 2: place transcript features in their gene's row (lookup by
//      parentId). Orphan transcripts (no matching gene) get their own row.
//   3. Pass 3: exons inherit their transcript's row.

const DEFAULT_MAX_ROWS = 50;

interface AssignedRows {
  rows: Uint16Array;
  maxRowUsed: number;
}

export function assignGeneRows(
  features: ReadonlyArray<GeneFeature>,
  maxRows: number = DEFAULT_MAX_ROWS,
): AssignedRows {
  const n = features.length;
  const rows = uint16Pool.acquire(n);
  rows.fill(0, 0, n);
  if (n === 0) return { rows, maxRowUsed: 0 };

  // rowEnds tracks the right-most genomic end placed on each row.
  const rowEnds = new Float64Array(maxRows);
  rowEnds.fill(-Infinity);
  let maxRowUsed = 0;

  // Map feature id -> row index, for the parent lookup in passes 2 + 3.
  const idToRow = new Map<string, number>();

  const place = (idx: number, anchorStart: number, anchorEnd: number): number => {
    // First-fit: pick the lowest-index row whose previous end <= anchorStart.
    for (let r = 0; r <= maxRowUsed; r++) {
      if ((rowEnds[r] ?? -Infinity) <= anchorStart) {
        rowEnds[r] = anchorEnd;
        rows[idx] = r;
        return r;
      }
    }
    if (maxRowUsed + 1 < maxRows) {
      maxRowUsed++;
      rowEnds[maxRowUsed] = anchorEnd;
      rows[idx] = maxRowUsed;
      return maxRowUsed;
    }
    rows[idx] = maxRows - 1;
    return maxRows - 1;
  };

  // Pass 1: genes.
  for (let i = 0; i < n; i++) {
    const f = features[i]!;
    if (f.type !== 'gene') continue;
    const row = place(i, Number(f.start), Number(f.end));
    idToRow.set(f.id, row);
  }

  // Pass 2: transcripts. Inherit gene row if known; else first-fit.
  for (let i = 0; i < n; i++) {
    const f = features[i]!;
    if (f.type !== 'transcript') continue;
    const parentRow = f.parentId ? idToRow.get(f.parentId) : undefined;
    if (parentRow !== undefined) {
      rows[i] = parentRow;
    } else {
      place(i, Number(f.start), Number(f.end));
    }
    idToRow.set(f.id, rows[i] ?? 0);
  }

  // Pass 3: exons. Inherit transcript row if known; else first-fit on its
  // own row (orphan exons in fragmented annotations).
  for (let i = 0; i < n; i++) {
    const f = features[i]!;
    if (f.type !== 'exon') continue;
    const parentRow = f.parentId ? idToRow.get(f.parentId) : undefined;
    if (parentRow !== undefined) {
      rows[i] = parentRow;
    } else {
      place(i, Number(f.start), Number(f.end));
    }
  }

  return { rows, maxRowUsed };
}

// ─── Public API ────────────────────────────────────────────────────────────

const FLOATS_PER_INSTANCE = 4;       // posX, lengthBp, row, meta-as-uint
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;

export interface GeneRenderer {
  draw(tile: GeneTile, viewport: Viewport, yTopPx: number, heightPx: number): void;
  dispose(): void;
  stats(): { featureCount: number; rowsUsed: number };
}

export function createGeneRenderer(gl: WebGL2RenderingContext): GeneRenderer {
  const program: Program = createProgram(gl, {
    vertSrc: VERT_SRC,
    fragSrc: FRAG_SRC,
    attribs: ['a_quad', 'a_pos', 'a_row', 'a_meta'],
    uniforms: ['u_view', 'u_minWidthPx', 'u_pxPerBp'],
    label: 'gene',
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
  const aMeta = program.attribs.a_meta ?? -1;
  if (aMeta >= 0) {
    gl.enableVertexAttribArray(aMeta);
    gl.vertexAttribIPointer(aMeta, 1, gl.UNSIGNED_INT, stride, 12);
    gl.vertexAttribDivisor(aMeta, 1);
  }

  gl.bindVertexArray(null);

  const uView = program.uniforms.u_view;
  const uMinWidthPx = program.uniforms.u_minWidthPx;
  const uPxPerBp = program.uniforms.u_pxPerBp;

  let scratch: Float32Array | null = null;
  let scratchUint: Uint32Array | null = null;
  let lastStats = { featureCount: 0, rowsUsed: 0 };

  function packInstances(
    features: ReadonlyArray<GeneFeature>,
    rows: Uint16Array,
    originLo: number,
    out: Float32Array,
    outUint: Uint32Array,
  ): void {
    for (let i = 0; i < features.length; i++) {
      const f = features[i]!;
      const o = i * FLOATS_PER_INSTANCE;
      // Cast bigint -> Number after subtracting origin (delta is small).
      const rel = Number(f.start - BigInt(originLo));
      const length = Number(f.end - f.start);
      const typeCode = f.type === 'gene' ? 0 : f.type === 'transcript' ? 1 : 2;
      // strand maps -1/0/+1 -> 0/1/2 so it stays in 0..3
      const strandCode = f.strand === -1 ? 0 : f.strand === 0 ? 1 : 2;
      out[o]     = rel;
      out[o + 1] = length;
      out[o + 2] = rows[i] ?? 0;
      outUint[o + 3] = (typeCode << 2) | strandCode;
    }
  }

  const draw: GeneRenderer['draw'] = (tile, viewport, yTopPx, heightPx) => {
    const features = tile.features;
    const n = features.length;
    if (n === 0) {
      lastStats = { featureCount: 0, rowsUsed: 0 };
      return;
    }

    const { rows, maxRowUsed } = assignGeneRows(features);
    const rowCount = maxRowUsed + 1;

    const neededFloats = n * FLOATS_PER_INSTANCE;
    if (scratch === null || scratch.length < neededFloats) {
      if (scratch !== null) float32Pool.release(scratch);
      scratch = float32Pool.acquire(neededFloats);
      scratchUint = new Uint32Array(scratch.buffer);
    }

    const originLo = Number(viewport.start & 0xffffffffn);
    packInstances(features, rows, originLo, scratch, scratchUint!);

    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    const byteLen = n * BYTES_PER_INSTANCE;
    const cap = byteLen > instCapacityBytes
      ? 1 << Math.ceil(Math.log2(byteLen))
      : instCapacityBytes;
    gl.bufferData(gl.ARRAY_BUFFER, cap, gl.DYNAMIC_DRAW);
    instCapacityBytes = cap;
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, scratch, 0, neededFloats);

    program.use();
    // Map (relativeBp, row) -> NDC. Row spans heightPx / rowCount each.
    const rowHeightPx = Math.max(2, heightPx / rowCount);
    const view = buildViewMatrix(viewport, rowHeightPx, yTopPx);
    if (uView !== undefined) gl.uniformMatrix3fv(uView, false, view);

    const pxPerBp = viewport.pxWidth / Number(viewport.end - viewport.start);
    if (uMinWidthPx !== undefined) gl.uniform1f(uMinWidthPx, 1.0);
    if (uPxPerBp !== undefined) gl.uniform1f(uPxPerBp, pxPerBp);

    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(null);

    uint16Pool.release(rows);
    lastStats = { featureCount: n, rowsUsed: rowCount };
  };

  return {
    draw,
    dispose() {
      gl.deleteBuffer(quadBuf);
      gl.deleteBuffer(instBuf);
      gl.deleteVertexArray(vao);
      program.dispose();
      if (scratch !== null) {
        float32Pool.release(scratch);
        scratch = null;
        scratchUint = null;
      }
    },
    stats: () => lastStats,
  };
}
