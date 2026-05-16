import { createMemo, For, Show } from 'solid-js';
import { contextRange } from '~state/context-range';
import { viewport } from '~state/viewport';
import { contextToFraction } from '~render/coord';
import {
  computeTicks,
  formatPosition,
  formatSpan,
} from './ruler-helpers';
import { useRangeBarInteraction } from './useRangeBarInteraction';

/**
 * Local range bar — bottom half of the two-level navigator.
 *
 * Domain: the auto-adapted `contextRange` (≈ 10× viewport span). The user
 * does precise editing here — drag-create, drag-move, edge-resize. The
 * floating chip carries `{span} · {startPos}` so the displayed start
 * aligns with the TopBar locus `chrN:start-end` users navigate by.
 *
 * Pair with `ChromosomeOverviewBar` above, which handles coarse positioning
 * against the full chromosome.
 */

const MIN_VISIBLE_PX = 3;
const LOCAL_TICK_TARGET = 5;

export function RangeSelectionBar() {
  let barRef: HTMLDivElement | undefined;

  const selectionFraction = createMemo<{ left: number; right: number } | null>(() => {
    const r = contextRange();
    const v = viewport();
    if (v.chrom !== r.chrom) return null;
    return {
      left: contextToFraction(v.start, r),
      right: contextToFraction(v.end, r),
    };
  });

  function readBarRect(): DOMRect | null {
    return barRef?.getBoundingClientRect() ?? null;
  }

  /**
   * Rendered selection edges, after MIN_VISIBLE_PX inflation. Hit-test uses
   * this so the user can grab whatever they see, not invisible sub-pixel
   * slivers. Returns null when off-chrom or the bar isn't measurable.
   */
  function visibleSelectionPx(rect: DOMRect): { leftPx: number; rightPx: number } | null {
    const sel = selectionFraction();
    if (!sel) return null;
    let leftPx = sel.left * rect.width;
    let rightPx = sel.right * rect.width;
    if (rightPx - leftPx < MIN_VISIBLE_PX) {
      const midPx = (leftPx + rightPx) / 2;
      leftPx = Math.max(0, midPx - MIN_VISIBLE_PX / 2);
      rightPx = Math.min(rect.width, midPx + MIN_VISIBLE_PX / 2);
    }
    return { leftPx, rightPx };
  }

  const interaction = useRangeBarInteraction({
    domain: contextRange,
    getBarRect: readBarRect,
    visibleEdgesPx: visibleSelectionPx,
    setPointerCapture: (id) => barRef?.setPointerCapture(id),
    releasePointerCapture: (id) => barRef?.releasePointerCapture(id),
    enableResize: true,
    enableClickToJump: false,
    primeOnDown: true,
  });

  const selectionStyle = createMemo<Record<string, string> | null>(() => {
    const sel = selectionFraction();
    if (!sel) return null;
    const rect = readBarRect();
    const widthPx = rect?.width ?? 0;
    let leftFrac = sel.left;
    let rightFrac = sel.right;
    if (widthPx > 0) {
      const minFrac = MIN_VISIBLE_PX / widthPx;
      if (rightFrac - leftFrac < minFrac) {
        const mid = (leftFrac + rightFrac) / 2;
        leftFrac = Math.max(0, mid - minFrac / 2);
        rightFrac = Math.min(1, mid + minFrac / 2);
      }
    }
    return {
      left: `${leftFrac * 100}%`,
      width: `${(rightFrac - leftFrac) * 100}%`,
    };
  });

  const selectionLabel = createMemo<{ text: string; leftPct: number } | null>(() => {
    const sel = selectionFraction();
    if (!sel) return null;
    const v = viewport();
    const r = contextRange();
    if (v.chrom !== r.chrom) return null;
    const span = Number(v.end - v.start);
    if (span <= 0) return null;
    // Chip is centred over the block midpoint visually, but its text shows
    // viewport START — matches the TopBar `chrN:start-end` convention.
    const midFrac = (sel.left + sel.right) / 2;
    return {
      text: `${formatSpan(span)} · ${formatPosition(v.start)}`,
      leftPct: midFrac * 100,
    };
  });

  const localTicks = createMemo(() => computeTicks(contextRange(), LOCAL_TICK_TARGET));

  return (
    <div
      class="chroma-range-bar"
      ref={barRef}
      style={{ cursor: interaction.cursor() }}
      role="slider"
      aria-label="Local viewport range"
      onPointerDown={interaction.handlers.onPointerDown}
      onPointerMove={interaction.handlers.onPointerMove}
      onPointerUp={interaction.handlers.onPointerUp}
      onPointerCancel={interaction.handlers.onPointerCancel}
      onPointerLeave={interaction.handlers.onPointerLeave}
    >
      <Show when={selectionLabel()}>
        {(label) => (
          <div
            class="chroma-range-bar-label"
            style={{ left: `${label().leftPct}%` }}
            aria-hidden="true"
          >
            {label().text}
          </div>
        )}
      </Show>
      <div class="chroma-range-bar-track" aria-hidden="true">
        <For each={localTicks()}>
          {(t) => (
            <div
              class="chroma-range-bar-tick"
              style={{ left: `${t.fraction * 100}%` }}
              aria-hidden="true"
            >
              <span class="chroma-range-bar-tick-label">{t.label}</span>
            </div>
          )}
        </For>
      </div>
      <Show when={selectionStyle()}>
        {(style) => (
          <div class="chroma-range-bar-selection" style={style()}>
            <div class="chroma-range-bar-edge chroma-range-bar-edge--start" />
            <div class="chroma-range-bar-edge chroma-range-bar-edge--end" />
          </div>
        )}
      </Show>
    </div>
  );
}
