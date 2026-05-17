import { describe, it, expect } from 'vitest';
import { hitTestVariant } from '~render/hit-test/variant-hit-test';
import type {
  TileKey,
  TileStatus,
  TrackConfig,
  VariantTile,
  Viewport,
} from '~state/types';

const VIEWPORT: Viewport = {
  chrom: 'chr20',
  start: 1_000_000n,
  end: 1_001_000n, // 1 kb span → 1 px/bp at 1000 px wide
  pxWidth: 1000,
  pxHeight: 600,
};

const VCF_TRACK: TrackConfig = {
  id: 'vcf',
  kind: 'vcf',
  label: 'VCF',
  url: 'x.vcf.gz',
  indexUrl: 'x.vcf.gz.tbi',
  visible: true,
};

function makeTile(args: {
  positions: number[];
  types: number[];
  refs: string[];
  alts: string[];
  quals: number[];
}): VariantTile {
  const n = args.positions.length;
  const positions = new Int32Array(n);
  const positionsHi = new Int32Array(n);
  const types = new Uint8Array(n);
  const refStringIdx = new Uint32Array(n);
  const altStringIdx = new Uint32Array(n);
  const quals = new Float32Array(n);
  const stringPool: string[] = [];
  const intern = (s: string): number => {
    let i = stringPool.indexOf(s);
    if (i < 0) { i = stringPool.length; stringPool.push(s); }
    return i;
  };
  for (let i = 0; i < n; i++) {
    positions[i] = args.positions[i]!;
    types[i] = args.types[i]!;
    refStringIdx[i] = intern(args.refs[i]!);
    altStringIdx[i] = intern(args.alts[i]!);
    quals[i] = args.quals[i]!;
  }
  return {
    key: 'vcf:chr20:1024:1000000:0',
    trackId: 'vcf',
    chrom: 'chr20',
    binSize: 1024,
    binIndex: 0,
    start: 1_000_000n,
    end: 1_001_000n,
    payload: 'variants',
    count: n,
    positions,
    positionsHi,
    types,
    refStringIdx,
    altStringIdx,
    quals,
    strings: stringPool,
  };
}

function snap(tile: VariantTile): ReadonlyMap<TileKey, TileStatus> {
  return new Map<TileKey, TileStatus>([[tile.key, { state: 'ready', tile }]]);
}

describe('hitTestVariant', () => {
  it('hits the SNV closest to the click x', () => {
    // 3 SNVs in viewport; click on the middle one.
    const tile = makeTile({
      positions: [1_000_100, 1_000_500, 1_000_800],
      types: [0, 0, 0],
      refs: ['A', 'C', 'G'],
      alts: ['T', 'A', 'T'],
      quals: [99, 88, 77],
    });
    // viewport.start=1_000_000, pxPerBp = 1000 / 1000 = 1
    // px = 500 → bp 1_000_500 → middle SNV.
    // Gene band height in track-layout: bam=200, but VCF=28 — and the
    // gene band Y starts at TOP_PAD=16 + ... actually VCF is the only
    // visible track here so its band starts at TOP_PAD=16.
    // py within VCF band (16..16+28).
    const hit = hitTestVariant({ px: 500, py: 20 }, VIEWPORT, [VCF_TRACK], snap(tile));
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('variant');
    expect(hit!.variant.pos).toBe(1_000_500n);
    expect(hit!.variant.ref).toBe('C');
    expect(hit!.variant.alt).toBe('A');
    expect(hit!.variant.type).toBe('snv');
  });

  it('returns null when py is outside the VCF band', () => {
    const tile = makeTile({
      positions: [1_000_500],
      types: [0],
      refs: ['A'],
      alts: ['T'],
      quals: [99],
    });
    const hit = hitTestVariant({ px: 500, py: 100 }, VIEWPORT, [VCF_TRACK], snap(tile));
    expect(hit).toBeNull();
  });

  it('returns null when px is far from any variant', () => {
    const tile = makeTile({
      positions: [1_000_100],
      types: [0],
      refs: ['A'],
      alts: ['T'],
      quals: [99],
    });
    // px=500 → bp 1_000_500, far from 1_000_100.
    const hit = hitTestVariant({ px: 500, py: 20 }, VIEWPORT, [VCF_TRACK], snap(tile));
    expect(hit).toBeNull();
  });

  it('decodes variant kind from numeric type code', () => {
    const tile = makeTile({
      positions: [1_000_200, 1_000_400, 1_000_600, 1_000_800],
      types: [1, 2, 3, 4],
      refs: ['A', 'AT', 'CC', 'A'],
      alts: ['AT', 'A', 'GG', '<DEL>'],
      quals: [10, 10, 10, 10],
    });
    const hitIns = hitTestVariant({ px: 200, py: 20 }, VIEWPORT, [VCF_TRACK], snap(tile));
    const hitDel = hitTestVariant({ px: 400, py: 20 }, VIEWPORT, [VCF_TRACK], snap(tile));
    const hitMnv = hitTestVariant({ px: 600, py: 20 }, VIEWPORT, [VCF_TRACK], snap(tile));
    const hitSv  = hitTestVariant({ px: 800, py: 20 }, VIEWPORT, [VCF_TRACK], snap(tile));
    expect(hitIns?.variant.type).toBe('ins');
    expect(hitDel?.variant.type).toBe('del');
    expect(hitMnv?.variant.type).toBe('mnv');
    expect(hitSv?.variant.type).toBe('sv');
  });

  it('skips invisible tracks', () => {
    const hidden: TrackConfig = { ...VCF_TRACK, visible: false };
    const tile = makeTile({
      positions: [1_000_500],
      types: [0],
      refs: ['A'],
      alts: ['T'],
      quals: [99],
    });
    const hit = hitTestVariant({ px: 500, py: 20 }, VIEWPORT, [hidden], snap(tile));
    expect(hit).toBeNull();
  });
});
