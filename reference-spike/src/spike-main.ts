/**
 * Spike main — orchestrates the demo.
 *
 * Concerns kept SEPARATE to mirror production architecture:
 *   - data: mock generator (would be worker in product)
 *   - state: bare module-level vars (would be Solid signals)
 *   - render: WebGL renderers (same as product)
 *   - ui: vanilla event listeners (would be Solid components)
 */

import {
  createGLContext,
} from './render/webgl/gl-context';
import {
  createPileupRenderer,
  type ReadTile,
} from './render/tracks-render/bam-pileup';
import {
  createCoverageRenderer,
} from './render/tracks-render/bam-coverage';
import {
  generateMockReads,
  generateMockCoverage,
} from './mock-data';
import {
  type Viewport,
  pxToGenomic,
  basePixelWidth,
} from './render/coord';
import type { CoverageTile } from './render/tracks-render/bam-coverage';

// ───── State ──────────────────────────────────────────────

const REGION_START_BP = 1_000_000;
const REGION_LENGTH_BP = 1_000_000; // 1Mb test region

let viewport: Viewport = {
  chrom: 'chr20',
  start: BigInt(REGION_START_BP),
  end: BigInt(REGION_START_BP + REGION_LENGTH_BP),
  pxWidth: 0,
  pxHeight: 0,
};

let readCount = 100_000;
let mode: 'pileup' | 'coverage' = 'pileup';
let reads: ReadTile;
let coverage: CoverageTile;

// ───── Setup ──────────────────────────────────────────────

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const ctx = createGLContext({ canvas });
const pileupRenderer = createPileupRenderer(ctx.gl, 6);
const coverageRenderer = createCoverageRenderer(ctx.gl);

function regenerateData() {
  reads = generateMockReads({
    count: readCount,
    regionStartBp: REGION_START_BP,
    regionLengthBp: REGION_LENGTH_BP,
  });
  coverage = generateMockCoverage(reads, REGION_START_BP, REGION_LENGTH_BP, 200);
}
regenerateData();

function syncViewportSize() {
  const rect = canvas.getBoundingClientRect();
  viewport = {
    ...viewport,
    pxWidth: rect.width,
    pxHeight: rect.height,
  };
}
syncViewportSize();

window.addEventListener('resize', () => {
  ctx.resize();
  syncViewportSize();
  dirty = true;
});

// ───── Render loop ────────────────────────────────────────

let dirty = true;
let frameCount = 0;
let fpsAccum = 0;
let fpsLastT = performance.now();
let lastFrameT = performance.now();

function tick() {
  const now = performance.now();
  const dt = now - lastFrameT;
  lastFrameT = now;

  frameCount++;
  fpsAccum += dt;
  if (fpsAccum >= 500) {
    const fps = Math.round((frameCount * 1000) / fpsAccum);
    const fpsEl = document.getElementById('fps')!;
    fpsEl.textContent = String(fps);
    fpsEl.className = 'v ' + (fps >= 55 ? 'ok' : fps >= 30 ? 'warn' : 'bad');
    document.getElementById('frameMs')!.textContent = (fpsAccum / frameCount).toFixed(1);
    frameCount = 0;
    fpsAccum = 0;
  }

  if (dirty || draggingState.active || true /* always draw to measure fps under pan */) {
    const t0 = performance.now();
    render();
    const drawMs = performance.now() - t0;
    document.getElementById('drawMs')!.textContent = drawMs.toFixed(1);
    dirty = false;
  }

  requestAnimationFrame(tick);
}

function render() {
  const gl = ctx.gl;
  // Background
  gl.clearColor(0.039, 0.039, 0.043, 1); // #0a0a0b
  gl.clear(gl.COLOR_BUFFER_BIT);

  if (mode === 'pileup') {
    pileupRenderer.draw(reads, viewport, 0);
    const s = pileupRenderer.stats();
    document.getElementById('readCount')!.textContent = s.readCount.toLocaleString();
    document.getElementById('rows')!.textContent = String(s.rowsUsed);
  } else {
    coverageRenderer.draw(
      coverage,
      viewport,
      0,
      viewport.pxHeight,
      [0.58, 0.65, 0.72], // --cov-fill in linear-ish RGB
    );
    document.getElementById('readCount')!.textContent =
      coverage.binCount.toLocaleString() + ' bins';
    document.getElementById('rows')!.textContent = '—';
  }

  // Locus readout
  const locusEl = document.getElementById('locus')!;
  const start = viewport.start.toLocaleString();
  const end = viewport.end.toLocaleString();
  const span = (Number(viewport.end - viewport.start)).toLocaleString();
  locusEl.textContent = `${viewport.chrom}:${start}-${end}  (${span} bp · ${basePixelWidth(viewport).toFixed(3)} px/bp)`;
}

