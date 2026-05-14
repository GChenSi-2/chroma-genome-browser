import { onCleanup, onMount } from 'solid-js';
import { setViewport } from '~state/viewport';
import { trackResults } from '~data/track-engine';
import { tracks } from '~state/tracks';
import { createRenderScheduler, type RenderScheduler } from '~render/scheduler';

/**
 * GenomeView — mounts the WebGL canvas, owns the render scheduler, and
 * publishes the canvas's pixel size back to the viewport signal so coord
 * math stays accurate after resize.
 *
 * The status strip below the canvas surfaces per-track loading/error state
 * so we can debug the worker pool plumbing without opening devtools.
 * Replaced by proper TrackPanel + chrome in T2.D.1+.
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

  return (
    <div class="chroma-genome-view">
      <canvas ref={canvasRef} class="chroma-canvas" />
      <div class="chroma-track-status">
        {tracks().map((t) => {
          const status = trackResults().get(t.id);
          const label =
            !status || status.state === 'idle'
              ? 'idle'
              : status.state === 'loading'
                ? 'loading…'
                : status.state === 'ready'
                  ? `${status.tile.payload === 'reads' ? `${status.tile.count} reads` : 'coverage'}`
                  : `error: ${status.message}`;
          return (
            <div class="chroma-track-status-row">
              <span class="chroma-track-status-label">{t.label}</span>
              <span class="chroma-track-status-state" data-state={status?.state ?? 'idle'}>
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
