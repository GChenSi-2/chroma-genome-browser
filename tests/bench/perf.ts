/**
 * Performance benchmarks — runs IN the live preview page (not vitest).
 *
 * Per HANDOFF §3 + BENCHMARKS §3, the gate scenarios need a real browser
 * with WebGL2, a real network round-trip to the demo data, and a real RAF
 * cadence. Vitest in happy-dom satisfies none of these. This module is
 * designed to be evaluated inside the dev page via the preview MCP eval
 * tool: it exposes pure functions that take signal accessors / setters and
 * report timings.
 *
 * Five gate scenarios (HANDOFF §3):
 *   B1: Initial render — `setViewport(locus)` → first all-ready snapshot.
 *       Target < 300ms. Includes BAI download on first call.
 *   B2: Pan @ 60fps — 5s of continuous viewport shifts, measure frame
 *       intervals. Target ≥ 60fps avg, ≥ 50fps p95.
 *   B3: Wheel zoom @ 60fps — 5s of alternating zoom-in/out steps.
 *       Target ≥ 60fps avg.
 *   B4: Gene search → render — search palette not yet wired (T2.D.5).
 *   B5: Peak memory — 10 tracks at 1Mb. Skipped until we have 10 tracks.
 *
 * Usage from preview_eval:
 *   ```
 *   const { runB1, runB2, runB3 } = await import('/tests/bench/perf.ts');
 *   const r1 = await runB1();
 *   ```
 *
 * Numbers reported are wall-clock; thermal noise calls for a 5-run median
 * (see BENCHMARKS §8). The driver script does that.
 */

import { setViewport, viewport } from '~state/viewport';
import { tileCache } from '~state/tile-cache';
import { tracks } from '~state/tracks';
import type { TileKey, TileStatus } from '~state/types';

