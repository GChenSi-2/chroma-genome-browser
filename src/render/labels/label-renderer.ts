/**
 * Single-label Canvas2D draw — strand-aware horizontal alignment, vertical
 * centring inside the row. Lives in CSS-pixel space; caller is responsible
 * for setting up the Canvas2D context's DPR transform once (typically in
 * the scheduler's resize path).
 */

import type { LabelLayoutResult } from './label-layout';

export interface LabelDrawOpts {
  ctx: CanvasRenderingContext2D;
  layout: LabelLayoutResult;
  /** Left edge of the annotation block in CSS px. */
  blockLeftPx: number;
  /** Right edge of the annotation block in CSS px. */
  blockRightPx: number;
  /** Top of the row in CSS px. */
  rowTopPx: number;
  /** Row height in CSS px. */
  rowHeightPx: number;
  /** Strand: −1, 0, +1. Drives horizontal alignment. */
  strand: -1 | 0 | 1;
  /** Inner horizontal breathing room. Default 4 px. Must match the value
   *  passed to `layoutAnnotationLabel` so we don't draw past the truncation
   *  decision boundary. */
  paddingX?: number;
  /** Foreground colour, e.g. `--ink-primary` resolved to a CSS string. */
  fillStyle: string;
  /** Canvas `font` shorthand. Must match the layout's font. */
  font: string;
}

export function drawAnnotationLabel(opts: LabelDrawOpts): void {
  const { ctx, layout, blockLeftPx, blockRightPx, rowTopPx, rowHeightPx, strand, fillStyle, font } = opts;
  if (!layout.visible) return;
  const paddingX = opts.paddingX ?? 4;

  // Strand convention: forward (+1) anchors to the 5' end on the LEFT of
  // the block; reverse (−1) anchors to the 5' end on the RIGHT; neutral
  // (0) centres. Matches how biologists scan the band visually.
  let x: number;
  let textAlign: CanvasTextAlign;
  if (strand > 0) {
    x = blockLeftPx + paddingX;
    textAlign = 'left';
  } else if (strand < 0) {
    x = blockRightPx - paddingX;
    textAlign = 'right';
  } else {
    x = (blockLeftPx + blockRightPx) / 2;
    textAlign = 'center';
  }

  const y = rowTopPx + rowHeightPx / 2;

  ctx.font = font;
  ctx.fillStyle = fillStyle;
  ctx.textAlign = textAlign;
  ctx.textBaseline = 'middle';
  ctx.fillText(layout.displayText, x, y);
}
