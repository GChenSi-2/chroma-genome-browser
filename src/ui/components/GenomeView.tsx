import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { setViewport, viewport } from '~state/viewport';
import { tracks } from '~state/tracks';
import { tileCache } from '~state/tile-cache';
import { contextRange } from '~state/context-range';
import { panBpWithin } from '~state/viewport-actions';
import { setHoveredAnnotation, setPinnedAnnotation, type HoveredItem } from '~state/hover';
import { createRenderScheduler, type RenderScheduler } from '~render/scheduler';
import { hitTestGene } from '~render/hit-test/gene-hit-test';
import { hitTestVariant } from '~render/hit-test/variant-hit-test';
import { AnnotationTooltip } from './AnnotationTooltip';

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
/** Defer the skeleton overlay until loading has been continuously true for
 *  this long. Sub-200 ms loading blips (e.g. crossing a tile boundary on a
 *  fast pan) shouldn't flash the shimmer — the stale-while-revalidate
 *  rendering already covers the visual gap. */
const SKELETON_DEBOUNCE_MS = 200;
/** Pixel-movement budget below which a pointerdown→pointerup pair counts
 *  as a click (for click-to-pin); above, it's a drag and the pin is
 *  preserved as-is. Matches the threshold the range-bar interaction
 *  composable uses. */
const CLICK_DRAG_PX = 4;

export function GenomeView() {
  let canvasRef: HTMLCanvasElement | undefined;
  let labelCanvasRef: HTMLCanvasElement | undefined;
  let scheduler: RenderScheduler | undefined;

  function hitTestAt(px: number, py: number): HoveredItem | null {
    const v = viewport();
    const ts = tracks();
    const tc = tileCache();
    // Variant ticks live in their own band; if the pointer is on that
    // band, the gene hit-test would return null anyway. Order doesn't
    // matter for correctness — pick variant first as a perf nudge
    // because its tile partition is cheaper.
    const variantHit = hitTestVariant({ px, py }, v, ts, tc);
    if (variantHit) return variantHit;
    const geneHit = hitTestGene({ px, py }, v, ts, tc);
    return geneHit;
  }

  function handlePointerMove(e: PointerEvent): void {
    if (!canvasRef) return;
    const rect = canvasRef.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    setHoveredAnnotation(hitTestAt(px, py));
  }

  function handlePointerLeave(): void {
    setHoveredAnnotation(null);
  }

  // Click-to-pin state machine: a pointerdown remembers the starting
  // coords; pointerup with movement <= CLICK_DRAG_PX is treated as a
  // click and pins (or clears) the inspector. Drags pass through.
  let pointerDownX = 0;
  let pointerDownY = 0;
  let pointerDownActive = false;

  function handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return; // primary only
    pointerDownX = e.clientX;
    pointerDownY = e.clientY;
    pointerDownActive = true;
  }

  function handlePointerUp(e: PointerEvent): void {
    if (!pointerDownActive) return;
    pointerDownActive = false;
    const dx = Math.abs(e.clientX - pointerDownX);
    const dy = Math.abs(e.clientY - pointerDownY);
    if (dx + dy > CLICK_DRAG_PX) return; // it was a drag, don't change pin

    // Hit-test at the release point — use the same logic as hover.
    if (!canvasRef) return;
    const rect = canvasRef.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    // Hit something → pin it. Empty canvas → clear any existing pin.
    setPinnedAnnotation(hitTestAt(px, py));
  }

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
    scheduler = createRenderScheduler(canvasRef, { labels: labelCanvasRef ?? null });

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
    canvasRef.addEventListener('pointermove', handlePointerMove);
    canvasRef.addEventListener('pointerleave', handlePointerLeave);
    canvasRef.addEventListener('pointerdown', handlePointerDown);
    canvasRef.addEventListener('pointerup', handlePointerUp);

    onCleanup(() => {
      ro.disconnect();
      canvasRef?.removeEventListener('wheel', handleWheel);
      canvasRef?.removeEventListener('pointermove', handlePointerMove);
      canvasRef?.removeEventListener('pointerleave', handlePointerLeave);
      canvasRef?.removeEventListener('pointerdown', handlePointerDown);
      canvasRef?.removeEventListener('pointerup', handlePointerUp);
      setHoveredAnnotation(null);
      setPinnedAnnotation(null);
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

  // Debounced skeleton visibility. We only show the shimmer when loading
  // has been continuously true for SKELETON_DEBOUNCE_MS. Pan-induced
  // sub-200 ms blips don't flash the overlay; long fetches still do.
  const [showSkeleton, setShowSkeleton] = createSignal(false);
  let skeletonTimer: ReturnType<typeof setTimeout> | null = null;
  createEffect(() => {
    const loading = isLoading();
    if (loading) {
      if (skeletonTimer === null && !showSkeleton()) {
        skeletonTimer = setTimeout(() => {
          skeletonTimer = null;
          setShowSkeleton(true);
        }, SKELETON_DEBOUNCE_MS);
      }
    } else {
      if (skeletonTimer !== null) {
        clearTimeout(skeletonTimer);
        skeletonTimer = null;
      }
      if (showSkeleton()) setShowSkeleton(false);
    }
  });
  onCleanup(() => {
    if (skeletonTimer !== null) {
      clearTimeout(skeletonTimer);
      skeletonTimer = null;
    }
  });

  return (
    <div class="chroma-genome-view">
      <canvas ref={canvasRef} class="chroma-canvas" />
      <canvas
        ref={(el) => { labelCanvasRef = el; }}
        class="chroma-canvas chroma-canvas-labels"
        aria-hidden="true"
      />
      <Show when={showSkeleton()}>
        <div
          class="chroma-canvas-skeleton"
          aria-hidden="true"
          data-testid="canvas-skeleton"
        />
      </Show>
      <AnnotationTooltip />
    </div>
  );
}
