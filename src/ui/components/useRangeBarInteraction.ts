/**
 * Headless interaction state machine for the range-bar pair.
 *
 * Encapsulates the drag-create / drag-move / drag-resize / Esc-cancel /
 * click-to-jump state shared by `ChromosomeOverviewBar` (coarse, full-chrom
 * domain, no edge resize) and `RangeSelectionBar` (fine, local-context
 * domain, full edit). Each bar component owns its own DOM + selection-rect
 * geometry; this composable owns the pointer event grammar.
 *
 * Pattern: headless-UI (TanStack Table / Radix UI). Behaviour is reusable
 * without imposing a particular visual treatment.
 */

import { createSignal, onCleanup, onMount, type Accessor } from 'solid-js';
import type { Locus } from '~state/types';
import { setViewport, viewport } from '~state/viewport';
import {
  panBpWithin,
  resizeViewportEdge,
  setViewportSpan,
} from '~state/viewport-actions';
import { fractionToContext } from '~render/coord';

/** Hit-test threshold for resize handles, in CSS px. */
const EDGE_PX = 6;
/** Pointer movement at-or-below this CSS-px total counts as a click. */
const CLICK_DRAG_PX = 4;

export type DragMode = 'create' | 'move' | 'resize-start' | 'resize-end';
export type HoverZone = 'edge-start' | 'edge-end' | 'inside' | 'outside';

interface DragState {
  mode: DragMode;
  /** Pixel-x of pointerdown, relative to the bar's left edge. */
  anchorPx: number;
  /** Viewport at drag start (drags pan against this snapshot). */
  initialStart: bigint;
  initialEnd: bigint;
  pointerId: number;
  /** Total CSS-px movement since pointerdown. Decides click-vs-drag. */
  movedPx: number;
  /** Last move pixel-x — used to compute incremental movedPx. */
  lastPx: number;
  /** Whether `committed` viewport changes have been applied since pointerdown.
   *  Flips from false → true the first time movement crosses CLICK_DRAG_PX
   *  (or immediately, when `primeOnDown` is true and mode === 'create'). */
  committed: boolean;
}

export interface RangeBarOpts {
  /** Reactive domain the bar visualises. */
  domain: Accessor<Locus>;
  /** Element-relative bar rect; `null` while unmounted or during teardown. */
  getBarRect: () => DOMRect | null;
  /** Rendered selection edges in pixels for hit-testing. `null` when the
   *  selection is off-chrom or the bar isn't measurable. */
  visibleEdgesPx: (rect: DOMRect) => { leftPx: number; rightPx: number } | null;
  /** Capture pointer on this element so drags survive a cursor leaving. */
  setPointerCapture: (pointerId: number) => void;
  releasePointerCapture: (pointerId: number) => void;
  /** Allow grab-edge to start a resize drag (false for the overview bar). */
  enableResize: boolean;
  /** Pointerup at <= CLICK_DRAG_PX total movement re-centres the viewport
   *  on the click position, span preserved (true for the overview only). */
  enableClickToJump: boolean;
  /** Apply the create-prime viewport snap on pointerdown (true for local —
   *  immediate visual feedback; false for overview — wait for real drag). */
  primeOnDown: boolean;
}

export interface RangeBarInteraction {
  handlers: {
    onPointerDown: (e: PointerEvent) => void;
    onPointerMove: (e: PointerEvent) => void;
    onPointerUp: (e: PointerEvent) => void;
    onPointerCancel: (e: PointerEvent) => void;
    onPointerLeave: () => void;
  };
  cursor: Accessor<string>;
  isDragging: Accessor<boolean>;
}

