# HANDOFF_NEXT — picking the project back up

> Written at the end of the 2-day sprint. Snapshot of what's in `main`,
> what's wired, what's parked, and the prompt to drop into the next
> session.

---

## Project at a glance

```
31 commits on main, single trunk.
159 / 159 unit tests pass (vitest).
TypeScript 6 strict + noUncheckedIndexedAccess clean.
Production build: 74.4 kB JS + 21 kB CSS + 189 kB parser.worker.
Live demo loads 1000G HG00096 BAM + UCSC phyloP100way BigWig from public S3.
```

Run from project root:
```bash
pnpm install
pnpm dev          # binds 5174 (5173 may be taken by parallel projects)
pnpm typecheck    # tsc -b --noEmit
pnpm test         # vitest run
pnpm build        # tsc -b && vite build
```

## What works

| Layer | Component | Status |
|---|---|---|
| L1 data | `network/range-fetcher.ts` | Coalescing + Cache API + 6-concurrent + retry. 8 tests. |
| L1 data | `workers/pool.ts` + `parser.worker.ts` | Comlink RPC, MessagePort abort, per-URL parser cache. |
| L1 data | `workers/parser.worker.ts` BAM | `@gmod/bam` real, ReadTile + CoverageTile via Transferable. 6 tests. |
| L1 data | `workers/parser.worker.ts` BigWig | `@gmod/bbi` real, basesPerSpan zoom-level pick. 9 render-side tests. |
| L1 data | `workers/parser.worker.ts` FASTA | `@gmod/indexedfasta` real with `MinimalRemoteFile` shim. |
| L1 data | `workers/parser.worker.ts` VCF | **STUB** — throws `not implemented`. |
| L1 data | `tile-policy.ts` | Single-source `policyFor(kind, span)` ladder. 17 tests. |
| L1 data | `tiles/cache.ts` | LRU + viewport-distance eviction. 20 tests. |
| L1 data | `track-engine.ts` | Template `runTileDispatch<R>` + per-kind specs. |
| L2 render | `webgl/{context,program,buffer-pool}.ts` | Spike port. 4 tests. |
| L2 render | `coord/index.ts` | 64-bit bigint coord + view matrix. 15 tests. |
| L2 render | `tracks-render/bam-pileup.ts` | Instanced, edge AA, strand color. 11 tests. |
| L2 render | `tracks-render/bam-coverage.ts` | Bottom-anchored bars, lead-ported from spike. |
| L2 render | `tracks-render/bigwig.ts` | Coverage-program clone + log-scale uniform. |
| L2 render | `tracks-render/reference.ts` | Per-base colored 1-bp quads (Path A). 7 tests. |
| L2 render | `scheduler.ts` | RAF + tileCache snapshot + per-kind heights + policy filter. |
| L3 state | `types.ts` | Lead-frozen contract. `chromMap` field on BamTrack. |
| L3 state | `viewport / tracks / selection / tile-cache / theme / ui-focus` | Solid signals. |
| L3 state | `locus-parser.ts` | 7 input formats, formatLocus inverse. 23 tests. |
| L3 state | `url-sync.ts` | Hash + base64 tracks, 100/200ms debounce. 16 tests. |
| L3 state | `viewport-actions.ts` | panBy / zoomBy / jumpTo / clampViewport. 19 tests. |
| L4 ui | `TopBar.tsx` | Live locus input, shake on invalid Enter, `g` focus via ui-focus. |
| L4 ui | `TrackPanel.tsx` | 220px sidebar, eye toggle, ⋯ remove, add-track prompt. |
| L4 ui | `GenomeView.tsx` | Canvas + scheduler + skeleton overlay. |
| L4 ui | `ThemeToggle.tsx` | per-icon `lucide-solid/icons/{moon,sun}` (barrel kills dev server). |
| L4 ui | `shortcuts/global-shortcuts.ts` | `h/l/+/-/0/g/t/?` + `v/d/Delete` for track ops. |

## Performance numbers (last measured)

Chrome stable, 1280×800 viewport, 1060×752 canvas:

