# HANDOFF_NEXT — picking the project back up

> Updated at the end of the sticky-routing + reference-FASTA arc.
> Replaces the earlier handoff written at commit `813655b`. Snapshot of
> what's in `main`, what's wired, what's parked, and the exact prompt to
> drop into the next session.

---

## Project at a glance

```
42 commits on main, single trunk.
208 / 208 unit tests pass (vitest, includes 9 adapt + 17 policy + 8 chrom).
TypeScript 6 strict + noUncheckedIndexedAccess clean.
Production build: 87.8 kB main JS + 22.1 kB CSS gzipped 31.4 + 5.3 kB
                  + 188.8 kB parser.worker chunk (separate, ~40 kB gz).
Live demo: https://chroma-delta.vercel.app  (Vercel scope: game-tool-team)
```

Run from project root:
```bash
pnpm install
pnpm dev          # binds 5174 (5173 may be taken by parallel projects)
pnpm typecheck    # tsc -b --noEmit
pnpm test         # vitest run
pnpm build        # tsc -b && vite build
```

Redeploy after committing:
```powershell
vercel --prod --scope game-tool-team --yes
```

## What's live in the demo today

**5 tracks** loaded by default at `chr20:10,000,000-10,010,000`, top → bottom:

| Track | Kind | Source | Notes |
|---|---|---|---|
| hg19 reference (IGV / Broad) | reference | s3.amazonaws.com/igv.broadinstitute.org | plain `.fa + .fai` over Range, CORS open, per-base 1-bp quads at zoom-in |
| Ensembl · genes (GRCh38) | gene | rest.ensembl.org REST API | gene + transcript + exon, 1-Mb tiles |
| phyloP100way · conservation | bigwig | UCSC hg19 phyloP | conservation signal |
| HG002 · GIAB GRCh38 300× | bam | NCBI ftp-trace | high-coverage hg38 BAM (see #6) |
| HG00096 · 1000G low-coverage | bam | 1000genomes.s3.amazonaws.com | hg19 5× pilot |

Three different builds in one demo (hg19 reference + BigWig + BAM,
GRCh38 BAM + genes). The chrom-length table is hg38 (close enough that
the hg19 tracks don't visibly overshoot).

## What works (per-layer status)

| Layer | Component | Status |
|---|---|---|
| L1 data | `network/range-fetcher.ts` | Coalescing + Cache API. 8 tests. |
| L1 data | `network/ensembl-genes.ts` | Main-thread REST fetcher for gene annotations. |
| L1 data | `workers/pool.ts` + `parser.worker.ts` | Comlink RPC, MessagePort abort, per-URL parser cache. |
| L1 data | `workers/parser.worker.ts` BAM | `@gmod/bam` real. |
| L1 data | `workers/parser.worker.ts` BigWig | `@gmod/bbi` real. |
| L1 data | `workers/parser.worker.ts` FASTA | `@gmod/indexedfasta` real with `MinimalRemoteFile` shim. |
| L1 data | `workers/parser.worker.ts` VCF | **STUB** — throws `not implemented`. |
| L1 data | `tile-policy.ts` | `policyFor(kind, span)` single source: bam/bigwig/reference/gene ladders. 21 tests. |
| L1 data | `tiles/cache.ts` | LRU + viewport-distance eviction. 5-component tile keys. 20 tests. |
| L1 data | `track-engine.ts` | Template `runTileDispatch<R>` + per-kind specs (bam/bigwig/reference/gene). |
| L2 render | `webgl/{context,program,buffer-pool}.ts` | Spike port. |
| L2 render | `coord/index.ts` | 64-bit bigint coord + `contextToFraction`/`fractionToContext`. |
| L2 render | `tracks-render/bam-pileup.ts` | Instanced, edge AA, strand colour. Buffer orphaned every draw. |
| L2 render | `tracks-render/bam-coverage.ts` | Bottom-anchored bars. |
| L2 render | `tracks-render/bigwig.ts` | Coverage clone + log-scale uniform. |
| L2 render | `tracks-render/reference.ts` | Per-base coloured 1-bp quads (Path A only — no SDF letters). |
| L2 render | `tracks-render/gene.ts` | gene/transcript/exon instanced quads, parent-aware row assignment. |
| L2 render | `scheduler.ts` | RAF + per-kind band height (BAM coverage 60 px / pileup 200 px / gene 90 px). |
| L3 state | `types.ts` | Lead-frozen. Recent additions: `GeneFeature` / `GeneTile` / `GeneTrack.chromMap`. |
| L3 state | `viewport / tracks / selection / tile-cache / theme / ui-focus` | Solid signals. |
| L3 state | `context-range.ts` | hg38 chrom-length table + `adaptContextRange` (debounced 200 ms refit). |
| L3 state | `viewport-actions.ts` | pan/zoom/jump + `panBpWithin/resizeViewportEdge/setViewportSpan` (context-aware). |
| L3 state | `locus-parser.ts` / `url-sync.ts` | Unchanged from M1. |
| L4 ui | `TopBar.tsx` | Live locus input. |
| L4 ui | `TrackPanel.tsx` | 220 px sidebar, eye toggle, ⋯ remove, add-track prompt. |
| L4 ui | `GenomeView.tsx` | Canvas + scheduler + skeleton overlay + Shift+wheel pan handler. |
| L4 ui | `RangeSelectionBar.tsx` | DAW-style ruler: drag-create / move / resize / Esc cancel. |
| L4 ui | `ThemeToggle.tsx` | Per-icon lucide imports (barrel kills dev server). |
| L4 ui | `shortcuts/global-shortcuts.ts` | `h/l/+/-/0/g/t/?` + `v/d/Delete`. |

## Performance (re-measured after sticky-routing fix, 5-track demo)

Chrome stable, 1280×800 viewport, 1060×752 canvas. Numbers are noisier
than the old 2-track M2-prep baseline because B1 now waits on all
visible tracks, and the 300× HG002 BAM is the long pole (carry-forward
#6 — was #7 pre-shipment of sticky routing).

| Scenario | Result | Target | Gate |
| --- | --- | --- | --- |
| B1 cold 1 Mb, 1 BAM track, fresh region | 8.6 s (cold worker) | 300 ms | ❌ |
| B1 same URL, different 1 Mb region | 2.9 s (BAI cached) | 300 ms | ❌ |
| B1 cold 1 Mb, 5-track default demo | 7–30 s (300× BAM dominates) | 300 ms | ❌ |
| B2 pan avg / p95 fps | 59.9 / 59.5 (pre-arc) | 60 / 50 | ✅ |
| B3 zoom avg fps | 59.9 (pre-arc) | 60 | ✅ |
| B5 heap (5 tracks) | < 50 MB | 300 MB | ✅ |

The 1.14 s M2-prep figure was a stale 2-track measurement; with the
GRCh38 300× BAM + gene API + reference added since, the steady-state
B1 envelope is fundamentally different. Sticky URL-hash routing
(commit `44dd3df`) cut **second-nav-on-same-URL** from a re-parse
cost (~8 s) to a header-cache hit (~3 s), but the cold first nav is
still dominated by network + per-track index parse. Closing the
300 ms gate requires #1 below (single-fetch-per-viewport BAM) and
either dropping or rate-limiting the 300× BAM at 1 Mb span.

Bench scaffold in `tests/bench/perf.ts`, loaded via
`await import('/tests/bench/perf.ts')` inside the preview. `runAll()`
returns `{ b1, b2, b3, report }`.

## Recent UAT-driven fixes (this arc, in commit order)

| Commit | Fix |
| --- | --- |
| `5e48bd5` | tileWidth decoupling + per-URL parser cache (5 s → 1.1 s B1) |
| `3863615` | Unified `policyFor()` + templated `runTileDispatch` |
| `6c5d6ef` | README + Vercel/Cloudflare deploy configs |
| `7f1c776` | DAW range-selection bar + Shift+wheel horizontal pan |
| `3d90677` | Orphan instance buffer every draw (cross-tile race fix) |
| `0a31cdc` | Per-tier BAM band height (60 px coverage vs 200 px pileup) + contextRange auto-adapt |
| `56474a1` | GRCh38 BAM demo + Ensembl gene track + GeneRenderer |
| `44dd3df` | Stable per-URL worker dispatch — FNV-1a hash, no more cold-cache scatter |
| `79e694e` | hg19 reference FASTA seeded at top of demo stack (IGV / Broad mirror) |

## Known gaps + carry-forward (updated)

Closed in this arc (no longer carry-forward):

- ✅ **URL-hash sticky worker routing** — shipped in `44dd3df`. FNV-1a
  hash on `req.url` keeps each file's parser instance pinned to one
  worker. Same-URL re-nav cost dropped ~8 s → ~3 s (one-track A→B
  region measurement).
- ✅ **Reference FASTA demo data** — shipped in `79e694e`. The "needs
  bgzip" note was wrong: `IndexedFasta` (not the `Bgzip` variant our
  worker uses) only wants `.fa + .fai` over HTTP Range. Broad's S3
  bucket hosts that with CORS open.

Remaining, ordered roughly by ROI:

1. **Single-fetch-per-viewport BAM mode** (~3-4 h). For B1 to hit
   300 ms, we'd need IGV's "one request per viewport" mode in parallel
   to the tile cache. Big refactor; keep tile-cache for cache reuse but
   add a fast-paint single-fetch path.

2. **Cross-tile pileup row merge** (~1 h). `bam-pileup.ts` assigns
   pileup rows per-tile; reads at tile boundaries draw twice. Add
   `drawMerged(tiles, viewport, yTopPx)` that dedups by (start, length,
   flags) tuple before row assignment.

3. **Gene-name labels** (~2-3 h). Currently `gene.ts` draws geometry
   only; users see colored shapes with no names. Two paths:
   - SDF font atlas (production: msdf-bmfont-xml pre-baked, sampled in
     fragment shader). Same as Reference Path B in `reference.ts`.
   - Canvas2D overlay div positioned absolutely. Cheaper but mixes
     rendering surfaces.

4. **VCF parser + tick renderer + demo track** (~3 h). Worker stub at
   `parser.worker.ts` ready for `@gmod/vcf` + `@gmod/tabix`. Add a
   `dispatchTrack` case (now a small change after `3863615` refactor).
   New `tracks-render/vcf.ts` for tick + tooltip.
   `POLICIES['vcf']` entry in `tile-policy.ts`.

5. **Ensembl rate-limit handling** (~30 min). Free tier is 15 req/s.
   Heavy panning storms can hit 429. Add a queue + 65 ms min spacing,
   or cache per (chrom, span-bucket) so repeated pans share a fetch.

6. **300× BAM at 1 Mb span hangs**. Promoted from the previous
   "33 Mb overview" gap — observed live at 1 Mb during this arc's
   bench: HG002 GIAB stays `0 ready / 0 loading / 0 error` for 30+ s
   while the other 4 tracks resolve. Sticky routing made the other
   tracks fast and exposed this as the dominant B1 cost. Fix options:
   - Cap the BAM read path to N sampled reads at coverage tier
   - Use a coarser binSize ceiling so coverage queries never exceed
     N kb of reads in a single request
   - Or just drop the 300× demo from the default seed until #1
     (single-fetch-per-viewport) lands.

7. **HelpOverlay (T2.D.4) + Search palette (T2.D.5) + MiniMap (T2.D.3)**.
   `?` is a no-op; `g` works via TopBar input but no gene-name search.
   MiniMap spec in DESIGN_SYSTEM §5.

8. **CIGAR + paired-end** for BAM pileup. Currently plain rectangles.

9. **SDF font for reference base letters** (Reference Path B). At
   `basePixelWidth >= 12` we should draw actual A/C/G/T characters.
   The hg19 reference now in the demo (top of stack) renders as Path A
   coloured 1-bp quads — visually legible at 500 bp, sub-pixel at the
   default 10 kb span.

## Architecture debt notes

- **`MinimalRemoteFile`** in `parser.worker.ts` is a tiny shim around
  `fetch` to avoid pulling `generic-filehandle2` as a direct dep. Used
  only by IndexedFasta.
- **Parser cache scope is per-worker, but routing is stable-by-URL**
  (since `44dd3df`). Each worker still maintains its own BamFile /
  BigWig / IndexedFasta map, but FNV-1a-on-`req.url` pins every call
  for a given file to one owning worker, so effectively each URL has
  one parser instance for the page lifetime. Adding tracks beyond
  ~6 distinct URLs would still distribute fairly across the pool.
- **`tileCache` viewport-distance eviction uses `tileWidthBp` for
  midpoint.** Audit if policy ever uses a different tile-indexing
  scheme.
- **chromosome-length table is hg38 only.** Adding a track on a
  build with substantially different chrom lengths (e.g. mm10, T2T-CHM13)
  would put the range bar's right edge slightly off. Real fix: read
  per-track `.fai`.
- **Gene track does its fetch on main thread** (not via worker pool).
  Acceptable because the response is small JSON and parsing is just
  `JSON.parse`. If we add many gene tracks, consider moving to a
  shared fetch queue.
- **Race condition window in worker dispatch.** Between
  `inflight.has(key)` and `inflight.set(key)` in `runTileDispatch`,
  the effect could re-fire and double-dispatch. Currently shielded
  by the 100 ms debounce.

## Quirks the next session will hit

1. **Port 5174, not 5173.** `vite.config.ts` pins via `strictPort: true`
   so a parallel project on 5173 doesn't shadow us. Update
   `.claude/launch.json` if you move it.

2. **lucide-solid barrel import kills dev.** `import { Moon } from
   'lucide-solid'` fetches 1800+ icon modules. Use per-icon path:
   `import Moon from 'lucide-solid/icons/moon'`. Enforced in
   ThemeToggle, TopBar, TrackPanel.

3. **chromMap on tracks.** 1000G uses bare chrom names (`20`);
   GRCh38 BAM and Ensembl use mixed — set `chromMap: 'strip-chr'` for
   bare-chrom data sources. The locus-parser auto-prefixes user input
   to `chr*`.

4. **`typecheck` runs `tsc -b --noEmit`** (build mode, traverses
   project references). Plain `tsc --noEmit` against the root
   tsconfig is a no-op because of `files: []`. Don't regress.

5. **GRCh38 chrom lengths in `context-range.ts`.** Was hg19, swapped
   `5e48bd5` → `0a31cdc` era. If you add a hg19 demo track, the bar's
   right edge sits 1-2 % past true chrom end. Acceptable for now.

6. **Build produces a separate `parser.worker.*.js`** at ~189 kB
   (gz ~40 kB). Expected — gmod parsers live there.

7. **`tileCache` singleton is global across the page.** `initTileCache()`
   is idempotent. For tests, `disposeTileCache()` first.

8. **Solid `computations created outside createRoot` warnings** on
   boot — noise from module-level signals in `theme.ts` / `derived.ts`
   / `context-range.ts`. Harmless.

9. **`preserveDrawingBuffer: false`** on the WebGL context — readPixels
   after present returns zeros. Tests use a fake-GL stub.

10. **PowerShell heredocs with `<` characters break git commit.** Use
    `git commit -F .git/COMMIT_MSG.txt` for messages containing HTML/JSX.

## Recommended next-session opening prompt

```
Pick up Chroma from `main`. Read these in order:
  docs/HANDOFF.md            (project bible, do not deviate)
  docs/HANDOFF_NEXT.md       (this file — last arc's exit state)
  README.md
  git log --oneline -15      (recent commits for context)

Then confirm by reporting back:
  - which gap from HANDOFF_NEXT you want to close first
  - the prescribed plan
  - whether you'll do it lead-side or dispatch sub-agents

Project state: 42 commits, 5 demo tracks live at
https://chroma-delta.vercel.app (hg19 reference at the top,
genes / phyloP / 2 BAMs below), 208/208 tests, B2/B3 60 fps locked.
B1 cold is dominated by the 300× GIAB BAM (carry-forward #6) — same-
URL re-nav is ~3 s after the sticky-routing fix; fresh-region cold
is still ~8 s and the gate (300 ms) needs carry-forward #1
(single-fetch-per-viewport).

Tooling note: this machine has `vercel` CLI authenticated to the
game-tool-team scope. Redeploys: `vercel --prod --scope game-tool-team --yes`.
```

## Demo dataset URLs (for reseed)

```
HG002 GIAB GRCh38 300× (high-coverage hg38 BAM):
  bam:  https://ftp-trace.ncbi.nlm.nih.gov/ReferenceSamples/giab/data/AshkenazimTrio/HG002_NA24385_son/NIST_HiSeq_HG002_Homogeneity-10953946/NHGRI_Illumina300X_AJtrio_novoalign_bams/HG002.GRCh38.300x.bam
  bai:  same + .bai
  no chromMap (uses "chr20" canonical)

HG00096 1000G low-coverage Illumina (hg19):
  bam:  https://1000genomes.s3.amazonaws.com/phase3/data/HG00096/alignment/HG00096.mapped.ILLUMINA.bwa.GBR.low_coverage.20120522.bam
  bai:  same + .bai
  chromMap: 'strip-chr' (BAM uses bare "20")

UCSC phyloP100way conservation (hg19):
  bw:   https://hgdownload.soe.ucsc.edu/goldenPath/hg19/phyloP100way/hg19.100way.phyloP100way.bw
  no chromMap (uses "chr20")

Ensembl REST gene/transcript/exon (GRCh38):
  host: https://rest.ensembl.org
  format: 'ensembl-rest'
  chromMap: 'strip-chr' (API uses bare "20")
  (grch37.rest.ensembl.org for hg19)

hg19 reference FASTA (IGV / Broad mirror, plain .fa + .fai):
  fa:  https://s3.amazonaws.com/igv.broadinstitute.org/genomes/seq/hg19/hg19.fasta
  fai: https://s3.amazonaws.com/igv.broadinstitute.org/genomes/seq/hg19/hg19.fasta.fai
  no chromMap (uses "chr20"); CORS open; LastModified 2013
```

## Deploy

`vercel.json` + `wrangler.toml` are in the repo root. README has the
commands. Live URL: https://chroma-delta.vercel.app (production
alias on the game-tool-team scope).

To redeploy from a clean working tree:
```powershell
vercel --prod --scope game-tool-team --yes
```
Output gives the new deployment URL plus the (already live) alias.
