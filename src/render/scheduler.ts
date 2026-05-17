/**
 * Render scheduler — RAF loop driven by L3 viewport + tileCache signals.
 *
 * After the M1 debt repayment: the data source is the L3 `tileCache`
 * snapshot, not a side-channel signal. For each visible track:
 *   - scan the cache for ready tiles matching trackId + chrom + binSize +
 *     viewport overlap
 *   - dispatch to the renderer matching tile.payload:
 *       reads     → PileupRenderer
 *       coverage  → CoverageRenderer
 *       signal    → BigWigRenderer (M2 prep)
 *       reference → ReferenceRenderer (M2 prep)
 *       variants  → not yet wired (T2.E.2 owns it)
 *
 * Per-kind binSize policy comes from `~data/track-engine`. The scheduler
 * filters tiles by the policy's current binSize so stale tiles from a
 * different zoom band don't blend with the freshly-fetched ones.
 *
 * Multi-tile composition: per-renderer draw is called once per tile. Pileup
 * row collisions across tile boundaries are accepted in M1+M2-prep — the
 * drawMerged path is a carry-forward.
 */

import { createEffect, onCleanup } from 'solid-js';
import { tracks } from '~state/tracks';
import { tileCache } from '~state/tile-cache';
import { viewport } from '~state/viewport';
import { hoveredAnnotation } from '~state/hover';
import { policyFor, type TilePolicy } from '~data/tile-policy';
import { createGLContext, type GLContext } from '~render/webgl';
import {
  TOP_PAD_PX,
  TRACK_GAP_PX,
  TRACK_HEIGHT,
  bandHeightFor,
} from '~render/track-layout';
import {
  createPileupRenderer,
  createCoverageRenderer,
  createBigWigRenderer,
  createReferenceRenderer,
  createGeneRenderer,
  maxAcrossTiles,
  maxAcrossSignalTiles,
  type PileupRenderer,
  type CoverageRenderer,
  type BigWigRenderer,
  type ReferenceRenderer,
  type GeneRenderer,
} from '~render/tracks-render';
import { drawGeneLabels } from '~render/labels/gene-labels';
import type {
  CoverageTile,
  GeneTile,
  ReadTile,
  ReferenceTile,
  SignalTile,
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

export interface RenderSchedulerOverlays {
  /** Canvas2D overlay receiving annotation labels (gene names, etc.).
   *  `null` disables the labels pass entirely — useful for tests where
   *  no second canvas is mounted. */
  labels: HTMLCanvasElement | null;
}

/** Label colour. Hardcoded to --ink-primary for now; theme-reactive
 *  resolution is a follow-up. */
const LABEL_FILL_STYLE = '#18181b';
/** Hover highlight stroke colour. --accent #2563eb at full alpha. */
const HOVER_STROKE_STYLE = '#2563eb';
const HOVER_STROKE_WIDTH_PX = 1.5;

// ── Colors from DESIGN_SYSTEM §2.2 ────────────────────────────────────────
const COVERAGE_FILL: readonly [number, number, number] = [0.581, 0.643, 0.722]; // --cov-fill #94a3b8
const BIGWIG_FILL: readonly [number, number, number] = [0.400, 0.600, 0.800];   // --strand-forward #6699cc

function tileOverlapsViewport(tile: Tile, v: Viewport): boolean {
  return tile.chrom === v.chrom && tile.end > v.start && tile.start < v.end;
}

function absBig(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/**
 * Pick the tiles the renderer should draw for this track this frame.
 *
 * Stale-while-revalidate: while a pan / zoom is in flight, the OLD tiles
 * stay on screen until the matching new tile arrives. Without this, every
 * sub-tile pan in vp mode (BAM pileup) would blank the band for the
 * fetch round-trip — visible as flicker.
 *
 * Strategy:
 *   1. Collect tiles that overlap the current viewport on the same chrom.
 *   2. Partition into `exact` (matches current policy precisely) and
 *      `stale` (different binSize OR tileWidthBp, but the data is still
 *      valid genomic content for the visible region).
 *   3. If we have anything exact, return only exact — never mix.
 *   4. Otherwise return a bounded stale subset so the band keeps showing
 *      data until the new fetch resolves.
 *
 * Bound on the stale fallback keeps cross-zoom transitions from
 * dumping hundreds of finer-binSize tiles into one frame.
 */
const MAX_STALE_TILES = 4;

function collectTilesForTrack(
  snapshot: ReadonlyMap<TileKey, TileStatus>,
  trackId: string,
  v: Viewport,
  policy: TilePolicy,
): Tile[] {
  const exact: Tile[] = [];
  const stale: Tile[] = [];

  for (const status of snapshot.values()) {
    if (status.state !== 'ready') continue;
    const tile = status.tile;
    if (tile.trackId !== trackId) continue;
    if (!tileOverlapsViewport(tile, v)) continue;

    if (policy.vp) {
      // vp: single tile per viewport. Exact = same span AND same start;
      // stale = same span, different start (typical: pan by a few px
      // before the new fetch lands).
      if (Number(tile.end - tile.start) !== policy.tileWidthBp) {
        stale.push(tile);
        continue;
      }
      if (tile.start === v.start && tile.end === v.end) {
        exact.push(tile);
      } else {
        stale.push(tile);
      }
    } else {
      // Tile-binning. Exact = same binSize and tileWidthBp; stale =
      // anything else (different zoom level cached from before this jump).
      if (
        tile.binSize === policy.binSize &&
        Number(tile.end - tile.start) === policy.tileWidthBp
      ) {
        exact.push(tile);
      } else {
        stale.push(tile);
      }
    }
  }

  if (exact.length > 0) return exact;

  if (stale.length === 0) return stale;

  if (policy.vp) {
    // For vp, pick the single closest-start tile so we draw only one band
    // of stale reads (drawing two stale tiles overlapping at the same Y
    // would double-stamp the same reads at different X offsets).
    stale.sort((a, b) =>
      Number(absBig(a.start - v.start) - absBig(b.start - v.start)),
    );
    return stale.slice(0, 1);
  }

  // Coverage / signal / reference / gene: cap the stale fan-out and prefer
  // tiles whose midpoint is closest to the viewport midpoint.
  if (stale.length > MAX_STALE_TILES) {
    const vMid = (v.start + v.end) / 2n;
    stale.sort((a, b) => {
      const am = (a.start + a.end) / 2n;
      const bm = (b.start + b.end) / 2n;
      return Number(absBig(am - vMid) - absBig(bm - vMid));
    });
    return stale.slice(0, MAX_STALE_TILES);
  }
  return stale;
}

/** Test-only re-export. Not part of the runtime public surface; the
 *  scheduler keeps the function private. */
export const _collectTilesForTrack = collectTilesForTrack;

export function createRenderScheduler(
  canvas: HTMLCanvasElement,
  overlays: RenderSchedulerOverlays = { labels: null },
): RenderScheduler {
  const ctx: GLContext = createGLContext({ canvas });
  const labelCanvas = overlays.labels;
  const labelCtx = labelCanvas ? labelCanvas.getContext('2d') : null;
  const pileupRenderers = new Map<string, PileupRenderer>();
  const coverageRenderers = new Map<string, CoverageRenderer>();
  const bigwigRenderers = new Map<string, BigWigRenderer>();
  const referenceRenderers = new Map<string, ReferenceRenderer>();
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

  const ensureBigWig = (trackId: string): BigWigRenderer => {
    let r = bigwigRenderers.get(trackId);
    if (!r) {
      r = createBigWigRenderer(ctx.gl);
      bigwigRenderers.set(trackId, r);
    }
    return r;
  };

  const ensureReference = (trackId: string): ReferenceRenderer => {
    let r = referenceRenderers.get(trackId);
    if (!r) {
      r = createReferenceRenderer(ctx.gl);
      referenceRenderers.set(trackId, r);
    }
    return r;
  };

  const geneRenderers = new Map<string, GeneRenderer>();
  const ensureGene = (trackId: string): GeneRenderer => {
    let r = geneRenderers.get(trackId);
    if (!r) {
      r = createGeneRenderer(ctx.gl);
      geneRenderers.set(trackId, r);
    }
    return r;
  };

  const drawTrack = (
    track: TrackConfig,
    snapshot: ReadonlyMap<TileKey, TileStatus>,
    v: Viewport,
    yTopPx: number,
  ): void => {
    const span = Number(v.end - v.start);
    const policy = policyFor(track.kind, span);
    if (policy === null) return;

    const trackTiles = collectTilesForTrack(snapshot, track.id, v, policy);
    if (trackTiles.length === 0) return;

    // Partition by payload — one band may carry only one payload type given
    // the per-(track, viewport) binSize policy, but defensive splitting is
    // cheap and keeps the renderer-state changes ordered.
    const reads: ReadTile[] = [];
    const coverages: CoverageTile[] = [];
    const signals: SignalTile[] = [];
    const references: ReferenceTile[] = [];
    const genes: GeneTile[] = [];
    for (const tile of trackTiles) {
      if (tile.payload === 'reads') reads.push(tile);
      else if (tile.payload === 'coverage') coverages.push(tile);
      else if (tile.payload === 'signal') signals.push(tile);
      else if (tile.payload === 'reference') references.push(tile);
      else if (tile.payload === 'gene') genes.push(tile);
    }

    const bandHeight = bandHeightFor(track.kind, policy);

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
        renderer.draw(coverages[i]!, v, yTopPx, bandHeight, max, COVERAGE_FILL);
      }
    }
    if (signals.length > 0) {
      const renderer = ensureBigWig(track.id);
      const max = maxAcrossSignalTiles(signals);
      for (let i = 0; i < signals.length; i++) {
        renderer.draw(signals[i]!, v, yTopPx, bandHeight, max, BIGWIG_FILL);
      }
    }
    if (references.length > 0) {
      const renderer = ensureReference(track.id);
      for (let i = 0; i < references.length; i++) {
        renderer.draw(references[i]!, v, yTopPx, bandHeight);
      }
    }
    if (genes.length > 0) {
      const renderer = ensureGene(track.id);
      for (let i = 0; i < genes.length; i++) {
        renderer.draw(genes[i]!, v, yTopPx, bandHeight);
      }
    }
  };

  /** Resize the labels canvas to match the WebGL canvas's logical pixels
   *  and reset its 2D transform to (dpr, 0, 0, dpr, 0, 0). The WebGL canvas
   *  already does this in its own `ctx.resize()`; we mirror the math here
   *  so the two stay perfectly co-located. */
  const syncLabelsCanvas = (cssW: number, cssH: number): boolean => {
    if (!labelCanvas || !labelCtx) return false;
    const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
    const needW = Math.max(1, Math.round(cssW * dpr));
    const needH = Math.max(1, Math.round(cssH * dpr));
    if (labelCanvas.width !== needW) labelCanvas.width = needW;
    if (labelCanvas.height !== needH) labelCanvas.height = needH;
    if (labelCanvas.style.width !== `${cssW}px`) labelCanvas.style.width = `${cssW}px`;
    if (labelCanvas.style.height !== `${cssH}px`) labelCanvas.style.height = `${cssH}px`;
    labelCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    labelCtx.clearRect(0, 0, cssW, cssH);
    return true;
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
    const span = Number(v.end - v.start);

    const haveLabels = syncLabelsCanvas(v.pxWidth, v.pxHeight);

    let yOffsetPx = TOP_PAD_PX;
    for (const track of trackList) {
      if (!track.visible) continue;
      drawTrack(track, snapshot, v, yOffsetPx);

      const policy = policyFor(track.kind, span);

      // Label pass — currently only the gene track has labels. The Canvas2D
      // overlay sits above the WebGL canvas in the DOM, so labels paint on
      // top of the geometry naturally.
      if (haveLabels && labelCtx && track.kind === 'gene' && policy) {
        const bandHeight = bandHeightFor(track.kind, policy);
        const trackTiles = collectTilesForTrack(snapshot, track.id, v, policy);
        for (const tile of trackTiles) {
          if (tile.payload !== 'gene') continue;
          drawGeneLabels({
            ctx2d: labelCtx,
            tile,
            viewport: v,
            yTopPx: yOffsetPx,
            bandHeightPx: bandHeight,
            fillStyle: LABEL_FILL_STYLE,
          });
        }
      }

      // Advance by the actual rendered height of this band — must match what
      // drawTrack picks via bandHeightFor(), or tracks below would overlap.
      const height = policy ? bandHeightFor(track.kind, policy) : TRACK_HEIGHT[track.kind];
      yOffsetPx += height + TRACK_GAP_PX;
    }

    // Hover highlight — one global hovered feature; drawn last so it sits
    // above both the WebGL geometry and the gene-name labels.
    if (haveLabels && labelCtx) {
      const hover = hoveredAnnotation();
      if (hover) {
        const r = hover.rectPx;
        labelCtx.save();
        labelCtx.strokeStyle = HOVER_STROKE_STYLE;
        labelCtx.lineWidth = HOVER_STROKE_WIDTH_PX;
        // 0.5-px offset aligns the 1.5-px stroke to the pixel grid.
        labelCtx.strokeRect(r.left + 0.5, r.top + 0.5, Math.max(1, r.width - 1), Math.max(1, r.height - 1));
        labelCtx.restore();
      }
    }

    lastMs = performance.now() - t0;
  };

  createEffect(() => {
    viewport();
    tileCache();
    tracks();
    hoveredAnnotation();
    dirty = true;
  });

  const unsubLost = ctx.onLost(() => {
    for (const r of pileupRenderers.values()) try { r.dispose(); } catch { /* ignore */ }
    for (const r of coverageRenderers.values()) try { r.dispose(); } catch { /* ignore */ }
    for (const r of bigwigRenderers.values()) try { r.dispose(); } catch { /* ignore */ }
    for (const r of referenceRenderers.values()) try { r.dispose(); } catch { /* ignore */ }
    for (const r of geneRenderers.values()) try { r.dispose(); } catch { /* ignore */ }
    pileupRenderers.clear();
    coverageRenderers.clear();
    bigwigRenderers.clear();
    referenceRenderers.clear();
    geneRenderers.clear();
    dirty = true;
  });

  frame = requestAnimationFrame(drawFrame);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    unsubLost();
    for (const r of pileupRenderers.values()) try { r.dispose(); } catch { /* ignore */ }
    for (const r of coverageRenderers.values()) try { r.dispose(); } catch { /* ignore */ }
    for (const r of bigwigRenderers.values()) try { r.dispose(); } catch { /* ignore */ }
    for (const r of referenceRenderers.values()) try { r.dispose(); } catch { /* ignore */ }
    for (const r of geneRenderers.values()) try { r.dispose(); } catch { /* ignore */ }
    pileupRenderers.clear();
    coverageRenderers.clear();
    bigwigRenderers.clear();
    referenceRenderers.clear();
    geneRenderers.clear();
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
