import { createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { contextRange } from '~state/context-range';
import {
  panBpWithin,
  resizeViewportEdge,
  setViewportSpan,
} from '~state/viewport-actions';
import { setViewport, viewport } from '~state/viewport';
import { contextToFraction, fractionToContext } from '~render/coord';

/**
 * Top-level genomic range selector — a DAW-style overview bar that shows
 * where the current viewport sits inside the context range, with drag
 * affordances to create, move, or resize the selection.
 *
 * Layering:
 *   - State:   `viewport`, `contextRange` (~state/)
 *   - Coord:   `contextToFraction`, `fractionToContext` (~render/coord)
 *   - Actions: `setViewportSpan`, `panBpWithin`, `resizeViewportEdge`
 *              (~state/viewport-actions, pure functions; this component
 *              only orchestrates pointer events and dispatches)
 *   - UI:     this file — measurement, hit-testing, cursor state, render
 *
 * All numeric math goes through the coord helpers so domain ↔ pixel
 * conversion is testable in isolation from the DOM.
 */

const EDGE_PX = 6; // hit-test threshold for resize handles
const MIN_VISIBLE_PX = 3; // visual floor for the selection rectangle

type DragMode = 'create' | 'move' | 'resize-start' | 'resize-end';

interface DragState {
  mode: DragMode;
  /** Pixel-x of the original pointerdown, relative to the bar's left edge. */
  anchorPx: number;
  /** Viewport at drag start (used by move so deltas accumulate cleanly). */
  initialStart: bigint;
  initialEnd: bigint;
  pointerId: number;
}

type HoverZone = 'edge-start' | 'edge-end' | 'inside' | 'outside';

/**
 * Map a pointer pixel to a zone over the *visible* selection rectangle.
 * `leftPx` / `rightPx` should be the actually-rendered edges (after the
 * MIN_VISIBLE_PX floor in selectionStyle), not the raw viewport fractions —
 * otherwise on a sub-pixel-narrow selection the EDGE_PX threshold engulfs
 * the whole rect and every click registers as edge-start, never move.
 *
 * When the rendered width is too small to host two distinct edge zones
 * (< 3 × EDGE_PX), edges collapse and the whole rect is `inside` — the user
 * has to widen the selection (zoom out, or drag-create a bigger one) before
 * they can grab an edge.
 */
function hoverZoneAt(
  px: number,
  leftPx: number,
  rightPx: number,
): HoverZone {
  const width = rightPx - leftPx;
  const supportsEdges = width >= EDGE_PX * 3;
  if (supportsEdges) {
    if (Math.abs(px - leftPx) <= EDGE_PX) return 'edge-start';
    if (Math.abs(px - rightPx) <= EDGE_PX) return 'edge-end';
  }
  if (px >= leftPx && px <= rightPx) return 'inside';
  return 'outside';
}

function cursorFor(zone: HoverZone, dragging: boolean): string {
  if (dragging) {
    if (zone === 'edge-start' || zone === 'edge-end') return 'ew-resize';
    return 'grabbing';
  }
  if (zone === 'edge-start' || zone === 'edge-end') return 'ew-resize';
  if (zone === 'inside') return 'grab';
  return 'crosshair';
}

export function RangeSelectionBar() {
  let barRef: HTMLDivElement | undefined;
  const [drag, setDrag] = createSignal<DragState | null>(null);
  const [hover, setHover] = createSignal<HoverZone>('outside');

  /**
   * Pixel-coords of the selection rectangle, derived purely from viewport
   * + contextRange + measured bar width. Returns null when the viewport's
   * chromosome doesn't match the context (transient during chrom changes).
   */
  const selectionFraction = createMemo<{ left: number; right: number } | null>(() => {
    const r = contextRange();
    const v = viewport();
    if (v.chrom !== r.chrom) return null;
    return {
      left: contextToFraction(v.start, r),
      right: contextToFraction(v.end, r),
    };
  });

  function readBarRect(): DOMRect | null {
    return barRef?.getBoundingClientRect() ?? null;
  }

  function pxToFrac(px: number, rect: DOMRect): number {
    if (rect.width <= 0) return 0;
    const f = px / rect.width;
    return f < 0 ? 0 : f > 1 ? 1 : f;
  }

  /**
   * Returns the *rendered* selection edges in pixels, after the
   * MIN_VISIBLE_PX inflation that selectionStyle applies. Hit-test uses this
   * so the user can grab whatever they see, not invisible sub-pixel slivers.
   * Returns null when the viewport is off-chrom or the bar isn't measurable.
   */
  function visibleSelectionPx(rect: DOMRect): { leftPx: number; rightPx: number } | null {
    const sel = selectionFraction();
    if (!sel) return null;
    let leftPx = sel.left * rect.width;
    let rightPx = sel.right * rect.width;
    if (rightPx - leftPx < MIN_VISIBLE_PX) {
      const midPx = (leftPx + rightPx) / 2;
      leftPx = Math.max(0, midPx - MIN_VISIBLE_PX / 2);
      rightPx = Math.min(rect.width, midPx + MIN_VISIBLE_PX / 2);
    }
    return { leftPx, rightPx };
  }

  function handlePointerDown(e: PointerEvent): void {
    if (!barRef) return;
    if (e.button !== 0) return; // primary only
    const rect = readBarRect();
    if (!rect) return;

    const px = e.clientX - rect.left;
    const visible = visibleSelectionPx(rect);
    const r = contextRange();
    const v = viewport();

    let mode: DragMode;
    if (visible) {
      const zone = hoverZoneAt(px, visible.leftPx, visible.rightPx);
      if (zone === 'edge-start') mode = 'resize-start';
      else if (zone === 'edge-end') mode = 'resize-end';
      else if (zone === 'inside') mode = 'move';
      else mode = 'create';
    } else {
      mode = 'create';
    }

    setDrag({
      mode,
      anchorPx: px,
      initialStart: v.start,
      initialEnd: v.end,
      pointerId: e.pointerId,
    });
    try {
      barRef.setPointerCapture(e.pointerId);
    } catch {
      /* ignore — happens in some test harnesses */
    }

    // For drag-to-create, prime the viewport at the click position so the
    // user immediately sees a 1-row selection growing under their cursor.
    if (mode === 'create') {
      const pos = fractionToContext(pxToFrac(px, rect), r);
      setViewport((prev) => setViewportSpan(prev, pos, pos, r));
    }
    e.preventDefault();
  }

  function handlePointerMove(e: PointerEvent): void {
    if (!barRef) return;
    const rect = readBarRect();
    if (!rect) return;

    const px = e.clientX - rect.left;
    const d = drag();

    if (!d) {
      // Hover-only path — update cursor zone.
      const visible = visibleSelectionPx(rect);
      if (!visible) {
        setHover('outside');
        return;
      }
      setHover(hoverZoneAt(px, visible.leftPx, visible.rightPx));
      return;
    }

    const r = contextRange();

    if (d.mode === 'create') {
      const a = fractionToContext(pxToFrac(d.anchorPx, rect), r);
      const b = fractionToContext(pxToFrac(px, rect), r);
      setViewport((prev) => setViewportSpan(prev, a, b, r));
      return;
    }

    if (d.mode === 'move') {
      // Convert pixel delta to bp delta against the contextRange span.
      const deltaFrac = (px - d.anchorPx) / rect.width;
      const rangeSpan = Number(r.end - r.start);
      const deltaBp = BigInt(Math.round(rangeSpan * deltaFrac));
      // Pan from the SNAPSHOT taken at pointerdown so the move stays linear
      // even after clamping nudges the viewport along the way.
      setViewport((prev) =>
        panBpWithin(
          { ...prev, start: d.initialStart, end: d.initialEnd },
          deltaBp,
          r,
        ),
      );
      return;
    }

    if (d.mode === 'resize-start' || d.mode === 'resize-end') {
      const side: 'start' | 'end' = d.mode === 'resize-start' ? 'start' : 'end';
      const newPos = fractionToContext(pxToFrac(px, rect), r);
      setViewport((prev) => resizeViewportEdge(prev, side, newPos, r));
    }
  }

  function endDrag(e: PointerEvent): void {
    const d = drag();
    if (!d) return;
    setDrag(null);
    try {
      barRef?.releasePointerCapture(d.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();
  }

  function handlePointerLeave(): void {
    if (drag()) return; // stay engaged while actively dragging
    setHover('outside');
  }

  // Keyboard escape during drag — cancel and restore the snapshot.
  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && drag()) {
      const d = drag()!;
      setViewport((prev) => ({ ...prev, start: d.initialStart, end: d.initialEnd }));
      setDrag(null);
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeyDown);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', handleKeyDown);
  });

  const cursor = createMemo(() => cursorFor(hover(), drag() !== null));

  const selectionStyle = createMemo<Record<string, string> | null>(() => {
    const sel = selectionFraction();
    if (!sel) return null;
    const rect = readBarRect();
    const widthPx = rect?.width ?? 0;
    let leftFrac = sel.left;
    let rightFrac = sel.right;
    if (widthPx > 0) {
      // Floor the visible width so a 0-bp selection still has a 3-px sliver
      // (otherwise the user can't grab it back).
      const minFrac = MIN_VISIBLE_PX / widthPx;
      if (rightFrac - leftFrac < minFrac) {
        const mid = (leftFrac + rightFrac) / 2;
        leftFrac = Math.max(0, mid - minFrac / 2);
        rightFrac = Math.min(1, mid + minFrac / 2);
      }
    }
    return {
      left: `${leftFrac * 100}%`,
      width: `${(rightFrac - leftFrac) * 100}%`,
    };
  });

  return (
    <div
      class="chroma-range-bar"
      ref={barRef}
      style={{ cursor: cursor() }}
      role="slider"
      aria-label="Genomic range selector"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={handlePointerLeave}
    >
      <div class="chroma-range-bar-track" aria-hidden="true" />
      <Show when={selectionStyle()}>
        {(style) => (
          <div class="chroma-range-bar-selection" style={style()}>
            <div class="chroma-range-bar-edge chroma-range-bar-edge--start" />
            <div class="chroma-range-bar-edge chroma-range-bar-edge--end" />
          </div>
        )}
      </Show>
    </div>
  );
}
