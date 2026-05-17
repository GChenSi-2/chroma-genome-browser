/**
 * Active assembly — the chromosome-length lookup the navigator and clamp
 * math derive from.
 *
 * Source of truth precedence (highest wins):
 *   1. A reference FASTA track's `.fai` index, loaded via
 *      `loadReferenceAssembly()` at boot or when a reference track is
 *      added.
 *   2. The built-in hg19 fallback below — keeps the overview bar honest
 *      before the .fai arrives, matches the demo's hg19 stack.
 *
 * Why a reactive signal: the overview bar's ticks and the `contextRange`
 * adaptation both reach into chromLength() inside `createMemo` /
 * `createEffect`, so they automatically re-derive when a new reference is
 * loaded. Single source of truth, no per-component refresh hooks.
 */

import { createSignal } from 'solid-js';

export interface ChromLengths {
  /** chrom name → length in bp. Names canonicalised to start with `chr*`. */
  byChrom: ReadonlyMap<string, bigint>;
  /** Human-readable provenance — shown in dev tools / future UI badge. */
  label: string;
}

const FALLBACK_LENGTH = 250_000_000n;

/** hg19 / GRCh37 chromInfo (UCSC). Used until a reference's .fai overrides. */
const HG19_FALLBACK: ChromLengths = {
  label: 'hg19 (built-in fallback)',
  byChrom: new Map<string, bigint>([
    ['chr1', 249_250_621n],
    ['chr2', 243_199_373n],
    ['chr3', 198_022_430n],
    ['chr4', 191_154_276n],
    ['chr5', 180_915_260n],
    ['chr6', 171_115_067n],
    ['chr7', 159_138_663n],
    ['chr8', 146_364_022n],
    ['chr9', 141_213_431n],
    ['chr10', 135_534_747n],
    ['chr11', 135_006_516n],
    ['chr12', 133_851_895n],
    ['chr13', 115_169_878n],
    ['chr14', 107_349_540n],
    ['chr15', 102_531_392n],
    ['chr16', 90_354_753n],
    ['chr17', 81_195_210n],
    ['chr18', 78_077_248n],
    ['chr19', 59_128_983n],
    ['chr20', 63_025_520n],
    ['chr21', 48_129_895n],
    ['chr22', 51_304_566n],
    ['chrX', 155_270_560n],
    ['chrY', 59_373_566n],
    ['chrM', 16_571n],
  ]),
};

const [activeAssembly, setActiveAssembly_] = createSignal<ChromLengths>(HG19_FALLBACK, {
  equals: (a, b) => a === b,
});

export { activeAssembly };

/** Test / internal helper. Use `loadReferenceAssembly` from app code. */
export function _setActiveAssembly(value: ChromLengths): void {
  setActiveAssembly_(value);
}

function chromKey(chrom: string): string {
  return chrom.startsWith('chr') ? chrom : `chr${chrom}`;
}

/** Length lookup with chrN ↔ N normalisation and a defensive fallback. */
export function chromLength(chrom: string): bigint {
  return activeAssembly().byChrom.get(chromKey(chrom)) ?? FALLBACK_LENGTH;
}

// ── Reference .fai loader ──────────────────────────────────────────────────

/** Parse a `.fai` index payload. Each line is
 *  `<name>\t<length>\t<offset>\t<linebases>\t<linewidth>` — we only need
 *  the first two columns. Tolerant of trailing blanks and CRLF. */
export function parseFaiLengths(text: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const rawLine of text.split('\n')) {
    // Only strip a trailing CR (Windows line endings). Don't trim leading
    // whitespace — a line that opens with `\t` has a structurally empty
    // name field and should be rejected, not silently realigned.
    const line = rawLine.replace(/\r$/, '');
    if (line === '') continue;
    const cols = line.split('\t');
    if (cols.length < 2) continue;
    const name = cols[0];
    const lenStr = cols[1];
    if (!name || !lenStr) continue;
    let len: bigint;
    try {
      len = BigInt(lenStr.trim());
    } catch {
      continue;
    }
    if (len <= 0n) continue;
    out.set(name, len);
  }
  return out;
}

const inflightFai = new Set<string>();
const loadedFai = new Set<string>();

/**
 * Fetch + parse `faiUrl`, install the resulting chrom→length map as the
 * active assembly. Idempotent per URL.
 *
 * The `.fai` text is small (~3 kB even for a full hg19 chromInfo) so we
 * fetch from the main thread — no need to involve the parser worker. The
 * Broad S3 mirror serves with CORS open.
 */
export async function loadReferenceAssembly(
  faiUrl: string,
  label: string,
): Promise<ChromLengths | null> {
  if (loadedFai.has(faiUrl) || inflightFai.has(faiUrl)) return null;
  inflightFai.add(faiUrl);
  try {
    const res = await fetch(faiUrl);
    if (!res.ok) {
      throw new Error(`fetch ${faiUrl} failed: ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    const byChrom = parseFaiLengths(text);
    if (byChrom.size === 0) return null;
    const next: ChromLengths = { byChrom, label };
    setActiveAssembly_(next);
    loadedFai.add(faiUrl);
    return next;
  } finally {
    inflightFai.delete(faiUrl);
  }
}

/** Test helper: drop in-memory dedup state so unit tests can re-load. */
export function _resetAssemblyLoadState(): void {
  inflightFai.clear();
  loadedFai.clear();
}