| Scenario | Result | Target | Gate |
| --- | --- | --- | --- |
| B1 cold 1 Mb (first nav) | 1.14 s | 300 ms | ⚠️ |
| B1 cold 1 Mb (worker warm) | 1.75 s | 300 ms | ⚠️ |
| B1 cold 1 Mb (worker cold via round-robin) | 3.03 s | 300 ms | ⚠️ |
| B1 warm cache hit | 0 ms | 300 ms | ✅ |
| B2 pan avg / p95 / worst fps | 59.9 / 59.5 / 59.2 | 60 / 50 | ✅ |
| B3 zoom avg / p95 / worst fps | 59.9 / 59.5 / 59.2 | 60 | ✅ |
| B5 heap (2 tracks) | ~5 MB | 300 MB | ✅ |

Bench scaffold lives in `tests/bench/perf.ts`, loaded inside the preview
via `await import('/tests/bench/perf.ts')`. Run from a fresh page:
```js
const { runAll } = await import('/tests/bench/perf.ts');
const r = await runAll();
console.log(r.report);
```

## Known gaps + carry-forward

Ordered roughly by ROI for closing:

1. **URL-hash sticky worker routing** (~30 min). Pool round-robin pushes
   parseBam calls to whichever worker; with per-worker parser cache, the
   "wrong" worker is cold and adds ~1-2 s. Fix: hash `req.url` mod
   `workers.length`. Trade: less parallelism for stability. Touch
   `src/data/workers/pool.ts` only.

2. **Single-fetch-per-viewport BAM model** (~3-4 h). Real IGV makes ONE
   range request per viewport, parses everything in-page. Our tiling
   buys cache reuse on pan; for cold load it's slower. Could keep both —
   first paint via single-fetch, subsequent panning via tile cache. Big
   refactor, hits HANDOFF §3 300 ms target.

3. **Cross-tile pileup row merge** (~1 h). `bam-pileup.ts` assigns
   pileup rows per-tile, so reads at tile boundaries draw twice. Add
   `drawMerged(tiles, viewport, yTopPx)` that concatenates + dedups by
   (start, length, flags) tuple before row assignment.

4. **VCF parser + tick renderer + demo track** (~3 h). Worker stub at
   `parser.worker.ts` ready for `@gmod/vcf` + `@gmod/tabix`. Add a
   `dispatchTrack` case in `track-engine.ts` (now a small change after
   `3863615` refactor). New `tracks-render/vcf.ts` for tick + tooltip.
   `POLICIES['vcf']` entry in `tile-policy.ts`.

5. **Reference FASTA demo data**. UCSC `chr20.fa.gz` is plain gzip, not
   bgzip. Need bgzip + .gzi compatible host. Options:
   - Self-host on the deploy target (chr20 indexed FASTA is ~64 MB)
   - Use a publicly-hosted bgzipped reference if one exists
   Then add `chr20-reference` track to App.tsx demo seed.

6. **HelpOverlay (T2.D.4) + Search palette (T2.D.5)**. `?` shortcut is
   a no-op; the keyboard hints from `shortcutHints()` exist but no UI
   surfaces them. The `g` flow uses an inline TopBar input, but a
   gene-search-by-name palette would round out the discoverability.

7. **MiniMap (T2.D.3)**. Spec is in DESIGN_SYSTEM §5 — 24px tall
   ideogram with current-viewport highlight. Cytoband data needs to be
   bundled (GRCh37 cytoBand.txt is small, ~50 KB).

8. **CIGAR + paired-end** for BAM pileup. Pileup currently uses
   `length_on_ref` and draws plain rectangles. Real IGV shows insertions
   as bars, deletions as gaps, soft-clips colored. Worker can decode
   CIGAR; renderer needs additional instance attributes.

9. **SDF font for reference base letters** (Reference Path B). At
   `basePixelWidth >= 12` we should draw actual A/C/G/T characters, not
   just colored quads. Pre-baked Canvas2D atlas works as a stand-in;
   true SDF via `msdf-bmfont-xml` is the production path.

## Architecture debt notes

These are all flagged in commit messages of `5e48bd5` / `3863615` but
worth surfacing here so the next session sees them:

- **`MinimalRemoteFile` in `parser.worker.ts`** is a tiny shim around
  `fetch` to avoid pulling `generic-filehandle2` as a direct dep.
  Works for indexed FASTA's read/readFile/stat/close surface. If BAM
  or BigWig needed it too, we'd factor out, but `@gmod/bam` and
  `@gmod/bbi` happily take a URL string directly.

- **Parser cache scope is per-worker, not global.** Each of the 6 pool
  workers maintains its own BamFile / BigWig / IndexedFasta Map. Round-
  robin dispatch means the first ~6 navs hit cold workers. See gap #1.

