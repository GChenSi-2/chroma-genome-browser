/**
 * Render scheduler — RAF loop that draws the current viewport using whatever
 * tile data the track engine has placed in the `trackResults` signal.
 *
 * Subscribes to viewport + trackResults via createEffect; any mutation
 * flips a `dirty` flag and the RAF cycle redraws on the next frame.
 *
 * Per-track renderers are lazily created and cached. The scheduler does not
 * compose multiple track types into one frame yet — only BAM pileup; coverage
 * + bigwig + reference renderers land in M2.
 */

import { createEffect, onCleanup } from 'solid-js';
import { trackResults } from '~data/track-engine';
import { tracks } from '~state/tracks';
import { viewport } from '~state/viewport';
import { createGLContext, type GLContext } from '~render/webgl';
import {
  createPileupRenderer,
  type PileupRenderer,
} from '~render/tracks-render';

export interface RenderScheduler {
  /** Force a redraw on the next frame (e.g. after canvas resize). */
  invalidate(): void;
  /** Latest frame timing in ms (0 if no frame drawn yet). */
  lastFrameMs(): number;
  dispose(): void;
}

const TRACK_HEIGHT_PX = 200;
const TRACK_GAP_PX = 8;

export function createRenderScheduler(canvas: HTMLCanvasElement): RenderScheduler {
  const ctx: GLContext = createGLContext({ canvas });
  const pileupRenderers = new Map<string, PileupRenderer>();
  let dirty = true;
  let frame = 0;
  let lastMs = 0;
  let disposed = false;

  const ensurePileup = (trackId: string): PileupRenderer => {
    let r = pileupRenderers.get(trackId);
    if (!r) {
      r = createPileupRenderer(ctx.gl, { rowHeightPx: 4, maxRows: 200 });
      pileupRenderers.set(trackId, r);
    }
    return r;
  };

  const drawFrame = (): void => {
    frame = requestAnimationFrame(drawFrame);
    if (disposed) return;
    if (!dirty) return;
    dirty = false;

    const t0 = performance.now();
    ctx.resize();
    const gl = ctx.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const v = viewport();
    const data = trackResults();
    const trackList = tracks();

    let yOffsetPx = 16;
    for (const track of trackList) {
      if (!track.visible) continue;
      if (track.kind !== 'bam') continue;
      const status = data.get(track.id);
      if (!status || status.state !== 'ready') {
        yOffsetPx += TRACK_HEIGHT_PX + TRACK_GAP_PX;
        continue;
      }
      const tile = status.tile;
      if (tile.payload !== 'reads') {
        yOffsetPx += TRACK_HEIGHT_PX + TRACK_GAP_PX;
        continue;
      }
      ensurePileup(track.id).draw(tile, v, yOffsetPx);
      yOffsetPx += TRACK_HEIGHT_PX + TRACK_GAP_PX;
    }

    lastMs = performance.now() - t0;
  };

  // Subscribe to inputs; any change flips dirty.
  createEffect(() => {
    viewport();
    trackResults();
    tracks();
    dirty = true;
  });

  // GL context lost — re-acquire renderers next frame.
  const unsubLost = ctx.onLost(() => {
    for (const r of pileupRenderers.values()) {
      try {
        r.dispose();
      } catch {
        /* ignore */
      }
    }
    pileupRenderers.clear();
    dirty = true;
  });

  frame = requestAnimationFrame(drawFrame);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    unsubLost();
    for (const r of pileupRenderers.values()) {
      try {
        r.dispose();
      } catch {
        /* ignore */
      }
    }
    pileupRenderers.clear();
    ctx.dispose();
  };

  onCleanup(dispose);

  return {
    invalidate(): void {
      dirty = true;
    },
    lastFrameMs(): number {
      return lastMs;
    },
    dispose,
  };
}
