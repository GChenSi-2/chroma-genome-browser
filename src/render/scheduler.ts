/**
 * Render scheduler — RAF loop driven by L3 viewport + tileCache signals.
 *
 * After the M1 debt repayment: the data source is the L3 `tileCache`
 * snapshot, not a side-channel signal. For each visible BAM track:
 *   - scan the cache for ready tiles matching trackId + chrom + viewport
 *     overlap
 *   - dispatch to PileupRenderer (ReadTile payload) or CoverageRenderer
 *     (CoverageTile payload). Mixed payloads on the same track in one
 *     frame are skipped silently — the policy guarantees a single binSize
 *     per (track, viewport), so all tiles for one track share one payload
 *     type.
 *
 * Multi-tile composition: each tile is drawn into the same vertical band
 * with the renderer's `draw` called once per tile. Pileup row collisions
 * across tile boundaries are accepted in M1 (M2 main merges).
 */

import { createEffect, onCleanup } from 'solid-js';
import { tracks } from '~state/tracks';
import { tileCache } from '~state/tile-cache';
import { viewport } from '~state/viewport';
import { bamBinSizeForSpan } from '~data/track-engine';
import { createGLContext, type GLContext } from '~render/webgl';
import {
  createPileupRenderer,
  createCoverageRenderer,
  maxAcrossTiles,
  type PileupRenderer,
  type CoverageRenderer,
} from '~render/tracks-render';
import type {
  BinSize,
  CoverageTile,
  ReadTile,
  TileKey,
  TileStatus,
  Tile,
  Viewport,
  TrackConfig,
} from '~state/types';

export interface RenderScheduler {
  invalidate(): void;
  lastFrameMs(): number;
  dispose(): void;
}

const TRACK_HEIGHT_PX = 200;
const TRACK_GAP_PX = 8;
const TOP_PAD_PX = 16;

const COVERAGE_FILL: readonly [number, number, number] = [0.581, 0.643, 0.722]; // --cov-fill #94a3b8

function tileOverlapsViewport(tile: Tile, v: Viewport): boolean {
  return tile.chrom === v.chrom && tile.end > v.start && tile.start < v.end;
}

function collectTilesForTrack(
  snapshot: ReadonlyMap<TileKey, TileStatus>,
  trackId: string,
  v: Viewport,
  expectedBinSize: BinSize,
): Tile[] {
  const out: Tile[] = [];
  for (const status of snapshot.values()) {
    if (status.state !== 'ready') continue;
    const tile = status.tile;
    if (tile.trackId !== trackId) continue;
    // Filter to the policy-chosen binSize for the current viewport so we
    // don't mix stale pileup tiles with fresh coverage tiles across zoom.
    if (tile.binSize !== expectedBinSize) continue;
    if (!tileOverlapsViewport(tile, v)) continue;
    out.push(tile);
  }
  return out;
}

export function createRenderScheduler(canvas: HTMLCanvasElement): RenderScheduler {
  const ctx: GLContext = createGLContext({ canvas });
  const pileupRenderers = new Map<string, PileupRenderer>();
  const coverageRenderers = new Map<string, CoverageRenderer>();
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

  const ensureCoverage = (trackId: string): CoverageRenderer => {
    let r = coverageRenderers.get(trackId);
    if (!r) {
      r = createCoverageRenderer(ctx.gl);
      coverageRenderers.set(trackId, r);
    }
    return r;
  };

  const drawTrack = (
    track: TrackConfig,
    snapshot: ReadonlyMap<TileKey, TileStatus>,
    v: Viewport,
    yTopPx: number,
    expectedBinSize: BinSize,
  ): void => {
    if (track.kind !== 'bam') return;
    const trackTiles = collectTilesForTrack(snapshot, track.id, v, expectedBinSize);
    if (trackTiles.length === 0) return;

    // Sort by payload so we don't shuffle GL state across types in one band.
    const reads: ReadTile[] = [];
    const coverages: CoverageTile[] = [];
    for (const tile of trackTiles) {
      if (tile.payload === 'reads') reads.push(tile);
      else if (tile.payload === 'coverage') coverages.push(tile);
    }

    if (reads.length > 0) {
      const renderer = ensurePileup(track.id);
      for (let i = 0; i < reads.length; i++) {
        renderer.draw(reads[i]!, v, yTopPx);
      }
    }
    if (coverages.length > 0) {
      const renderer = ensureCoverage(track.id);
      const max = maxAcrossTiles(coverages);
      for (let i = 0; i < coverages.length; i++) {
        renderer.draw(coverages[i]!, v, yTopPx, TRACK_HEIGHT_PX, max, COVERAGE_FILL);
      }
    }
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
    const snapshot = tileCache();
    const trackList = tracks();
    const expectedBinSize = bamBinSizeForSpan(Number(v.end - v.start));

    let yOffsetPx = TOP_PAD_PX;
    for (const track of trackList) {
      if (!track.visible) continue;
      drawTrack(track, snapshot, v, yOffsetPx, expectedBinSize);
      yOffsetPx += TRACK_HEIGHT_PX + TRACK_GAP_PX;
    }

    lastMs = performance.now() - t0;
  };

  // Re-render on any input change.
  createEffect(() => {
    viewport();
    tileCache();
    tracks();
    dirty = true;
  });

  const unsubLost = ctx.onLost(() => {
    for (const r of pileupRenderers.values()) {
      try {
        r.dispose();
      } catch {
        /* ignore */
      }
    }
    pileupRenderers.clear();
    for (const r of coverageRenderers.values()) {
      try {
        r.dispose();
      } catch {
        /* ignore */
      }
    }
    coverageRenderers.clear();
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
    for (const r of coverageRenderers.values()) {
      try {
        r.dispose();
      } catch {
        /* ignore */
      }
    }
    coverageRenderers.clear();
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
