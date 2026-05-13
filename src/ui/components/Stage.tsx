import { viewport } from '~state/viewport';
import { basePixelWidth, semanticLevel } from '~state/derived';
import { formatLocus } from '~state/locus-parser';

/**
 * Stage — Day 1 placeholder for the genome view.
 *
 * Renders a signal-driven HTML band showing the current locus + zoom level,
 * plus an inline reminder of the keyboard shortcuts. Real WebGL canvas mount
 * comes in T2.D.2; this is purely an empty-state replacement so the keyboard
 * shortcuts have something visible to react against.
 *
 * Ownership: agent-ui (L4). Reads L3 signals only. No DOM beyond JSX.
 */
export function Stage() {
  return (
    <div class="chroma-stage-debug">
      <div class="chroma-locus-readout">
        <span class="chroma-locus-readout-label">{formatLocus(viewport())}</span>
        <span class="chroma-locus-readout-meta">
          bpw {basePixelWidth().toExponential(2)} · {semanticLevel()}
        </span>
      </div>
      <div class="chroma-stage-placeholder">
        Stage placeholder — pan with <kbd>h</kbd>/<kbd>l</kbd>, zoom with{' '}
        <kbd>+</kbd>/<kbd>-</kbd>, jump with <kbd>g</kbd>
      </div>
    </div>
  );
}
