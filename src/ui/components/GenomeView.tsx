import { Show, createMemo, onCleanup, onMount } from 'solid-js';
import { setViewport, viewport } from '~state/viewport';
import { tracks } from '~state/tracks';
import { tileCache } from '~state/tile-cache';
import { contextRange } from '~state/context-range';
import { panBpWithin } from '~state/viewport-actions';
import { createRenderScheduler, type RenderScheduler } from '~render/scheduler';

/**
 * GenomeView — mounts the WebGL canvas, owns the render scheduler, and
 * publishes the canvas's pixel size back to the viewport signal so coord
 * math stays accurate after resize.
 *
 * T2.D.7: while any tile for a visible track is pending, a CSS-only
 * shimmer overlay sits on top of the canvas (no JS animation loop). The
 * detailed per-track status strip moved to TrackPanel.
 *
 * Shift+wheel: horizontal pan proportional to deltaY, clamped to the
 * current contextRange. Plain wheel passes through to the browser so
 * page scroll / track-panel scroll still work.
 */

/**
 * Multiplier that turns wheel deltaY into a fraction of the visible
 * viewport span. Empirically: a single notch on a typical mouse is
 * deltaY ≈ 100, which we map to ~10 % of the viewport — fast enough to
 * sweep across a 10 kb window in a couple of notches without being
 * janky for fine-grained trackpads.
 */
const WHEEL_PAN_FACTOR = 0.001;

export function GenomeView() {
  let canvasRef: HTMLCanvasElement | undefined;
  let scheduler: RenderScheduler | undefined;

  function handleWheel(e: WheelEvent): void {
    if (!e.shiftKey) return; // plain wheel → browser default
    e.preventDefault();
    const v = viewport();
    const r = contextRange();
    if (v.chrom !== r.chrom) return;
    const span = v.end - v.start;
    const spanNum = Number(span);
    if (!Number.isFinite(spanNum) || spanNum <= 0) return;
    const deltaBp = BigInt(Math.round(spanNum * e.deltaY * WHEEL_PAN_FACTOR));
    if (deltaBp === 0n) return;
    setViewport((prev) => panBpWithin(prev, deltaBp, r));
  }

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

    // `wheel` needs `passive: false` for preventDefault() to take effect.
    // Solid's JSX onWheel binds as passive on some platforms, so attach
    // imperatively.
    canvasRef.addEventListener('wheel', handleWheel, { passive: false });

    onCleanup(() => {
      ro.disconnect();
      canvasRef?.removeEventListener('wheel', handleWheel);
      scheduler?.dispose();
      scheduler = undefined;
    });
  });

  // True iff at least one tile keyed for a visible track is in `pending`.
  // Tile keys are `${trackId}:${chrom}:${binSize}:${tileWidthBp}:${tileIndex}`
  // — we only need the prefix to attribute pendingness, which keeps this cheap.
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