function nextFrame(): Promise<number> {
  return new Promise((r) => requestAnimationFrame(r));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Returns when every visible track has at least one ready tile that
 * overlaps the current viewport, OR when the timeout elapses.
 */
async function waitForFirstReady(timeoutMs: number = 30_000): Promise<{ ok: boolean; elapsedMs: number }> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    const v = viewport();
    const snap = tileCache();
    const trackList = tracks();
    const visible = trackList.filter((t) => t.visible);
    if (visible.length === 0) {
      await sleep(50);
      continue;
    }
    const haveAll = visible.every((track) => {
      for (const status of snap.values()) {
        if (status.state !== 'ready') continue;
        const tile = status.tile;
        if (tile.trackId !== track.id) continue;
        if (tile.chrom !== v.chrom) continue;
        if (tile.end > v.start && tile.start < v.end) return true;
      }
      return false;
    });
    if (haveAll) return { ok: true, elapsedMs: performance.now() - t0 };
    await sleep(20);
  }
  return { ok: false, elapsedMs: performance.now() - t0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────────────────────

export interface B1Result {
  scenario: 'B1';
  /** Time from setViewport to first ready snapshot. */
  initialRenderMs: number;
  /** Whether ready was reached before timeout. */
  ok: boolean;
}

export interface FpsSamples {
  /** Frame interval samples in ms. */
  samples: number[];
  /** Computed: 1000 / mean(samples). */
  avgFps: number;
  /** Computed: 1000 / p95(samples). */
  p95Fps: number;
  /** Computed: 1000 / max(samples). */
  worstFps: number;
}

export interface B2Result extends FpsSamples {
  scenario: 'B2';
}
export interface B3Result extends FpsSamples {
  scenario: 'B3';
}

function summarize(samples: number[]): FpsSamples {
  if (samples.length === 0) {
    return { samples, avgFps: 0, p95Fps: 0, worstFps: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
  const p95idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p95 = sorted[p95idx]!;
  const worst = sorted[sorted.length - 1]!;
  return {
    samples,
    avgFps: 1000 / mean,
    p95Fps: 1000 / p95,
    worstFps: 1000 / worst,
  };
}

/** B1 — set the locus, wait for first all-ready snapshot. */
export async function runB1(
  target: { chrom: string; start: bigint; end: bigint } = {
    chrom: 'chr20',
    start: 10_000_000n,
    end: 11_000_000n, // 1Mb region per HANDOFF §3
  },
): Promise<B1Result> {
  setViewport((v) => ({ ...v, ...target }));
  const t0 = performance.now();
  const r = await waitForFirstReady(30_000);
  return {
    scenario: 'B1',
    initialRenderMs: performance.now() - t0,
    ok: r.ok,
  };
}

/** B2 — 5s of continuous pan, sample frame intervals. */
export async function runB2(durationMs: number = 5000, stepBp: bigint = 5000n): Promise<B2Result> {
  const samples: number[] = [];
  let lastT = await nextFrame();
  const start = lastT;
  while (performance.now() - start < durationMs) {
    const now = await nextFrame();
    samples.push(now - lastT);
    lastT = now;
    setViewport((v) => ({ ...v, start: v.start + stepBp, end: v.end + stepBp }));
  }
  return { scenario: 'B2', ...summarize(samples) };
}

/** B3 — 5s of alternating zoom-in/out, sample frame intervals. */
export async function runB3(durationMs: number = 5000): Promise<B3Result> {
  const samples: number[] = [];
  let lastT = await nextFrame();
  const start = lastT;
  let direction = 1;
  let stepCount = 0;
  while (performance.now() - start < durationMs) {
    const now = await nextFrame();
    samples.push(now - lastT);
    lastT = now;

    // Zoom factor 1.25^direction per step. Flip every 10 frames to avoid
    // running off the bp range.
    const factor = direction > 0 ? 0.8 : 1.25;
    setViewport((v) => {
      const span = v.end - v.start;
      const mid = v.start + span / 2n;
      const newSpan = BigInt(Math.max(64, Math.round(Number(span) * factor)));
      const half = newSpan / 2n;
      const newStart = mid > half ? mid - half : 0n;
      return { ...v, start: newStart, end: newStart + newSpan };
    });
    stepCount++;
    if (stepCount % 10 === 0) direction *= -1;
  }
  return { scenario: 'B3', ...summarize(samples) };
}

/**
 * Format a perf report markdown block. The runner can copy this straight
 * into BENCHMARK_REPORT.md or post it to the user.
 */
export function formatReport(
  b1: B1Result,
  b2: B2Result | null,
  b3: B3Result | null,
  env: { ua: string; dpr: number; canvas: { w: number; h: number } },
): string {
  const lines: string[] = [];
  lines.push('# Chroma — perf report');
  lines.push('');
  lines.push(`UA: \`${env.ua}\``);
  lines.push(`DPR: ${env.dpr}, canvas ${env.canvas.w}×${env.canvas.h}`);
  lines.push('');
  lines.push('| Scenario | Result | Target | Gate |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(
    `| B1 cold render (1Mb) | ${b1.initialRenderMs.toFixed(0)} ms${b1.ok ? '' : ' (timeout)'} | < 300 ms | ${b1.initialRenderMs < 300 ? '✅' : '❌'} |`,
  );
  if (b2) {
    lines.push(
      `| B2 pan avg fps | ${b2.avgFps.toFixed(1)} (p95 ${b2.p95Fps.toFixed(1)}, worst ${b2.worstFps.toFixed(1)}) | ≥ 60 avg / ≥ 50 p95 | ${b2.avgFps >= 60 && b2.p95Fps >= 50 ? '✅' : '⚠️'} |`,
    );
  }
  if (b3) {
    lines.push(
      `| B3 zoom avg fps | ${b3.avgFps.toFixed(1)} (worst ${b3.worstFps.toFixed(1)}) | ≥ 60 avg | ${b3.avgFps >= 60 ? '✅' : '⚠️'} |`,
    );
  }
  return lines.join('\n');
}

/** Convenience: run all wired scenarios sequentially, return formatted report. */
export async function runAll(): Promise<{ b1: B1Result; b2: B2Result; b3: B3Result; report: string }> {
  const b1 = await runB1();
  await sleep(500);
  const b2 = await runB2();
  await sleep(500);
  const b3 = await runB3();
  const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
  const report = formatReport(b1, b2, b3, {
    ua: navigator.userAgent,
    dpr: window.devicePixelRatio,
    canvas: { w: canvas?.width ?? 0, h: canvas?.height ?? 0 },
  });
  return { b1, b2, b3, report };
}
