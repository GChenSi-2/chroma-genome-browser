/**
 * Ensembl REST API — gene/transcript/exon overlap fetcher.
 *
 * Why this lives outside the worker pool:
 *   - Annotation responses are JSON (small, ~few hundred KB at most)
 *   - No binary parsing — `await res.json()` is enough
 *   - Each chrom has ~thousand-feature density, so fetching is bursty,
 *     not sustained. Spinning up a Comlink RPC roundtrip per request
 *     adds more overhead than the parse itself
 *
 * Ensembl publishes GRCh38 by default. For hg19 builds, the host is
 * `grch37.rest.ensembl.org`. We expose `host` per-track so the same
 * dispatcher works for both.
 *
 * Endpoint:
 *   GET https://{host}/overlap/region/human/{chrom}:{start}-{end}
 *       ?feature=gene&feature=transcript&feature=exon
 *
 * Returns an array of feature objects with `feature_type`, `start`,
 * `end`, `strand`, `id`, `external_name`/`Name`, `Parent`, `biotype`.
 * Chrom is bare ("20"), no "chr" prefix.
 */

import type { GeneFeature, GeneFeatureType, GenomicCoord } from '~state/types';

export interface EnsemblGeneRequest {
  /** API host. Default `https://rest.ensembl.org` for GRCh38. */
  host: string;
  /** Bare chrom name expected by Ensembl ("20", not "chr20"). */
  chrom: string;
  /** 0-based start (Ensembl is 1-based — we shift on send). */
  start: number;
  /** 0-based exclusive end. */
  end: number;
  signal?: AbortSignal;
}

interface EnsemblFeatureRaw {
  feature_type: string;
  start: number;
  end: number;
  strand?: number;
  id?: string;
  external_name?: string;
  Name?: string;
  Parent?: string | string[];
  biotype?: string;
}

function strandFromEnsembl(raw: unknown): -1 | 0 | 1 {
  if (raw === 1) return 1;
  if (raw === -1) return -1;
  return 0;
}

function parentFromEnsembl(raw: EnsemblFeatureRaw): string | null {
  const p = raw.Parent;
  if (!p) return null;
  if (typeof p === 'string') return p;
  if (Array.isArray(p) && p.length > 0 && typeof p[0] === 'string') return p[0];
  return null;
}

function featureTypeFromEnsembl(raw: string): GeneFeatureType | null {
  // Ensembl returns lowercased types: 'gene', 'transcript', 'exon', 'cds',
  // 'five_prime_UTR', 'three_prime_UTR'. Only the three we care about.
  if (raw === 'gene') return 'gene';
  if (raw === 'transcript') return 'transcript';
  if (raw === 'exon') return 'exon';
  return null;
}

/**
 * Fetch and shape Ensembl features into `GeneFeature[]` for the requested
 * region. Throws AbortError if the signal aborts.
 *
 * Behaviour notes:
 *   - Ensembl uses 1-based inclusive coords; we shift the URL by +1 / +0
 *     so a (0-based start, exclusive end) request maps cleanly.
 *   - For 'exon' the Ensembl ID is in `id`; the parent transcript ID is
 *     in `Parent`. For 'transcript' the parent gene is in `Parent`. For
 *     'gene' there is no parent.
 *   - Result is sorted by start so the renderer can binary-search.
 */
export async function fetchEnsemblGenes(
  req: EnsemblGeneRequest,
): Promise<GeneFeature[]> {
  const base = req.host.replace(/\/$/, '');
  const start1Based = req.start + 1;
  const endInclusive = req.end;
  const url =
    `${base}/overlap/region/human/${req.chrom}:${start1Based}-${endInclusive}` +
    `?feature=gene;feature=transcript;feature=exon`;

  const init: RequestInit = { headers: { Accept: 'application/json' } };
  if (req.signal !== undefined) init.signal = req.signal;
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`Ensembl ${res.status} ${res.statusText} (${url})`);
  }
  const raw = (await res.json()) as EnsemblFeatureRaw[];

  const out: GeneFeature[] = [];
  for (const r of raw) {
    const type = featureTypeFromEnsembl(r.feature_type);
    if (!type) continue;
    if (typeof r.start !== 'number' || typeof r.end !== 'number') continue;
    const id = r.id ?? r.external_name ?? '';
    if (id === '') continue;
    out.push({
      id,
      name: r.external_name ?? r.Name ?? id,
      type,
      // Ensembl is 1-based inclusive. Shift to our 0-based half-open.
      start: BigInt(r.start - 1) as GenomicCoord,
      end: BigInt(r.end) as GenomicCoord,
      strand: strandFromEnsembl(r.strand),
      parentId: parentFromEnsembl(r),
      ...(r.biotype !== undefined ? { biotype: r.biotype } : {}),
    });
  }
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return out;
}
