import { onCleanup, onMount } from 'solid-js';
import { setViewport } from '~state/viewport';
import { tracks } from '~state/tracks';
import { tileCache } from '~state/tile-cache';
import type { TileKey, TileStatus, TrackConfig } from '~state/types';
import { createRenderScheduler, type RenderScheduler } from '~render/scheduler';

/**
 * GenomeView — mounts the WebGL canvas, owns the render scheduler, and
 * publishes the canvas's pixel size back to the viewport signal so coord
 * math stays accurate after resize.
 *
 * The status strip below the canvas derives per-track aggregate status
 * from the L3 `tileCache` snapshot (M1 debt repayment — no longer a side
 * channel from track-engine). Replaced by proper TrackPanel in T2.D.2.
 */

type AggregateState = 'idle' | 'loading' | 'ready' | 'error';

interface TrackSummary {
  state: AggregateState;
  /** Total tiles seen for this track in the current snapshot. */
  total: number;
  /** Ready tiles. */
  ready: number;
  /** Total ready-reads count (for ReadTile payload). */
  reads: number;
  /** Total coverage bins (for CoverageTile payload). */
  bins: number;
  errorMessage: string | null;
}

function summarize(
  trackId: string,
  snapshot: ReadonlyMap<TileKey, TileStatus>,
): TrackSummary {
  let total = 0;
  let ready = 0;
  let pending = 0;
  let error = 0;
  let reads = 0;
  let bins = 0;
  let errorMessage: string | null = null;

  for (const status of snapshot.values()) {
    if (status.state === 'ready') {
      if (status.tile.trackId !== trackId) continue;
      total++;
      ready++;
      if (status.tile.payload === 'reads') {
        reads += status.tile.count;
      } else if (status.tile.payload === 'coverage') {
        bins += status.tile.values.length;
      }
    } else {
      // pending / error don't carry a trackId we can scope by; count them
      // generously when at least one ready tile exists for this track. For
      // initial paint where no ready tile exists, we cannot attribute
      // pending entries to a specific track from the snapshot alone, so we
      // accept a small reporting gap. Track-engine writes the trackId-aware
      // key in put(), and parseTileKey can recover it.
      // (Resolved via key parsing below.)
    }
  }

  // Walk again for pending/error attribution via tile key prefix.
  for (const [key, status] of snapshot) {
    if (status.state === 'ready') continue;
    const colon = key.indexOf(':');
    const keyTrackId = colon > 0 ? key.slice(0, colon) : '';
    if (keyTrackId !== trackId) continue;
    total++;
    if (status.state === 'pending') pending++;
    else {
      error++;
      if (!errorMessage) errorMessage = status.message;
    }
  }

  let state: AggregateState = 'idle';
  if (total === 0) state = 'idle';
  else if (pending > 0) state = 'loading';
  else if (error > 0 && ready === 0) state = 'error';
  else state = 'ready';

  return { state, total, ready, reads, bins, errorMessage };
}

function statusLabel(t: TrackConfig, s: TrackSummary): string {
  if (s.state === 'idle') return 'idle';
  if (s.state === 'loading') return `loading ${s.ready}/${s.total} tiles…`;
  if (s.state === 'error') return `error: ${s.errorMessage ?? 'unknown'}`;
  if (t.kind === 'bam') {
    return s.reads > 0 ? `${s.reads} reads · ${s.total} tile${s.total === 1 ? '' : 's'}` : `${s.bins} bins · ${s.total} tile${s.total === 1 ? '' : 's'}`;
  }
  return `${s.total} tile${s.total === 1 ? '' : 's'}`;
}

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
          const summary = summarize(t.id, tileCache());
          return (
            <div class="chroma-track-status-row">
              <span class="chroma-track-status-label">{t.label}</span>
              <span
                class="chroma-track-status-state"
                data-state={summary.state}
              >
                {statusLabel(t, summary)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
