import { For, Show, createMemo, onCleanup, onMount } from 'solid-js';
import {
  hoveredAnnotation,
  pinnedAnnotation,
  setPinnedAnnotation,
  type HoveredGene,
  type HoveredItem,
  type HoveredVariant,
  type VariantKind,
} from '~state/hover';
import { viewport } from '~state/viewport';
import { tracks } from '~state/tracks';
import type { GeneTrack, TrackConfig, VcfTrack } from '~state/types';
import X from 'lucide-solid/icons/x';

/**
 * Annotation inspector tooltip — two-mode + multi-kind.
 *
 *   Hover mode (transient): brief identity card while pointer is over a
 *     feature. Dismisses when the pointer leaves.
 *   Pinned mode (sticky):  click a feature to pin. Adds a WHERE section
 *     (source track + URL) and a WHY section (per-feature rendering
 *     decisions explained). Dismisses on Esc, on click of empty canvas,
 *     or on close button.
 *
 * Two feature kinds supported today:
 *   - Gene/transcript/exon (gene track)
 *   - VCF variant (vcf track)
 * Each renders WHAT/WHERE/WHY appropriate to its data shape.
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

function sourceLine(track: TrackConfig): string {
  if (track.kind === 'gene') {
    const g = track as GeneTrack;
    if (g.format === 'ensembl-rest') {
      return `Ensembl REST · ${g.ensemblHost ?? g.url}`;
    }
    return `${g.format ?? 'gene'} · ${g.url}`;
  }
  if (track.kind === 'vcf') {
    const v = track as VcfTrack;
    return `Tabix-indexed VCF · ${v.url}`;
  }
  return track.url;
}

function isBlobUrl(url: string): boolean {
  return url.startsWith('blob:');
}

// ── Gene-specific helpers ────────────────────────────────────────────────

function geneWhyLines(h: HoveredGene): string[] {
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

// ── Variant-specific helpers ─────────────────────────────────────────────

const VARIANT_KIND_LABEL: Record<VariantKind, string> = {
  snv: 'SNV (single-nucleotide variant)',
  ins: 'insertion',
  del: 'deletion',
  mnv: 'MNV (multi-nucleotide variant)',
  sv:  'structural variant',
};

const VARIANT_KIND_COLOR: Record<VariantKind, string> = {
  snv: '#e69f00',
  ins: '#56b4e9',
  del: '#cc79a7',
  mnv: '#009e73',
  sv:  '#d55e00',
};

function variantWhyLines(h: HoveredVariant): string[] {
  const v = h.variant;
  const out: string[] = [];
  out.push(`Coloured as ${v.type.toUpperCase()} per DESIGN_SYSTEM §2.2 (${VARIANT_KIND_LABEL[v.type]}).`);
  if (v.type === 'snv') {
    out.push(`Single tick: REF "${v.ref}" → ALT "${v.alt}".`);
  } else if (v.type === 'ins') {
    out.push(`Inserted ${v.alt.length - v.ref.length} bp after position ${formatPosBp(v.pos)}.`);
  } else if (v.type === 'del') {
    out.push(`Deleted ${v.ref.length - v.alt.length} bp starting at position ${formatPosBp(v.pos)}.`);
  } else if (v.type === 'mnv') {
    out.push(`Block substitution: REF "${v.ref}" → ALT "${v.alt}", same length.`);
  } else {
    out.push(`Symbolic ALT "${v.alt}" indicates a structural variant; bracket coords live in INFO.`);
  }
  if (Number.isFinite(v.qual) && v.qual > 0) {
    out.push(`Quality (PHRED) ${v.qual.toFixed(1)}.`);
  }
  return out;
}

export function AnnotationTooltip() {
  const active = createMemo<HoveredItem | null>(
    () => pinnedAnnotation() ?? hoveredAnnotation(),
  );
  const isPinned = createMemo(() => pinnedAnnotation() !== null);

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
              top: pinned ? `${anchorY + h.rectPx.height}px` : `${anchorY}px`,
              'pointer-events': pinned ? 'auto' : 'none',
            }}
            role={pinned ? 'dialog' : 'tooltip'}
            aria-label={pinned ? 'Feature inspector' : undefined}
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

            {/* WHAT — identity. Kind-specific body. Plain conditional
                children keep TS happy without the keyed-accessor dance. */}
            {h.kind === 'gene' && (() => {
              const g = h as HoveredGene;
              return (
                <>
                  <div class="chroma-annotation-tooltip-name">
                    {g.gene.name || g.gene.id}
                    <span class="chroma-annotation-tooltip-strand">{strandSymbol(g.gene.strand)}</span>
                  </div>
                  <Show when={g.gene.biotype}>
                    <div class="chroma-annotation-tooltip-biotype">{g.gene.biotype}</div>
                  </Show>
                  <Show when={g.feature.type !== 'gene'}>
                    <div class="chroma-annotation-tooltip-child">
                      {g.feature.type}:{' '}
                      <span class="chroma-annotation-tooltip-id">
                        {g.feature.name || g.feature.id}
                      </span>
                    </div>
                  </Show>
                  <div class="chroma-annotation-tooltip-coords">
                    {viewport().chrom}:{formatPosBp(g.gene.start)}–{formatPosBp(g.gene.end)}
                    <span class="chroma-annotation-tooltip-span">
                      {' · '}{formatSpanBp(g.gene.end - g.gene.start)}
                    </span>
                  </div>
                  <Show when={g.gene.id !== g.gene.name}>
                    <div class="chroma-annotation-tooltip-id">{g.gene.id}</div>
                  </Show>
                </>
              );
            })()}

            {h.kind === 'variant' && (() => {
              const vh = h as HoveredVariant;
              const v = vh.variant;
              return (
                <>
                  <div class="chroma-annotation-tooltip-name">
                    <span
                      class="chroma-annotation-tooltip-variant-swatch"
                      style={{ background: VARIANT_KIND_COLOR[v.type] }}
                      aria-hidden="true"
                    />
                    {v.ref || '·'}
                    <span class="chroma-annotation-tooltip-arrow">→</span>
                    {v.alt || '·'}
                    <span class="chroma-annotation-tooltip-variant-kind">{v.type.toUpperCase()}</span>
                  </div>
                  <div class="chroma-annotation-tooltip-coords">
                    {viewport().chrom}:{formatPosBp(v.pos + 1n)}
                    <Show when={Number.isFinite(v.qual) && v.qual > 0}>
                      <span class="chroma-annotation-tooltip-span">
                        {' · QUAL '}{v.qual.toFixed(1)}
                      </span>
                    </Show>
                  </div>
                </>
              );
            })()}

            {/* WHERE + WHY — pinned only. */}
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
                <For each={h.kind === 'gene' ? geneWhyLines(h as HoveredGene) : variantWhyLines(h as HoveredVariant)}>
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
