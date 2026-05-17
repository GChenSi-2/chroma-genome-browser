/**
 * Annotation selection state — two coexisting signals:
 *
 *   `hoveredAnnotation`  Transient. Tracks pointer-move. Cleared on
 *                        pointer-leave. Drives the live tooltip + outline.
 *   `pinnedAnnotation`   Sticky. Set by click. Cleared by Esc / click on
 *                        empty canvas / explicit close button.
 *
 * The tooltip prefers `pinned` over `hovered` so a user who clicked a
 * gene / variant can pan / zoom freely without losing the inspector.
 *
 * The hit-test runs on pointer events in `GenomeView` and writes here;
 * downstream UI / render layers stay decoupled from event timing.
 */

import { createSignal } from 'solid-js';
import type { GeneFeature } from './types';

export type VariantKind = 'snv' | 'ins' | 'del' | 'mnv' | 'sv';

/** Compact summary of a VCF variant, hit-test friendly. Mirrors the SoA
 *  encoding in `VariantTile` but resolved + typed for UI consumption. */
export interface VariantSummary {
  /** 0-based genomic position. */
  pos: bigint;
  ref: string;
  alt: string;
  qual: number;
  type: VariantKind;
}

interface BaseHovered {
  /** Owning track. Disambiguates if multiple tracks ever overlap. */
  trackId: string;
  /** Pixel rect in CSS px, relative to the canvas, of the hit thing. */
  rectPx: { left: number; top: number; width: number; height: number };
}

export interface HoveredGene extends BaseHovered {
  kind: 'gene';
  /** The hit feature (could be a gene, transcript, or exon). */
  feature: GeneFeature;
  /** The gene this feature belongs to, walked up via parentId.
   *  Same as `feature` when `feature.type === 'gene'`. */
  gene: GeneFeature;
}

export interface HoveredVariant extends BaseHovered {
  kind: 'variant';
  variant: VariantSummary;
}

export type HoveredItem = HoveredGene | HoveredVariant;

/** @deprecated Use `HoveredItem`. Kept as alias for back-compat in
 *  unit tests that already assert on the gene shape. */
export type HoveredAnnotation = HoveredGene;

const [hovered, setHovered] = createSignal<HoveredItem | null>(null);
const [pinned, setPinned] = createSignal<HoveredItem | null>(null);

export {
  hovered as hoveredAnnotation,
  setHovered as setHoveredAnnotation,
  pinned as pinnedAnnotation,
  setPinned as setPinnedAnnotation,
};

