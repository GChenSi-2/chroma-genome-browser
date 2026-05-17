/**
 * Annotation selection state — two coexisting signals:
 *
 *   `hoveredAnnotation`  Transient. Tracks pointer-move. Cleared on
 *                        pointer-leave. Drives the live tooltip + outline.
 *   `pinnedAnnotation`   Sticky. Set by click. Cleared by Esc / click on
 *                        empty canvas / explicit close button.
 *
 * The tooltip prefers `pinned` over `hovered` so a user who clicked a
 * gene can pan / zoom freely without losing the inspector pane.
 *
 * The hit-test runs on pointer events in `GenomeView` and writes here;
 * downstream UI / render layers stay decoupled from event timing.
 */

import { createSignal } from 'solid-js';
import type { GeneFeature } from './types';

export interface HoveredAnnotation {
  /** Owning track. Disambiguates if multiple gene tracks ever overlap. */
  trackId: string;
  /** The hit feature (could be a gene, transcript, or exon). */
  feature: GeneFeature;
  /** The gene this feature belongs to, walked up via parentId.
   *  Same as `feature` when `feature.type === 'gene'`. */
  gene: GeneFeature;
  /** Pixel rect of the hit feature in CSS px, relative to the canvas. */
  rectPx: { left: number; top: number; width: number; height: number };
}

const [hovered, setHovered] = createSignal<HoveredAnnotation | null>(null);
const [pinned, setPinned] = createSignal<HoveredAnnotation | null>(null);

export {
  hovered as hoveredAnnotation,
  setHovered as setHoveredAnnotation,
  pinned as pinnedAnnotation,
  setPinned as setPinnedAnnotation,
};

