import { Show, createMemo, onCleanup, onMount } from 'solid-js';
import { setViewport } from '~state/viewport';
import { tracks } from '~state/tracks';
import { tileCache } from '~state/tile-cache';
import { createRenderScheduler, type RenderScheduler } from '~render/scheduler';

/**
 * GenomeView — mounts the WebGL canvas, owns the render scheduler, and
 * publishes the canvas's pixel size back to the viewport signal so coord
 * math stays accurate after resize.
 *
 * T2.D.7: while any tile for a visible track is pending, a CSS-only
 * shimmer overlay sits on top of the canvas (no JS animation loop). The
 * detailed per-track status strip moved to TrackPanel.
 */

export function GenomeView() {
  let canvasRef: HTMLCanvasElement | undefined;
  let scheduler: RenderScheduler | undefined;

  onMount(() => {
    if (!canvasRef) return;
    scheduler = createRenderScheduler(canvasRef);

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      setViewport((v) => ({ ...v, pxWidth: w, pxHeight: h }));
      scheduler?.invalidate();
    });
    ro.observe(canvasRef);

    onCleanup(() => {
      ro.disconnect();
      scheduler?.dispose();
      scheduler = undefined;
    });
  });

  // True iff at least one tile keyed for a visible track is in `pending`.
  // Tile keys are `${trackId}:${chrom}:${binSize}:${binIndex}` — we only
  // need the prefix to attribute pendingness, which keeps this cheap.
  const isLoading = createMemo(() => {
    const visibleIds = new Set(tracks().filter((t) => t.visible).map((t) => t.id));
    if (visibleIds.size === 0) return false;
    for (const [key, status] of tileCache()) {
      if (status.state !== 'pending') continue;
      const colon = key.indexOf(':');
      if (colon <= 0) continue;
      if (visibleIds.has(key.slice(0, colon))) return true;
    }
    return false;
  });

  return (
    <div class="chroma-genome-view">
      <canvas ref={canvasRef} class="chroma-canvas" />
      <Show when={isLoading()}>
        <div
          class="chroma-canvas-skeleton"
          aria-hidden="true"
          data-testid="canvas-skeleton"
        />
      </Show>
    </div>
  );
}
