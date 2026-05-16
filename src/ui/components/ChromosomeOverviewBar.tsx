import { createMemo, For, Show } from 'solid-js';
import { viewport } from '~state/viewport';
import { defaultContextRange } from '~state/context-range';
import { computeTicks, formatTotal } from './ruler-helpers';

/**
 * Chromosome overview bar — top half of the two-level navigator.
 *
 * Always represents the full chromosome length. Renders nice Mb-scale ticks
 * and highlights the current viewport as a thin window so the user can see,
 * at a glance, where they are in the chromosome regardless of the local
 * zoom level.
 *
 * Read-only — interactive selection / zoom lives in the local
 * `RangeSelectionBar` below.
 */

/** Visual floor so a deeply-zoomed viewport (e.g. 50 bp on chr20) is still
 *  visible as a 2-px sliver in the overview. */
const MIN_HIGHLIGHT_PCT = 0.25;

/** Tick count target for the overview; chr20 ⇒ 10-Mb step ⇒ 6 ticks. */
const OVERVIEW_TICK_TARGET = 7;

export function ChromosomeOverviewBar() {
  const chromDomain = createMemo(() => defaultContextRange(viewport().chrom));

  const ticks = createMemo(() => computeTicks(chromDomain(), OVERVIEW_TICK_TARGET));

  const chromLabel = createMemo(() => chromDomain().chrom);
  const totalLabel = createMemo(() => formatTotal(chromDomain().end - chromDomain().start));

  const highlightStyle = createMemo<Record<string, string> | null>(() => {
    const v = viewport();
    const d = chromDomain();
    if (v.chrom !== d.chrom) return null;
    const span = Number(d.end - d.start);
    if (span <= 0) return null;
    const leftFrac = Number(v.start - d.start) / span;
    const rightFrac = Number(v.end - d.start) / span;
    const widthPct = Math.max(MIN_HIGHLIGHT_PCT, (rightFrac - leftFrac) * 100);
    // Floor inflation centred on the actual viewport midpoint so deep-zoom
    // highlights still read as a thin marker over the right Mb.
    const midPct = ((leftFrac + rightFrac) / 2) * 100;
    const leftPct = Math.max(0, Math.min(100 - widthPct, midPct - widthPct / 2));
    return {
      left: `${leftPct}%`,
      width: `${widthPct}%`,
    };
  });

  return (
    <div class="chroma-overview-bar" aria-label="Chromosome overview">
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
