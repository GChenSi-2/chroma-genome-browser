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
import { policyFor, type TilePolicy } from '~data/tile-policy';
import { createGLContext, type GLContext } from '~render/webgl';
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
  TrackKind,
} from '~state/types';

export interface RenderScheduler {
  invalidate(): void;
  lastFrameMs(): number;
  dispose(): void;
}

// ── Per-kind layout — DESIGN_SYSTEM §5 track heights ──────────────────────
const TRACK_HEIGHT: Record<TrackKind, number> = {
  reference: 20,
  bam: 200, // pileup default; coverage tier shrinks via bandHeightFor() below
  bigwig: 80,
  vcf: 28,
  gene: 90, // gene + multi-transcript stacks; ~5 rows of 18 px each
  bed: 32,
};
/** BAM band height when the policy returns a coverage-tier binSize. */
const BAM_COVERAGE_HEIGHT_PX = 60;
const TRACK_GAP_PX = 8;
const TOP_PAD_PX = 16;

/**
 * Resolve the rendered band height for `(kind, policy)`. For BAM we shrink
 * the band from 200 → 60 once the policy crosses into coverage tier (binSize
 * >= 8192 → CoverageTile path) so a thin histogram doesn't fill the same
 * vertical space as a dense pileup. DESIGN_SYSTEM §5 spec'd coverage = 60
 * and pileup = 80–400 adaptive; we use a fixed 200 for pileup for now.
 */
function bandHeightFor(kind: TrackKind, policy: TilePolicy): number {
  if (kind === 'bam') {
    return policy.binSize >= 8192 ? BAM_COVERAGE_HEIGHT_PX : TRACK_HEIGHT.bam;
  }
  return TRACK_HEIGHT[kind];
}

// ── Colors from DESIGN_SYSTEM §2.2 ────────────────────────────────────────
const COVERAGE_FILL: readonly [number, number, number] = [0.581, 0.643, 0.722]; // --cov-fill #94a3b8
const BIGWIG_FILL: readonly [number, number, number] = [0.400, 0.600, 0.800];   // --strand-forward #6699cc

function tileOverlapsViewport(tile: Tile, v: Viewport): boolean {
  return tile.chrom === v.chrom && tile.end > v.start && tile.start < v.end;
}

function collectTilesForTrack(
  snapshot: ReadonlyMap<TileKey, TileStatus>,
  trackId: string,
  v: Viewport,
  policy: TilePolicy,
): Tile[] {
  const out: Tile[] = [];
  for (const status of snapshot.values()) {
    if (status.state !== 'ready') continue;
    const tile = status.tile;
    if (tile.trackId !== trackId) continue;
    if (tile.binSize !== policy.binSize) continue;
    // Tile width is implicit in end-start; reject tiles minted under a
    // different tile-width policy (otherwise stale tiles from a different
    // zoom band would bleed into the current frame).
    if (Number(tile.end - tile.start) !== policy.tileWidthBp) continue;
    if (!tileOverlapsViewport(tile, v)) continue;
    out.push(tile);
  }
  return out;
}

export function createRenderScheduler(canvas: HTMLCanvasElement): RenderScheduler {
  const ctx: GLContext = createGLContext({ canvas });
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

    let yOffsetPx = TOP_PAD_PX;
    for (const track of trackList) {
      if (!track.visible) continue;
      drawTrack(track, snapshot, v, yOffsetPx);
      // Advance by the actual rendered height of this band — must match what
      // drawTrack picks via bandHeightFor(), or tracks below would overlap.
      const policy = policyFor(track.kind, span);
      const height = policy ? bandHeightFor(track.kind, policy) : TRACK_HEIGHT[track.kind];
      yOffsetPx += height + TRACK_GAP_PX;
    }

    lastMs = performance.now() - t0;
  };

  createEffect(() => {
    viewport();
    tileCache();
    tracks();
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
