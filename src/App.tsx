import { onCleanup, onMount } from 'solid-js';
import { ThemeToggle } from '~ui/components/ThemeToggle';
import { GenomeView } from '~ui/components/GenomeView';
import { useGlobalShortcuts } from '~ui/shortcuts/global-shortcuts';
import { startUrlSync } from '~state/url-sync';
import { startTrackEngine } from '~data/track-engine';
import { setTracks, tracks } from '~state/tracks';
import { setViewport, viewport } from '~state/viewport';
import { formatLocus } from '~state/locus-parser';
import { basePixelWidth, semanticLevel } from '~state/derived';
import type { BamTrack } from '~state/types';

/**
 * App shell — M1 E2E.
 *
 * On mount: url-sync, track-engine boot, and a demo 1000G low-coverage BAM
 * seeded if no tracks were restored from the URL. Default viewport pinned
 * to a small chr20 window for fast first paint.
 *
 * IGV's own demo S3 bucket is currently 403 from anonymous; we use the
 * public 1000 Genomes mirror (HG00096 low-coverage Illumina) which has
 * permissive CORS and a stable BAI alongside it.
 */
const DEMO_TRACK: BamTrack = {
  id: 'hg00096-1kg-lowcov',
  kind: 'bam',
  label: 'HG00096 · 1000G low-coverage',
  url: 'https://1000genomes.s3.amazonaws.com/phase3/data/HG00096/alignment/HG00096.mapped.ILLUMINA.bwa.GBR.low_coverage.20120522.bam',
  indexUrl:
    'https://1000genomes.s3.amazonaws.com/phase3/data/HG00096/alignment/HG00096.mapped.ILLUMINA.bwa.GBR.low_coverage.20120522.bam.bai',
  visible: true,
};

export default function App() {
  useGlobalShortcuts();
  let disposeUrlSync: () => void = () => {};
  let disposeTrackEngine: () => void = () => {};

  onMount(() => {
    disposeUrlSync = startUrlSync();
    disposeTrackEngine = startTrackEngine();

    if (tracks().length === 0) {
      setTracks([DEMO_TRACK]);
      // 1000G uses bare chromosome names (no "chr" prefix). Seed a small
      // chr20 window with enough reads to exercise the pileup renderer.
      setViewport((v) => ({
        ...v,
        chrom: '20',
        start: 10_000_000n,
        end: 10_010_000n,
      }));
    }
  });

  onCleanup(() => {
    disposeUrlSync();
    disposeTrackEngine();
  });

  return (
    <div class="chroma-shell">
      <header class="chroma-topbar">
        <div class="chroma-brand">
          <span class="chroma-mark" aria-hidden="true" />
          <span class="chroma-wordmark">Chroma</span>
        </div>
        <div class="chroma-locus-readout">
          <span class="chroma-locus-readout-label">{formatLocus(viewport())}</span>
          <span class="chroma-locus-readout-meta">
            bpw {basePixelWidth().toExponential(2)} · {semanticLevel()}
          </span>
        </div>
        <div class="chroma-topbar-spacer" />
        <ThemeToggle />
      </header>

      <main class="chroma-stage chroma-stage-host">
        <GenomeView />
      </main>
    </div>
  );
}