/** Project pixel x to a bar-relative fraction in [0, 1]. */
function pxToFrac(px: number, rect: DOMRect): number {
  if (rect.width <= 0) return 0;
  const f = px / rect.width;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

function hoverZoneAt(
  px: number,
  leftPx: number,
  rightPx: number,
  enableResize: boolean,
): HoverZone {
  const width = rightPx - leftPx;
  // Edge zones collapse on narrow rects so the whole rect reads as `inside`,
  // matching the existing local-bar behaviour.
  const supportsEdges = enableResize && width >= EDGE_PX * 3;
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

export function useRangeBarInteraction(opts: RangeBarOpts): RangeBarInteraction {
  const [drag, setDrag] = createSignal<DragState | null>(null);
  const [hover, setHover] = createSignal<HoverZone>('outside');

  function cancelDrag(): void {
    const d = drag();
    if (!d) return;
    // Esc semantics: revert the viewport to the pre-drag snapshot so the
    // user never gets surprised by a partial drag landing.
    setViewport((prev) => ({ ...prev, start: d.initialStart, end: d.initialEnd }));
    setDrag(null);
  }

  function handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const rect = opts.getBarRect();
    if (!rect) return;

    const px = e.clientX - rect.left;
    const visible = opts.visibleEdgesPx(rect);
    const v = viewport();

    let mode: DragMode;
    if (visible) {
      const zone = hoverZoneAt(px, visible.leftPx, visible.rightPx, opts.enableResize);
      if (zone === 'edge-start') mode = 'resize-start';
      else if (zone === 'edge-end') mode = 'resize-end';
      else if (zone === 'inside') mode = 'move';
      else mode = 'create';
    } else {
      mode = 'create';
    }

    const state: DragState = {
      mode,
      anchorPx: px,
      initialStart: v.start,
      initialEnd: v.end,
      pointerId: e.pointerId,
      movedPx: 0,
      lastPx: px,
      committed: false,
    };

    // primeOnDown: snap the viewport to a zero-width selection at the click
    // so the user sees the drag-create rectangle growing immediately. We
    // skip this when click-to-jump is active — otherwise a single click
    // would destroy the existing viewport span before we can decide whether
    // the user meant click or drag.
    if (mode === 'create' && opts.primeOnDown) {
      const pos = fractionToContext(pxToFrac(px, rect), opts.domain());
      setViewport((prev) => setViewportSpan(prev, pos, pos, opts.domain()));
      state.committed = true;
    }

    setDrag(state);
    try {
      opts.setPointerCapture(e.pointerId);
    } catch {
      /* ignore — test harnesses without setPointerCapture */
    }
    e.preventDefault();
  }

  function handlePointerMove(e: PointerEvent): void {
    const rect = opts.getBarRect();
    if (!rect) return;
    const px = e.clientX - rect.left;
    const d = drag();

    if (!d) {
      // Hover-only path: update cursor zone.
      const visible = opts.visibleEdgesPx(rect);
      setHover(
        visible
          ? hoverZoneAt(px, visible.leftPx, visible.rightPx, opts.enableResize)
          : 'outside',
      );
      return;
    }

    const delta = Math.abs(px - d.lastPx);
    const movedPx = d.movedPx + delta;
    setDrag({ ...d, movedPx, lastPx: px });

    // Defer real action until the pointer leaves the click deadband — keeps
    // click-to-jump (release at <= 4 px) from accidentally redefining the
    // viewport.
    const passedDeadband = movedPx > CLICK_DRAG_PX;
    if (!passedDeadband && !d.committed) return;

    const dom = opts.domain();

    if (d.mode === 'create') {
      const a = fractionToContext(pxToFrac(d.anchorPx, rect), dom);
      const b = fractionToContext(pxToFrac(px, rect), dom);
      setViewport((prev) => setViewportSpan(prev, a, b, dom));
      setDrag({ ...d, movedPx, lastPx: px, committed: true });
      return;
    }

    if (d.mode === 'move') {
      const deltaFrac = (px - d.anchorPx) / rect.width;
      const rangeSpan = Number(dom.end - dom.start);
      const deltaBp = BigInt(Math.round(rangeSpan * deltaFrac));
      // Pan from the SNAPSHOT (not whatever clamping nudged us to last frame)
      // so the move stays linear.
      setViewport((prev) =>
        panBpWithin(
          { ...prev, start: d.initialStart, end: d.initialEnd },
          deltaBp,
          dom,
        ),
      );
      setDrag({ ...d, movedPx, lastPx: px, committed: true });
      return;
    }

    if (d.mode === 'resize-start' || d.mode === 'resize-end') {
      const side: 'start' | 'end' = d.mode === 'resize-start' ? 'start' : 'end';
      const newPos = fractionToContext(pxToFrac(px, rect), dom);
      setViewport((prev) => resizeViewportEdge(prev, side, newPos, dom));
      setDrag({ ...d, movedPx, lastPx: px, committed: true });
    }
  }

  function endDrag(e: PointerEvent): void {
    const d = drag();
    if (!d) return;
    const rect = opts.getBarRect();

    // Click-to-jump: no real drag happened. Re-centre the viewport on the
    // click position, preserving span — IGV-style "telegraph" navigation.
    if (
      opts.enableClickToJump &&
      !d.committed &&
      d.movedPx <= CLICK_DRAG_PX &&
      rect
    ) {
      const dom = opts.domain();
      const clickPos = fractionToContext(pxToFrac(d.anchorPx, rect), dom);
      const v = viewport();
      const currentCenter = (v.start + v.end) / 2n;
      const deltaBp = clickPos - currentCenter;
      setViewport((prev) => panBpWithin(prev, deltaBp, dom));
    }

    setDrag(null);
    try {
      opts.releasePointerCapture(d.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();
  }

  function handlePointerLeave(): void {
    if (drag()) return; // keep cursor state stable while actively dragging
    setHover('outside');
  }

  // Esc cancellation: wired at the document level so the user can mash Esc
  // anywhere on the page while mid-drag (matches the original behaviour).
  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && drag()) cancelDrag();
  }
  onMount(() => {
    document.addEventListener('keydown', handleKeyDown);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', handleKeyDown);
  });

  return {
    handlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onPointerLeave: handlePointerLeave,
    },
    cursor: () => cursorFor(hover(), drag() !== null),
    isDragging: () => drag() !== null,
  };
}
