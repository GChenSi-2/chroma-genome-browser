/**
 * Hovered annotation — the feature currently under the pointer in the
 * genome view. Tooltip and the scheduler's hover-highlight pass both
 * subscribe to this signal. Null when nothing is hovered.
 *
 * The hit-test runs on pointer-move in `GenomeView` and writes here;
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

export { hovered as hoveredAnnotation, setHovered as setHoveredAnnotation };
