import { onCleanup, onMount } from 'solid-js';
import { TopBar } from '~ui/components/TopBar';
import { TrackPanel } from '~ui/components/TrackPanel';
import { GenomeView } from '~ui/components/GenomeView';
import { RangeSelectionBar } from '~ui/components/RangeSelectionBar';
import { useGlobalShortcuts } from '~ui/shortcuts/global-shortcuts';
import { startUrlSync } from '~state/url-sync';
import { startTrackEngine } from '~data/track-engine';
import { setTracks, tracks } from '~state/tracks';
import { setViewport } from '~state/viewport';
import type { BamTrack, BigWigTrack, GeneTrack, ReferenceTrack, TrackConfig } from '~state/types';

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
const DEMO_BAM: BamTrack = {
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

/**
 * IGV / Broad hg19 reference FASTA — plain (uncompressed) .fa + .fai over
 * HTTP Range. `@gmod/indexedfasta`'s `IndexedFasta` (not the bgzip variant)
 * needs only those two files; the per-chrom UCSC .fa.gz files are plain
 * gzip and unusable, but Broad's S3 mirror has been serving the whole-genome
 * uncompressed FASTA since 2013 with CORS open. Chromosome naming is "chrN"
 * → matches viewport canonical form, no chromMap needed. Sits on top of the
 * stack so the renderer's 1-bp coloured quads sit above pileup/signal/genes
 * at zoom-in.
 */
const DEMO_REFERENCE: ReferenceTrack = {
  id: 'igv-broad-hg19-fasta',
  kind: 'reference',
  label: 'hg19 reference (IGV / Broad)',
  url: 'https://s3.amazonaws.com/igv.broadinstitute.org/genomes/seq/hg19/hg19.fasta',
  faiUrl: 'https://s3.amazonaws.com/igv.broadinstitute.org/genomes/seq/hg19/hg19.fasta.fai',
  visible: true,
};

/**
 * UCSC phyloP100way (hg19) — whole-genome conservation signal, BigWig.
 * Chromosome names use the "chrN" convention, matching the viewport's
 * canonical form, so no chromMap is needed. Both 1000G HG00096 and phyloP
 * are aligned to hg19/GRCh37, so loci match across the two tracks.
 */
const DEMO_BIGWIG: BigWigTrack = {
  id: 'ucsc-phyloP100way-hg19',
  kind: 'bigwig',
  label: 'phyloP100way · conservation',
  url: 'https://hgdownload.soe.ucsc.edu/goldenPath/hg19/phyloP100way/hg19.100way.phyloP100way.bw',
  visible: true,
};

/**
 * GIAB HG002 GRCh38 300x — NCBI-hosted, CORS-open, BAI 11.7 MB. 300x coverage
 * means every locus has dense data (no apparent "gaps" from sparse coverage
 * like the 1000G low-coverage demo). The BAM uses canonical "chrN" naming,
 * matching the viewport's locus-parser auto-prefix, so no chromMap needed.
 *
 * This is the same reference as IGV's own "GIAB HG002" demo. File is 601 GB
 * total; the browser only fetches the few KB it needs per tile via Range.
 */
const DEMO_BAM_HG38: BamTrack = {
  id: 'giab-hg002-grch38-300x',
  kind: 'bam',
  label: 'HG002 · GIAB GRCh38 300×',
  url: 'https://ftp-trace.ncbi.nlm.nih.gov/ReferenceSamples/giab/data/AshkenazimTrio/HG002_NA24385_son/NIST_HiSeq_HG002_Homogeneity-10953946/NHGRI_Illumina300X_AJtrio_novoalign_bams/HG002.GRCh38.300x.bam',
  indexUrl:
    'https://ftp-trace.ncbi.nlm.nih.gov/ReferenceSamples/giab/data/AshkenazimTrio/HG002_NA24385_son/NIST_HiSeq_HG002_Homogeneity-10953946/NHGRI_Illumina300X_AJtrio_novoalign_bams/HG002.GRCh38.300x.bam.bai',
  visible: true,
};

/**
 * Ensembl REST gene annotation (GRCh38). Pulls gene + transcript + exon
 * features from the public Ensembl REST API in 1-Mb chunks. CORS-open;
 * uses bare chrom names so chromMap='strip-chr'.
 */
const DEMO_GENES: GeneTrack = {
  id: 'ensembl-grch38-genes',
  kind: 'gene',
  label: 'Ensembl · genes (GRCh38)',
  url: 'https://rest.ensembl.org',
  format: 'ensembl-rest',
  ensemblHost: 'https://rest.ensembl.org',
  chromMap: 'strip-chr',
  visible: true,
};

const DEMO_TRACKS: ReadonlyArray<TrackConfig> = [
  DEMO_REFERENCE,
  DEMO_GENES,
  DEMO_BIGWIG,
  DEMO_BAM_HG38,
  DEMO_BAM,
];

export default function App() {
  useGlobalShortcuts();
  let disposeUrlSync: () => void = () => {};
  let disposeTrackEngine: () => void = () => {};

  onMount(() => {
    disposeUrlSync = startUrlSync();
    disposeTrackEngine = startTrackEngine();

    if (tracks().length === 0) {
      setTracks(DEMO_TRACKS);
      // Seed a small chr20 window with enough 1000G reads + phyloP signal to
      // exercise both pileup + signal renderers on the same viewport.
      // viewport.chrom uses the canonical "chr20"; BAM's chromMap strips it.
      setViewport((v) => ({
        ...v,
        chrom: 'chr20',
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
        <RangeSelectionBar />
        <GenomeView />
      </main>
    </div>
  );
}