requestAnimationFrame(tick);

// ───── Interaction ────────────────────────────────────────

const stage = document.getElementById('stage')!;
const draggingState = {
  active: false,
  lastX: 0,
};

stage.addEventListener('mousedown', (e) => {
  draggingState.active = true;
  draggingState.lastX = e.clientX;
  stage.classList.add('dragging');
});
window.addEventListener('mouseup', () => {
  draggingState.active = false;
  stage.classList.remove('dragging');
});
window.addEventListener('mousemove', (e) => {
  if (!draggingState.active) return;
  const dx = e.clientX - draggingState.lastX;
  draggingState.lastX = e.clientX;
  const bpPerPx = Number(viewport.end - viewport.start) / viewport.pxWidth;
  const deltaBp = BigInt(Math.round(-dx * bpPerPx));
  viewport = {
    ...viewport,
    start: viewport.start + deltaBp,
    end: viewport.end + deltaBp,
  };
  dirty = true;
});

stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = stage.getBoundingClientRect();
  const anchorPx = e.clientX - rect.left;
  const anchorBp = pxToGenomic(anchorPx, viewport);
  const factor = e.deltaY > 0 ? 1.25 : 0.8;
  const newSpan = BigInt(Math.max(50, Math.round(Number(viewport.end - viewport.start) * factor)));
  // Keep anchor fixed
  const anchorRatio = (anchorPx / viewport.pxWidth);
  const newStart = anchorBp - BigInt(Math.round(Number(newSpan) * anchorRatio));
  viewport = {
    ...viewport,
    start: newStart,
    end: newStart + newSpan,
  };
  dirty = true;
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.key === '0') {
    viewport = {
      ...viewport,
      start: BigInt(REGION_START_BP),
      end: BigInt(REGION_START_BP + REGION_LENGTH_BP),
    };
    dirty = true;
  }
});

// ───── Controls ───────────────────────────────────────────

const countSel = document.getElementById('count') as HTMLSelectElement;
countSel.value = String(readCount);
countSel.addEventListener('change', () => {
  readCount = Number(countSel.value);
  regenerateData();
  dirty = true;
});

const modeSel = document.getElementById('mode') as HTMLSelectElement;
modeSel.addEventListener('change', () => {
  mode = modeSel.value as 'pileup' | 'coverage';
  dirty = true;
});

const benchBtn = document.getElementById('benchBtn') as HTMLButtonElement;
benchBtn.addEventListener('click', async () => {
  benchBtn.disabled = true;
  benchBtn.textContent = 'running…';
  const result = await runBench();
  console.table(result);
  benchBtn.disabled = false;
  benchBtn.textContent = 'run bench';
  alert(
    'Benchmark complete (see console for full table):\n\n' +
    result.map((r) => `${r.label}: ${r.fps} fps, draw ${r.drawMs}ms`).join('\n'),
  );
});

// ───── Benchmark ──────────────────────────────────────────

interface BenchResult {
  label: string;
  reads: number;
  mode: string;
  fps: number;
  drawMs: number;
  framesMeasured: number;
}

async function runBench(): Promise<BenchResult[]> {
  const scenarios = [
    { reads: 10_000, mode: 'pileup' as const, label: '10K pileup' },
    { reads: 100_000, mode: 'pileup' as const, label: '100K pileup' },
    { reads: 500_000, mode: 'pileup' as const, label: '500K pileup' },
    { reads: 1_000_000, mode: 'pileup' as const, label: '1M pileup' },
    { reads: 100_000, mode: 'coverage' as const, label: '100K coverage' },
  ];
  const results: BenchResult[] = [];
  for (const s of scenarios) {
    readCount = s.reads;
    mode = s.mode;
    regenerateData();
    // Warmup
    for (let i = 0; i < 30; i++) {
      render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    // Measure: simulate panning by shifting viewport each frame
    const DURATION_MS = 2000;
    const startT = performance.now();
    let frames = 0;
    let drawAccum = 0;
    while (performance.now() - startT < DURATION_MS) {
      const t0 = performance.now();
      // Pan 5000bp per frame
      viewport = {
        ...viewport,
        start: viewport.start + 5000n,
        end: viewport.end + 5000n,
      };
      render();
      drawAccum += performance.now() - t0;
      frames++;
      await new Promise((r) => requestAnimationFrame(r));
    }
    const elapsed = performance.now() - startT;
    results.push({
      label: s.label,
      reads: s.reads,
      mode: s.mode,
      fps: Math.round((frames * 1000) / elapsed),
      drawMs: +(drawAccum / frames).toFixed(2),
      framesMeasured: frames,
    });
  }
  // Restore
  countSel.value = String(readCount);
  modeSel.value = mode;
  return results;
}
