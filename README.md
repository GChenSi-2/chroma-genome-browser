# Chroma

A modern WebGL2 genome browser. Tile-cached, signal-driven, keyboard-first.
Built in a two-day sprint as an IGV.js alternative for genomics and clinical
report embedding.

```
[■] Chroma — a genome browser that respects your time.
```

---

## What works today

- **Real BAM pileup** straight from S3 (1000 Genomes HG00096 by default),
  WebGL2 instanced rectangles, strand-aware coloring
- **BigWig signal histogram** (UCSC phyloP100way demo), shares a band stack
  with BAM on the same canvas
- **Tile cache** with viewport-distance LRU eviction + cross-zoom binSize
  filtering so stale tiles don't bleed
- **Keyboard navigation** — `h`/`l` pan, `+`/`-` zoom, `0` zoom-to-fit, `g`
  go-to-locus input, `t` theme, `?` shortcuts
- **URL state share** — `#chr20:10,000,000-10,500,000` round-trips into the
  viewport on page load; `?t=<base64>` carries the track config
- **Dark mode** wired to system preference + `t` toggle
- **TopBar** with live locus input (validates as you type, shake on bad
  Enter) and TrackPanel with per-track visibility / remove

## Performance (M2-prep snapshot)

Measured on Chrome stable @ 1280×800, 1060×752 canvas, against the public
1000G S3 BAM + UCSC BigWig:

| Scenario                  | Result        | Target        | Gate |
| ------------------------- | ------------- | ------------- | ---- |
| **B1** cold load (1 Mb)   | **1.14 s** *  | < 300 ms      | ⚠️    |
| **B1** warm cache hit     | 0 ms          | < 300 ms      | ✅   |
| **B2** pan avg fps        | **59.9 fps**  | ≥ 60          | ✅   |
| **B2** pan p95 fps        | **59.5 fps**  | ≥ 50          | ✅   |
| **B3** zoom avg fps       | **59.9 fps**  | ≥ 60          | ✅   |
| **B5** JS heap (2 tracks) | ~5 MB         | < 300 MB      | ✅   |

\* first-touch with a cold worker. Subsequent navs in the same session land
faster because parser indices (BAI 8.7 MB, BBI header) stay parsed in the
worker. The residual 1-3 s reflects ~30 HTTP range requests + read parsing
for each tile — closing that gap would require a single-fetch-per-viewport
model rather than tile binning. The 60 fps pan / zoom locks are stable
even while tile fetches run in the background.

## Architecture in one breath

```
L4 UI (Solid + Tailwind)     TopBar, TrackPanel, GenomeView
   │ signal read/write
L3 State (signals)           viewport · tracks · selection · tileCache · ui-focus
   │ subscribe
L2 Render (WebGL2 + C2D)     scheduler RAF → PileupRenderer / Coverage /
   │                                          BigWig / Reference
   ▲ tileCache snapshot
L1 Data (Workers + Comlink)  track-engine → worker pool → @gmod parsers →
                                            tile cache LRU
```

Single source of truth for `(binSize, tileWidthBp)` per (track-kind, span)
lives in `src/data/tile-policy.ts`. Both the data dispatcher and the render
filter read from it.

64-bit genomic coordinates: positions are `bigint` everywhere outside
`src/render/coord/`; that module is the only place allowed to cast to
`Number` for shader uniforms (after subtracting viewport origin).

## Quickstart

```bash
pnpm install
pnpm dev      # http://localhost:5174 (5173 may be taken; strictPort: true)

pnpm typecheck     # tsc -b --noEmit
pnpm test          # vitest run (159 unit tests)
pnpm build         # tsc -b && vite build
```

Default boot loads the demo BAM + BigWig automatically. Press `g` to jump
to any chr20 locus; the URL hash captures the view so a refresh restores
it.

## Demo data

- BAM: [1000G HG00096 low-coverage Illumina](https://1000genomes.s3.amazonaws.com/phase3/data/HG00096/alignment/HG00096.mapped.ILLUMINA.bwa.GBR.low_coverage.20120522.bam)
  (15.6 GB on S3; browser only fetches the few KB / MB it needs via
  HTTP Range)
- BigWig: [UCSC phyloP100way conservation, hg19](https://hgdownload.soe.ucsc.edu/goldenPath/hg19/phyloP100way/hg19.100way.phyloP100way.bw)
- Reference (FASTA): deferred — UCSC per-chrom files are gzip not bgzip,
  so `@gmod/indexedfasta` needs an external hosting step

Both demo files use hg19 / GRCh37 so loci line up across the two tracks.
1000G uses bare chromosome names (`20`); UCSC uses prefixed (`chr20`).
Chroma's `chromMap: 'strip-chr'` on the BAM track resolves the mismatch.

## What's intentionally not done

This is a two-day sprint snapshot. The render and data layers are real;
the chrome around them is selective:

- **No VCF** — parser stubbed, demo data not seeded (T2.E.1+)
- **No Reference FASTA demo** — needs bgzip + .gzi hosting
- **No cross-tile pileup row merge** — reads spanning a tile boundary may
  render twice. Mild on low-coverage data
- **No help overlay / search palette / minimap** — keyboard shortcuts work;
  the discoverability UI is post-demo
- **No SDF font for base letters** — Reference renderer ships
  colored 1-bp quads only
- **B1 cold-load doesn't hit 300 ms** — see Performance section

## Layout

```
src/
  data/    tile-policy.ts (single-source binSize+tileWidthBp ladder)
           track-engine.ts (template dispatcher; subscribes viewport+tracks)
           tiles/ (LRU cache + viewport-distance eviction)
           workers/ (Comlink RPC + per-URL parser cache + @gmod/{bam,bbi,indexedfasta})
           network/ (RangeFetcher: coalescing + Cache API + abort + retry)
  render/  webgl/ (context, program, buffer-pool, shaders)
           coord/ (64-bit bigint coord + view matrix builder)
           tracks-render/ (bam-pileup, bam-coverage, bigwig, reference)
           scheduler.ts (RAF, multi-renderer dispatch, per-kind heights)
  state/   types.ts (frozen contract; lead-approved extensions only)
           viewport, tracks, selection, tile-cache, theme, ui-focus
           locus-parser, url-sync, viewport-actions, derived
  ui/      App.tsx, components/{TopBar, TrackPanel, GenomeView, ThemeToggle, Stage}
           shortcuts/global-shortcuts.ts
docs/      HANDOFF, ARCHITECTURE, DESIGN_SYSTEM, TWO_DAY_SPRINT,
           AGENT_PLAYBOOK, BENCHMARKS
tests/     unit/ (159 tests across data + render + state)
           bench/ (perf.ts — runs live in the preview)
```

## Browser support

Chrome / Firefox / Safari 17+. WebGL2 required.
`SharedArrayBuffer` is not used; no COOP/COEP headers needed.

## License

Apache 2.0.

## Credits

- `@gmod/bam`, `@gmod/bbi`, `@gmod/indexedfasta`, `@gmod/tabix`, `@gmod/vcf`
  for the format parsers
- Solid.js for the reactivity
- `lucide-solid` for icons
- Inter (rsms.me) and JetBrains Mono for type

Built with Claude Code agents — see commit history for the orchestration
narrative.
