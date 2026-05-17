import { For, Show, createMemo, onCleanup, onMount } from 'solid-js';
import {
  hoveredAnnotation,
  pinnedAnnotation,
  setPinnedAnnotation,
  type HoveredAnnotation,
} from '~state/hover';
import { viewport } from '~state/viewport';
import { tracks } from '~state/tracks';
import type { GeneTrack, TrackConfig } from '~state/types';
import X from 'lucide-solid/icons/x';

/**
 * Annotation inspector tooltip — two-mode.
 *
 *   Hover mode (transient): brief identity card while pointer is over a
 *     feature. Dismisses when the pointer leaves.
 *   Pinned mode (sticky):  click a feature to pin. Adds a WHERE section
 *     (source track + URL) and a WHY section (per-feature rendering
 *     decisions explained). Dismisses on Esc, on click of empty canvas,
 *     or on close button.
 *
 * The pinned state wins over the hover state — once a user inspects a
 * feature, panning or hovering other features doesn't blow away the
 * pinned card. Their attention is on the pinned item.
 *
 * Pure DOM (Solid). Positions absolutely inside `.chroma-genome-view`.
 */

function strandSymbol(s: -1 | 0 | 1): string {
  if (s > 0) return '+';
  if (s < 0) return '−';
  return '·';
}

function strandLabel(s: -1 | 0 | 1): string {
  if (s > 0) return 'forward strand (5′ → 3′ rightward)';
  if (s < 0) return 'reverse strand (5′ → 3′ leftward)';
  return 'unstranded';
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

function findTrack(trackId: string): TrackConfig | null {
  return tracks().find((t) => t.id === trackId) ?? null;
}

/** Human-friendly source description for the WHERE pane. */
function sourceLine(track: TrackConfig): string {
  if (track.kind === 'gene') {
    const g = track as GeneTrack;
    if (g.format === 'ensembl-rest') {
      return `Ensembl REST · ${g.ensemblHost ?? g.url}`;
    }
    return `${g.format ?? 'gene'} · ${g.url}`;
  }
  return track.url;
}

function isBlobUrl(url: string): boolean {
  return url.startsWith('blob:');
}

/** Per-feature "why does this render like that?" explanations. */
function whyLines(h: HoveredAnnotation): string[] {
  const lines: string[] = [];
  lines.push(strandLabel(h.feature.strand));
  if (h.feature.type === 'exon') {
    lines.push('Drawn as thick band (exon priority over transcript backbone).');
  } else if (h.feature.type === 'transcript') {
    lines.push('Drawn as backbone line (between exon blocks of this transcript).');
  } else {
    lines.push('Drawn as light gene-extent band (full transcript stack span).');
  }
  return lines;
}

export function AnnotationTooltip() {
  // Pinned > hover. Hover is what the cursor reports right now; pinned is
  // the user's anchored choice.
  const active = createMemo<HoveredAnnotation | null>(
    () => pinnedAnnotation() ?? hoveredAnnotation(),
  );
  const isPinned = createMemo(() => pinnedAnnotation() !== null);

  // Esc anywhere clears the pin (the live hover dismisses on its own
  // when the pointer leaves).
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && pinnedAnnotation() !== null) {
      e.preventDefault();
      setPinnedAnnotation(null);
    }
  }
  onMount(() => document.addEventListener('keydown', onKeyDown));
  onCleanup(() => document.removeEventListener('keydown', onKeyDown));

  return (
    <Show when={active()}>
      {(hAccessor) => {
        const h = hAccessor();
        const track = createMemo(() => findTrack(h.trackId));
        const pinned = isPinned();
        const anchorX = h.rectPx.left + h.rectPx.width / 2;
        const anchorY = h.rectPx.top;
        return (
          <div
            class="chroma-annotation-tooltip"
            classList={{ 'chroma-annotation-tooltip--pinned': pinned }}
            style={{
              left: `${anchorX}px`,
              // Hover (short card) floats ABOVE the feature; pinned (taller,
              // multi-section) sits BELOW so its body doesn't overflow the
              // canvas top edge. CSS handles the actual translate direction
              // via the `--pinned` class.
              top: pinned ? `${anchorY + h.rectPx.height}px` : `${anchorY}px`,
              // When pinned the tooltip itself must be clickable (close
              // button, link-copyable URLs). Hover mode keeps pointer-events
              // off so the cursor still reaches the underlying feature.
              'pointer-events': pinned ? 'auto' : 'none',
            }}
            role={pinned ? 'dialog' : 'tooltip'}
            aria-label={pinned ? `Feature inspector: ${h.gene.name || h.gene.id}` : undefined}
          >
            <Show when={pinned}>
              <button
                type="button"
                class="chroma-annotation-tooltip-close"
                aria-label="Close inspector"
                title="Close (Esc)"
                onClick={() => setPinnedAnnotation(null)}
              >
                <X size={12} />
              </button>
            </Show>

            {/* WHAT — identity */}
            <div class="chroma-annotation-tooltip-name">
              {h.gene.name || h.gene.id}
              <span class="chroma-annotation-tooltip-strand">{strandSymbol(h.gene.strand)}</span>
            </div>
            <Show when={h.gene.biotype}>
              <div class="chroma-annotation-tooltip-biotype">{h.gene.biotype}</div>
            </Show>
            <Show when={h.feature.type !== 'gene'}>
              <div class="chroma-annotation-tooltip-child">
                {h.feature.type}:{' '}
                <span class="chroma-annotation-tooltip-id">
                  {h.feature.name || h.feature.id}
                </span>
              </div>
            </Show>

            {/* Coordinates */}
            <div class="chroma-annotation-tooltip-coords">
              {viewport().chrom}:{formatPosBp(h.gene.start)}–{formatPosBp(h.gene.end)}
              <span class="chroma-annotation-tooltip-span">
                {' · '}{formatSpanBp(h.gene.end - h.gene.start)}
              </span>
            </div>
            <Show when={h.gene.id !== h.gene.name}>
              <div class="chroma-annotation-tooltip-id">{h.gene.id}</div>
            </Show>

            {/* WHERE + WHY — pinned only. Hover mode keeps the card tight. */}
            <Show when={pinned}>
              <Show when={track()}>
                {(tAcc) => {
                  const t = tAcc();
                  return (
                    <div class="chroma-annotation-tooltip-section">
                      <div class="chroma-annotation-tooltip-section-label">Source</div>
                      <div class="chroma-annotation-tooltip-source">{t.label}</div>
                      <div class="chroma-annotation-tooltip-source-detail">
                        {sourceLine(t)}
                        <Show when={isBlobUrl(t.url)}>
                          <span class="chroma-annotation-tooltip-tag">local file</span>
                        </Show>
                      </div>
                    </div>
                  );
                }}
              </Show>
              <div class="chroma-annotation-tooltip-section">
                <div class="chroma-annotation-tooltip-section-label">Render</div>
                <For each={whyLines(h)}>
                  {(line) => (
                    <div class="chroma-annotation-tooltip-why">· {line}</div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
