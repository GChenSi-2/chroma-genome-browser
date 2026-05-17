import { Show, createMemo } from 'solid-js';
import { hoveredAnnotation } from '~state/hover';
import { viewport } from '~state/viewport';

/**
 * Hover tooltip for annotation features. Pure DOM (not canvas) because:
 *   - it lives off the per-frame render loop; pointer-move is rare
 *   - text accessibility / selection / theming come free
 *   - multi-line layout doesn't fight the WebGL pipeline
 *
 * Positioning: pinned at the top-centre of the hovered feature's pixel
 * rect, offset 8 px above; `translateX(-50%)` centres horizontally; CSS
 * `max-width` plus `chroma-genome-view`'s overflow keeps it on-screen at
 * the edges (acceptable trade-off — a real edge-flip layout is overkill
 * here).
 */

function strandSymbol(s: -1 | 0 | 1): string {
  if (s > 0) return '+';
  if (s < 0) return '−';
  return '·';
}

function formatPosBp(bp: bigint): string {
  return Number(bp).toLocaleString('en-US');
}

function formatSpanBp(bp: bigint): string {
  const n = Number(bp);
  if (n < 1000) return `${n} bp`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} kb`;
  return `${(n / 1_000_000).toFixed(2)} Mb`;
}

export function AnnotationTooltip() {
  const v = viewport;

  // Pre-compute the placement style so JSX stays simple.
  const placement = createMemo(() => {
    const h = hoveredAnnotation();
    if (!h) return null;
    const anchorX = h.rectPx.left + h.rectPx.width / 2;
    const anchorY = h.rectPx.top;
    return { left: `${anchorX}px`, top: `${anchorY}px` };
  });

  return (
    <Show when={hoveredAnnotation()}>
      {(hAccessor) => {
        const h = hAccessor();
        return (
          <div
            class="chroma-annotation-tooltip"
            style={placement() ?? undefined}
            role="tooltip"
            aria-hidden={false}
          >
            <div class="chroma-annotation-tooltip-name">
              {h.gene.name || h.gene.id}
              <span class="chroma-annotation-tooltip-strand">{strandSymbol(h.gene.strand)}</span>
            </div>
            <Show when={h.gene.biotype}>
              <div class="chroma-annotation-tooltip-biotype">{h.gene.biotype}</div>
            </Show>
            <Show when={h.feature.type !== 'gene'}>
              <div class="chroma-annotation-tooltip-child">
                {h.feature.type}: <span class="chroma-annotation-tooltip-id">{h.feature.name || h.feature.id}</span>
              </div>
            </Show>
            <div class="chroma-annotation-tooltip-coords">
              {v().chrom}:{formatPosBp(h.gene.start)}–{formatPosBp(h.gene.end)}
              <span class="chroma-annotation-tooltip-span">
                {' · '}{formatSpanBp(h.gene.end - h.gene.start)}
              </span>
            </div>
            <Show when={h.gene.id !== h.gene.name}>
              <div class="chroma-annotation-tooltip-id">{h.gene.id}</div>
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
