/**
 * 64-bit genomic coordinate handling.
 *
 * Why this exists:
 *   Human genome is ~3e9 bp. Float32 (mantissa 23 bits) loses precision
 *   at ~16e6, causing visible read jitter when zoomed in past ~16Mb.
 *   We store coords as bigint and only cast to Number after subtracting
 *   the viewport origin (small delta = safe in Float32).
 *
 * Strict invariants (any agent-render PR violating these is rejected):
 *   1. Genomic positions stored as `bigint`, never `number`.
 *   2. Direct `Number(bigint)` cast is FORBIDDEN outside this module.
 *   3. Shader receives `Float32` *relative* coordinates only.
 *   4. View matrix is built here, never inline in renderers.
 */

export type GenomicCoord = bigint;

export interface Viewport {
  chrom: string;
  start: GenomicCoord;
  end: GenomicCoord;
  pxWidth: number;
  pxHeight: number;
}

/**
 * Convert absolute genomic position to viewport-relative number.
 * Safe as long as `pos - origin` fits in Float32 (i.e. viewport span < 1e7 bp).
 *
 * For viewport spans > 1e7 (whole-chromosome view), the renderer should
 * be using coverage mode anyway — individual reads aren't drawn.
 */
export function toRelative(pos: GenomicCoord, origin: GenomicCoord): number {
  const delta = pos - origin;
  // Defensive: catch the case where someone tries to render
  // single reads on a chromosome-wide viewport.
  if (delta > 16_777_216n || delta < -16_777_216n) {
    // 2^24 — Float32 integer precision boundary
    // In production this should never happen if renderer respects LOD;
    // here we still return Number() to not crash, but log loudly.
    console.warn(
      `[coord] delta ${delta} exceeds Float32 safe range; possible precision loss`,
    );
  }
  return Number(delta);
}

/**
 * Build a 3x3 view matrix mapping (relative bp, row) -> NDC (-1..1).
 *
 * Column-major (WebGL convention):
 *   [ sx  0   tx ]
 *   [ 0   sy  ty ]
 *   [ 0   0   1  ]
 *
 * Returns a length-9 Float32Array suitable for uniformMatrix3fv with
 * `transpose = false`.
 */
export function buildViewMatrix(
  viewport: Viewport,
  rowHeight: number,
  topRowYPx: number = 0,
): Float32Array {
  const spanBp = Number(viewport.end - viewport.start);
  // x: relative bp -> NDC
  //   relative bp 0          -> NDC -1
  //   relative bp spanBp     -> NDC +1
  const sx = 2 / spanBp;
  const tx = -1;

  // y: rows -> NDC (top-down, so flip sign)
  //   pixel y = topRowYPx + row * rowHeight
  //   px 0           -> NDC +1
  //   px pxHeight    -> NDC -1
  const pxPerRow = rowHeight;
  const sy = -(2 * pxPerRow) / viewport.pxHeight;
  const ty = 1 - (2 * topRowYPx) / viewport.pxHeight;

  // Column-major
  // prettier-ignore
  return new Float32Array([
    sx, 0,  0,
    0,  sy, 0,
    tx, ty, 1,
  ]);
}

/**
 * basePixelWidth — how many pixels does 1 bp occupy?
 * Drives semantic-zoom decisions.
 */
export function basePixelWidth(viewport: Viewport): number {
  return viewport.pxWidth / Number(viewport.end - viewport.start);
}

export type SemanticLevel = 'overview' | 'coverage' | 'pileup' | 'base';

export function semanticLevel(viewport: Viewport): SemanticLevel {
  const bpw = basePixelWidth(viewport);
  if (bpw < 0.001) return 'overview';
  if (bpw < 0.05) return 'coverage';
  if (bpw < 4) return 'pileup';
  return 'base';
}

/**
 * Inverse: pixel x (within viewport) -> genomic coord.
 * Used for hit-testing, tooltip positioning, click-to-locate.
 */
export function pxToGenomic(
  pxX: number,
  viewport: Viewport,
): GenomicCoord {
  const ratio = pxX / viewport.pxWidth;
  const spanBp = viewport.end - viewport.start;
  // Multiply bigint by float — go through bigint conversion
  const deltaBp = BigInt(Math.floor(ratio * Number(spanBp)));
  return viewport.start + deltaBp;
}

export function genomicToPx(
  pos: GenomicCoord,
  viewport: Viewport,
): number {
  const delta = Number(pos - viewport.start);
  const spanBp = Number(viewport.end - viewport.start);
  return (delta / spanBp) * viewport.pxWidth;
}
