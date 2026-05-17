/**
 * Gene-track label adapter.
 *
 * Bridges between the existing WebGL gene geometry pass and the Canvas2D
 * label overlay. We label GENE features only (not transcripts or exons)
 * to keep the visual quiet — one HGNC symbol per gene row is the IGV-
 * style convention. Row assignment mirrors the WebGL renderer's pass so
 * labels line up vertically with the geometry.
 *
 * Viewport culling runs before any layout lookup so off-screen features
 * never enter the cache. Labels whose drawn width would be < MIN_BLOCK_PX
 * are skipped wholesale — even an ellipsis won't help below that.
 *
 * The renderer never modifies the underlying tile or the WebGL state;
 * Canvas2D is the only side effect.
 */

import type { GeneTile, Viewport } from '~state/types';
import { assignGeneRows } from '~render/tracks-render/gene';
import { layoutAnnotationLabel } from './label-layout';
import { drawAnnotationLabel } from './label-renderer';

/** Below this row height the band is too thin for any glyph; skip labels. */
const MIN_ROW_PX_FOR_LABEL = 14;
/** Below this block width any glyph would have less than half its width
 *  visible; skip even attempting layout. */
const MIN_BLOCK_PX = 12;

/** Same font as `--font-ui` Inter, weight 500. Synced with CSS. */
const LABEL_FONT = '500 11px Inter, system-ui, sans-serif';
/** Padding between block edge and label glyph. */
const LABEL_PADDING_X = 4;

export interface GeneLabelDrawOpts {
  ctx2d: CanvasRenderingContext2D;
  tile: GeneTile;
  viewport: Viewport;
  /** Top of the band for this track, in CSS px. */
  yTopPx: number;
  /** Total band height, in CSS px. */
  bandHeightPx: number;
  /** Resolved CSS colour for the label ink (e.g. `--ink-primary` value). */
  fillStyle: string;
}

export function drawGeneLabels(opts: GeneLabelDrawOpts): void {
  const { ctx2d, tile, viewport, yTopPx, bandHeightPx, fillStyle } = opts;
  const features = tile.features;
  const n = features.length;
  if (n === 0) return;

  const span = Number(viewport.end - viewport.start);
  if (!Number.isFinite(span) || span <= 0) return;

  const { rows, maxRowUsed } = assignGeneRows(features);
  const rowCount = maxRowUsed + 1;
  const rowHeightPx = Math.max(2, bandHeightPx / rowCount);

  if (rowHeightPx < MIN_ROW_PX_FOR_LABEL) {
    // No vertical room for legible text; bail before we measure anything.
    return;
  }

  const pxPerBp = viewport.pxWidth / span;
  const viewportEnd = viewport.pxWidth;

  for (let i = 0; i < n; i++) {
    const f = features[i]!;
    // Only label genes; transcripts/exons inherit the gene row visually.
    if (f.type !== 'gene') continue;

    // Cast bigint → Number is safe here because (f.start - viewport.start)
    // for visible features is bounded by the viewport span (≤ ~few Mb).
    const relStart = Number(f.start - viewport.start);
    const relEnd = Number(f.end - viewport.start);
    const x1 = relStart * pxPerBp;
    const x2 = relEnd * pxPerBp;

    // Viewport culling — feature entirely outside the canvas.
    if (x2 <= 0 || x1 >= viewportEnd) continue;

    // Clip to viewport for the layout decision so a half-on-screen gene
    // still gets the longest label that fits in its visible portion.
    const visibleX1 = Math.max(0, x1);
    const visibleX2 = Math.min(viewportEnd, x2);
    const blockWidth = visibleX2 - visibleX1;
    if (blockWidth < MIN_BLOCK_PX) continue;

    const text = f.name && f.name.length > 0 ? f.name : f.id;
    const layout = layoutAnnotationLabel({
      text,
      maxWidth: blockWidth,
      font: LABEL_FONT,
      paddingX: LABEL_PADDING_X,
    });
    if (!layout.visible) continue;

    const rowIdx = rows[i] ?? 0;
    const rowTopPx = yTopPx + rowIdx * rowHeightPx;

    drawAnnotationLabel({
      ctx: ctx2d,
      layout,
      blockLeftPx: visibleX1,
      blockRightPx: visibleX2,
      rowTopPx,
      rowHeightPx,
      strand: f.strand,
      paddingX: LABEL_PADDING_X,
      fillStyle,
      font: LABEL_FONT,
    });
  }
}
