/**
 * Headless benchmark — run with vitest or in browser via playwright.
 *
 * Measures the 5 gate scenarios from BENCHMARKS.md.
 *
 * Note: requires WebGL2 context. In node, use `@vitest/web-worker` +
 * `jsdom` + `gl` package (headless WebGL). Or run in playwright browser.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createGLContext } from '../../src/render/webgl/gl-context';
import { createPileupRenderer } from '../../src/render/tracks-render/bam-pileup';
import { generateMockReads } from '../../src/mock-data';
import type { Viewport } from '../../src/render/coord';

// These tests only run in a browser environment (vitest with playwright provider
// or browser harness). Skip if no WebGL2.
function hasWebGL2(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

describe.skipIf(!hasWebGL2())('Pileup render benchmarks', () => {
  let canvas: HTMLCanvasElement;
  let ctx: ReturnType<typeof createGLContext>;
  let renderer: ReturnType<typeof createPileupRenderer>;

  beforeAll(() => {
    canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 600;
    document.body.appendChild(canvas);
    ctx = createGLContext({ canvas, dpr: 1 });
    renderer = createPileupRenderer(ctx.gl, 6);
  });

  const SCENARIOS: Array<{
    name: string;
    count: number;
    targetFps: number;
    targetDrawMs: number;
  }> = [
    { name: '10K reads',  count: 10_000,    targetFps: 60, targetDrawMs: 3 },
    { name: '100K reads', count: 100_000,   targetFps: 60, targetDrawMs: 8 },
    { name: '500K reads', count: 500_000,   targetFps: 45, targetDrawMs: 15 },
    { name: '1M reads',   count: 1_000_000, targetFps: 30, targetDrawMs: 25 },
  ];

  for (const s of SCENARIOS) {
    it(`${s.name}: ≥ ${s.targetFps}fps, draw ≤ ${s.targetDrawMs}ms`, async () => {
      const reads = generateMockReads({
        count: s.count,
        regionStartBp: 1_000_000,
        regionLengthBp: 1_000_000,
      });
      const viewport: Viewport = {
        chrom: 'chr20',
        start: 1_000_000n,
        end: 2_000_000n,
        pxWidth: 1200,
        pxHeight: 600,
      };

      // Warmup
      for (let i = 0; i < 20; i++) renderer.draw(reads, viewport, 0);

      const DURATION_MS = 1500;
      const t0 = performance.now();
      let frames = 0;
      let drawAccum = 0;
      let curView = viewport;
      while (performance.now() - t0 < DURATION_MS) {
        const fT0 = performance.now();
        renderer.draw(reads, curView, 0);
        drawAccum += performance.now() - fT0;
        frames++;
        // Pan to force buffer reupload
        curView = {
          ...curView,
          start: curView.start + 5000n,
          end: curView.end + 5000n,
        };
        await new Promise((r) => setTimeout(r, 0));
      }
      const elapsed = performance.now() - t0;
      const fps = (frames * 1000) / elapsed;
      const avgDraw = drawAccum / frames;

      console.log(
        `[bench] ${s.name}: ${fps.toFixed(1)}fps, draw ${avgDraw.toFixed(2)}ms over ${frames} frames`,
      );

      expect(fps).toBeGreaterThanOrEqual(s.targetFps);
      expect(avgDraw).toBeLessThanOrEqual(s.targetDrawMs);
    });
  }
});
