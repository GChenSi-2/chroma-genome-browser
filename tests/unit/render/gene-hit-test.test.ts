import { describe, it, expect } from 'vitest';
import { hitTestGene } from '~render/hit-test/gene-hit-test';
import type {
  GeneFeature,
  GeneTile,
  TileKey,
  TileStatus,
  TrackConfig,
  Viewport,
} from '~state/types';

const VIEWPORT: Viewport = {
  chrom: 'chr20',
  start: 1_000_000n,
  end: 1_100_000n,        // 100 kb span
  pxWidth: 1000,           // 10 bp / px
  pxHeight: 600,
};

const GENE_TRACK: TrackConfig = {
  id: 'genes',
  kind: 'gene',
  label: 'Genes',
  url: 'x',
  visible: true,
};

function makeTile(features: GeneFeature[]): GeneTile {
  return {
    key: 'genes:chr20:1024:1000000:0',
    trackId: 'genes',
    chrom: 'chr20',
    binSize: 1024,
    binIndex: 0,
    start: 1_000_000n,
    end: 1_100_000n,
    payload: 'gene',
    features,
  };
}

function makeSnapshot(tile: GeneTile): ReadonlyMap<TileKey, TileStatus> {
  return new Map<TileKey, TileStatus>([[tile.key, { state: 'ready', tile }]]);
}

const TP53: GeneFeature = {
  id: 'ENSG_TP53',
  name: 'TP53',
  type: 'gene',
  start: 1_010_000n,        // x ≈ 100 px
  end: 1_020_000n,          // x ≈ 200 px
  strand: 1,
  parentId: null,
  biotype: 'protein_coding',
};
const TP53_TX: GeneFeature = {
  id: 'ENST_TP53_1',
  name: 'TP53-201',
  type: 'transcript',
  start: 1_010_000n,
  end: 1_020_000n,
  strand: 1,
  parentId: 'ENSG_TP53',
};
const TP53_EXON: GeneFeature = {
  id: 'EXON_TP53_1',
  name: '',
  type: 'exon',
  start: 1_012_000n,        // x ≈ 120 px
  end: 1_015_000n,          // x ≈ 150 px
  strand: 1,
  parentId: 'ENST_TP53_1',
};

describe('hitTestGene', () => {
  it('returns null when pointer is outside any track band', () => {
    const tile = makeTile([TP53]);
    const hit = hitTestGene(
      { px: 150, py: 1 }, // py=1 lands above TOP_PAD=16 minus padding → outside the gene band
      VIEWPORT,
      [GENE_TRACK],
      makeSnapshot(tile),
    );
    expect(hit).toBeNull();
  });

  it('hits a gene-only feature at its row centre', () => {
    const tile = makeTile([TP53]);
    // Gene track is the first visible track; yTopPx = TOP_PAD_PX = 16,
    // bandHeight = 90. Single feature → 1 row → rowHeight = 90.
    const hit = hitTestGene(
      { px: 150, py: 16 + 45 },
      VIEWPORT,
      [GENE_TRACK],
      makeSnapshot(tile),
    );
    expect(hit).not.toBeNull();
    expect(hit!.feature.id).toBe('ENSG_TP53');
    expect(hit!.gene.id).toBe('ENSG_TP53');
  });

  it('prefers exon over transcript over gene at the same point', () => {
    const tile = makeTile([TP53, TP53_TX, TP53_EXON]);
    // px 135 lands inside the exon (120–150) AND the transcript backbone
    // AND the gene tint. Exon should win.
    const hit = hitTestGene(
      { px: 135, py: 16 + 45 },
      VIEWPORT,
      [GENE_TRACK],
      makeSnapshot(tile),
    );
    expect(hit).not.toBeNull();
    expect(hit!.feature.type).toBe('exon');
    // Tooltip still wants the gene info.
    expect(hit!.gene.id).toBe('ENSG_TP53');
    expect(hit!.gene.name).toBe('TP53');
  });

  it('returns the parent gene when hitting a transcript backbone', () => {
    const tile = makeTile([TP53, TP53_TX]);
    // px=180 is inside the gene+transcript at x≈100-200 but outside any exon.
    const hit = hitTestGene(
      { px: 180, py: 16 + 45 },
      VIEWPORT,
      [GENE_TRACK],
      makeSnapshot(tile),
    );
    expect(hit).not.toBeNull();
    // Transcript box is (0.45, 0.55) of row → only a narrow vertical band
    // at the row's vertical centre. y=45 ≈ row centre → backbone hit.
    expect(hit!.feature.type === 'transcript' || hit!.feature.type === 'gene').toBe(true);
    expect(hit!.gene.id).toBe('ENSG_TP53');
  });

  it('returns null when pointer is in the gene band but outside any feature', () => {
    const tile = makeTile([TP53]);
    // px=400 ≈ 1_040_000 bp — past TP53.end.
    const hit = hitTestGene(
      { px: 400, py: 16 + 45 },
      VIEWPORT,
      [GENE_TRACK],
      makeSnapshot(tile),
    );
    expect(hit).toBeNull();
  });

  it('skips invisible tracks when laying out bands', () => {
    const hiddenGene: TrackConfig = { ...GENE_TRACK, visible: false };
    const tile = makeTile([TP53]);
    const hit = hitTestGene(
      { px: 150, py: 16 + 45 },
      VIEWPORT,
      [hiddenGene],
      makeSnapshot(tile),
    );
    // No visible gene band → no hit possible.
    expect(hit).toBeNull();
  });

  it('rect width is at least 1 px even for sub-pixel features', () => {
    // 1-bp feature at viewport pxPerBp=0.01 → width 0.01 px raw.
    const tiny: GeneFeature = {
      id: 'tiny',
      name: 't',
      type: 'gene',
      start: 1_050_000n,    // x ≈ 500
      end: 1_050_001n,      // x ≈ 500.01
      strand: 0,
      parentId: null,
    };
    const tile = makeTile([tiny]);
    const hit = hitTestGene(
      { px: 500, py: 16 + 45 },
      VIEWPORT,
      [GENE_TRACK],
      makeSnapshot(tile),
    );
    expect(hit).not.toBeNull();
    expect(hit!.rectPx.width).toBeGreaterThanOrEqual(1);
  });
});
