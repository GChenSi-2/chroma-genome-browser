import { onCleanup, onMount } from 'solid-js';
import { TopBar } from '~ui/components/TopBar';
import { TrackPanel } from '~ui/components/TrackPanel';
import { GenomeView } from '~ui/components/GenomeView';
import { useGlobalShortcuts } from '~ui/shortcuts/global-shortcuts';
import { startUrlSync } from '~state/url-sync';
import { startTrackEngine } from '~data/track-engine';
import { setTracks, tracks } from '~state/tracks';
import { setViewport } from '~state/viewport';
import type { BamTrack } from '~state/types';

/**
 * App shell — M2 prep layout.
 *
 * Grid:
 *   ┌────────────────────────────┐
 *   │           TopBar           │
 *   ├──────────┬─────────────────┤
 *   │ TrackPan │   GenomeView    │
 *   └──────────┴─────────────────┘
 *
 * On mount: url-sync, track-engine boot, and a demo 1000G low-coverage BAM
 * seeded if no tracks were restored from the URL. Default viewport pinned
 * to a small chr20 window for fast first paint.
 */
const DEMO_TRACK: BamTrack = {
  id: 'hg00096-1kg-lowcov',
  kind: 'bam',
  label: 'HG00096 · 1000G low-coverage',
  url: 'https://1000genomes.s3.amazonaws.com/phase3/data/HG00096/alignment/HG00096.mapped.ILLUMINA.bwa.GBR.low_coverage.20120522.bam',
  indexUrl:
    'https://1000genomes.s3.amazonaws.com/phase3/data/HG00096/alignment/HG00096.mapped.ILLUMINA.bwa.GBR.low_coverage.20120522.bam.bai',
  visible: true,
  // 1000G BAM is bare-chrom ("20") but locus-parser auto-prefixes to "chr20".
  // Strip the prefix before sending the chrom name to the parser worker.
  chromMap: 'strip-chr',
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
      <TopBar />
      <TrackPanel />
      <main class="chroma-main">
        <GenomeView />
      </main>
    </div>
  );
}
