import { createSignal } from 'solid-js';
import type { Viewport } from './types';

/**
 * Viewport signal — L3 state, ARCHITECTURE §4.1.
 *
 * Ownership:
 *   ✏ agent-ui (signal + setters)
 *   👀 agent-render (read-only, drives shader uniforms)
 *   👀 agent-data (read-only, drives tile prefetch)
 *
 * The default value is chr1:0-1Mb at 1200×600 — gets overwritten by either
 * the URL hash on load (`src/state/url-sync.ts`) or the demo-dataset picker.
 */
export const DEFAULT_VIEWPORT: Viewport = {
  chrom: 'chr1',
  start: 0n,
  end: 1_000_000n,
  pxWidth: 1200,
  pxHeight: 600,
};

const [viewport, setViewport] = createSignal<Viewport>(DEFAULT_VIEWPORT, {
  // Viewport mutations must be detected by reference; we always replace the
  // whole object to keep accidental shared-state aliasing out.
  equals: (a, b) =>
    a.chrom === b.chrom &&
    a.start === b.start &&
    a.end === b.end &&
    a.pxWidth === b.pxWidth &&
    a.pxHeight === b.pxHeight,
});

export { viewport, setViewport };
