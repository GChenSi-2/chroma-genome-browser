import { createMemo, For, Show } from 'solid-js';
import { viewport } from '~state/viewport';
import { defaultContextRange } from '~state/context-range';
import { computeTicks, formatTotal } from './ruler-helpers';
import { useRangeBarInteraction } from './useRangeBarInteraction';

/**
 * Chromosome overview bar — top half of the two-level navigator.
 *
 * Always represents the full chromosome. Renders Mb-scale ticks and the
 * current viewport as an accent-coloured window. Coarse positioning lives
 * here: click to jump, drag the window to pan, drag the empty bar to
 * drag-create a new region.
 *
 * Edge resize is deliberately disabled — at chromosome scale the highlight
 * is often a sub-pixel sliver; precise width changes belong to the local
 * range bar below.
 */

const MIN_HIGHLIGHT_PCT = 0.25;
const MIN_HIGHLIGHT_PX = 4;
const OVERVIEW_TICK_TARGET = 7;

export function ChromosomeOverviewBar() {
  let barRef: HTMLDivElement | undefined;

  const chromDomain = createMemo(() => defaultContextRange(viewport().chrom));

  const ticks = createMemo(() => computeTicks(chromDomain(), OVERVIEW_TICK_TARGET));
  const chromLabel = createMemo(() => chromDomain().chrom);
  const totalLabel = createMemo(() => formatTotal(chromDomain().end - chromDomain().start));

  /** Viewport-window fractions inside the full-chrom domain. */
  const viewportFraction = createMemo<{ left: number; right: number } | null>(() => {
    const v = viewport();
    const d = chromDomain();
    if (v.chrom !== d.chrom) return null;
    const span = Number(d.end - d.start);
    if (span <= 0) return null;
    return {
      left: Number(v.start - d.start) / span,
      right: Number(v.end - d.start) / span,
    };
  });

  function readBarRect(): DOMRect | null {
    return barRef?.getBoundingClientRect() ?? null;
  }

  /**
   * Rendered highlight edges in pixels, after MIN_HIGHLIGHT_PX inflation.
   * The composable's hit-test uses this so a deep-zoom viewport whose
   * highlight is sub-pixel-thin still reads as a grabbable "inside" zone
   * (so drag-to-pan works even at chr-wide zoom-outs).
   */
  function visibleHighlightPx(rect: DOMRect): { leftPx: number; rightPx: number } | null {
    const f = viewportFraction();
    if (!f) return null;
    let leftPx = f.left * rect.width;
    let rightPx = f.right * rect.width;
    if (rightPx - leftPx < MIN_HIGHLIGHT_PX) {
      const midPx = (leftPx + rightPx) / 2;
      leftPx = Math.max(0, midPx - MIN_HIGHLIGHT_PX / 2);
      rightPx = Math.min(rect.width, midPx + MIN_HIGHLIGHT_PX / 2);
    }
    return { leftPx, rightPx };
  }

  const interaction = useRangeBarInteraction({
    domain: chromDomain,
    getBarRect: readBarRect,
    visibleEdgesPx: visibleHighlightPx,
    setPointerCapture: (id) => barRef?.setPointerCapture(id),
    releasePointerCapture: (id) => barRef?.releasePointerCapture(id),
    enableResize: false,
    enableClickToJump: true,
    primeOnDown: false,
  });

  const highlightStyle = createMemo<Record<string, string> | null>(() => {
    const f = viewportFraction();
    if (!f) return null;
    const widthPct = Math.max(MIN_HIGHLIGHT_PCT, (f.right - f.left) * 100);
    const midPct = ((f.left + f.right) / 2) * 100;
    const leftPct = Math.max(0, Math.min(100 - widthPct, midPct - widthPct / 2));
    return {
      left: `${leftPct}%`,
      width: `${widthPct}%`,
    };
  });

  return (
    <div
      class="chroma-overview-bar"
      ref={barRef}
      style={{ cursor: interaction.cursor() }}
      role="slider"
      aria-label="Chromosome overview"
      onPointerDown={interaction.handlers.onPointerDown}
      onPointerMove={interaction.handlers.onPointerMove}
      onPointerUp={interaction.handlers.onPointerUp}
      onPointerCancel={interaction.handlers.onPointerCancel}
      onPointerLeave={interaction.handlers.onPointerLeave}
    >
      <div class="chroma-overview-bar-meta" aria-hidden="true">
        <span>{chromLabel()}</span>
        <span>{totalLabel()}</span>
      </div>
      <div class="chroma-overview-bar-track" aria-hidden="true">
        <For each={ticks()}>
          {(t) => (
            <div
              class="chroma-overview-bar-tick"
              style={{ left: `${t.fraction * 100}%` }}
            >
              <span class="chroma-overview-bar-tick-label">{t.label}</span>
            </div>
          )}
        </For>
        <Show when={highlightStyle()}>
          {(s) => <div class="chroma-overview-bar-highlight" style={s()} />}
        </Show>
      </div>
    </div>
  );
}