- **`tileCache` viewport-distance eviction uses `tileWidthBp` for
  midpoint.** The cache.ts `distanceBp` function was correct after the
  refactor in `5e48bd5`. If the policy ever uses a different tile-
  indexing scheme, audit this.

- **`bamCache` Map in worker uses URL+indexURL pair as key.** If two
  tracks share BAM but different BAI, they get different cached
  instances — that's correct. If a URL ever has tracking params, the
  cache miss rate spikes; consider canonicalizing URL.

- **Race condition window in worker dispatch.** Between
  `inflight.has(key)` check and `inflight.set(key)` in
  `runTileDispatch`, the effect could re-fire and double-dispatch.
  Currently shielded by the 100 ms debounce, but if debounce changes,
  audit.

## Quirks the next-session will hit

1. **Port 5174, not 5173.** Vite is pinned via `strictPort: true` in
   `vite.config.ts` so a parallel project holding 5173 doesn't shadow
   us. Update `.claude/launch.json` if you move it.

2. **lucide-solid barrel import kills dev.** `import { Moon } from
   'lucide-solid'` fetches 1800+ icon files through Vite's transformer
   on first load (30+ s blank page). Use per-icon path:
   `import Moon from 'lucide-solid/icons/moon'`. Already enforced in
   `ThemeToggle.tsx`, `TopBar.tsx`, `TrackPanel.tsx`.

3. **chromMap on BAM tracks.** 1000G uses bare chrom names (`20`);
   hg19/hg38 with UCSC use prefixed (`chr20`). The locus-parser
   auto-prefixes user input to `chr*`, so for 1000G BAM the
   `BamTrack.chromMap: 'strip-chr'` option strips the prefix before
   sending to the worker. Without it, the BAI lookup misses and you
   get 0 reads forever. There's an `add-chr` inverse for the other
   way.

4. **`typecheck` script.** Earlier it ran `tsc --noEmit` (no -b), which
   skipped the project-reference traversal and silently passed
   everything. Now `tsc -b --noEmit`. If you regress this, watch for
   "tests green but build red" reports.

5. **Default viewport is `chr20:10,000,000-10,010,000`** seeded in
   `App.tsx`. URL hash overrides on reload. To reset, clear the hash:
   `history.replaceState(null, '', '/'); location.reload()`.

6. **Build creates a separate `parser.worker.*.js` chunk** at ~189 KB
   (gz ~40 KB). That's expected — `@gmod/bam` + `@gmod/bbi` + their
   transitive parsers live there, not in the main bundle.

7. **`tileCache` singleton is global across the page.** `initTileCache()`
   is idempotent (returns existing instance). If you ever need a fresh
   one for tests, call `disposeTileCache()` first.

8. **Solid `createRoot` warnings on console** during initial render —
   noise from module-level signals in `theme.ts` / `derived.ts`.
   Doesn't affect behavior; could be silenced by moving signal
   creation into a `createRoot` wrapper but not worth the churn.

## Recommended next-session opening prompt

```
Pick up Chroma from `main`. Read these in order:
  docs/HANDOFF.md (project bible, do not deviate)
  docs/HANDOFF_NEXT.md (this file — last sprint's exit state)
  README.md
  git log --oneline (31 commits, get familiar with the layering)

Confirm by reporting back: which gap from HANDOFF_NEXT you want to close
first, the prescribed plan, and whether you'll do it lead-side or
dispatch sub-agents. Then we go.

Current state: full gate green, demo loads live, B1 ~1.1 s cold,
B2/B3 60 fps. Architecture debt has been paid down once
(commit 3863615); ready to take on new track kinds without further
template work.
```

## Demo dataset URLs (for reference / reseed)

```
BAM (1000G HG00096 low-coverage Illumina, hg19):
  bam:  https://1000genomes.s3.amazonaws.com/phase3/data/HG00096/alignment/HG00096.mapped.ILLUMINA.bwa.GBR.low_coverage.20120522.bam
  bai:  same + .bai
  chromMap: 'strip-chr'  (BAM uses bare "20")

BigWig (UCSC phyloP100way conservation, hg19):
  bw:   https://hgdownload.soe.ucsc.edu/goldenPath/hg19/phyloP100way/hg19.100way.phyloP100way.bw
  (chrom names use "chr20", matches viewport canonical form)

Reference: deferred — see gap #5.
```

## Deploy

`vercel.json` + `wrangler.toml` are in the repo root. README has the
commands. The deploy is a one-shot from the user's account — no
credentials in the repo.
