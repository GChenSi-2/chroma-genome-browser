import type { Locus, GenomicCoord } from './types';

/**
 * Locus parser — converts user-typed strings into `Locus` and back.
 *
 * Ownership: agent-ui (L3 state). Pure, dependency-free, used by url-sync
 * and the topbar locus input.
 *
 * Accepted inputs:
 *   - `chr1:1,000,000-2,000,000`  (comma thousands)
 *   - `chr1:1000000-2000000`      (bare digits)
 *   - `chr1:1000000`              (single position → 1bp range)
 *   - `1:1M-2M`                   (bare chrom, M=1e6)
 *   - `chrX:1-1k`                 (k=1e3, case insensitive)
 *   - `MT:1-100`                  (non-numeric chrom names pass through)
 *   - leading/trailing whitespace is trimmed
 *
 * Rejected:
 *   - missing colon
 *   - end < start
 *   - negative numbers
 *   - non-numeric range parts (besides recognized k/m/g suffixes)
 *   - empty chrom
 */

export type ParseLocusResult =
  | { ok: true; locus: Locus }
  | { ok: false; error: string };

/** Decode a positional token like `1`, `1,000`, `1M`, `2.5k` is NOT supported. */
function parsePosition(raw: string): GenomicCoord | null {
  const stripped = raw.replace(/,/g, '').trim();
  if (stripped.length === 0) return null;

  // Suffix: case-insensitive k / m / g.
  const last = stripped[stripped.length - 1]!;
  let multiplier: bigint = 1n;
  let digits = stripped;
  if (/[kmgKMG]/.test(last)) {
    digits = stripped.slice(0, -1);
    switch (last.toLowerCase()) {
      case 'k':
        multiplier = 1_000n;
        break;
      case 'm':
        multiplier = 1_000_000n;
        break;
      case 'g':
        multiplier = 1_000_000_000n;
        break;
    }
  }

  if (digits.length === 0) return null;
  if (!/^\d+$/.test(digits)) return null;

  try {
    return BigInt(digits) * multiplier;
  } catch {
    return null;
  }
}

/**
 * Normalize a chrom token. If input is a bare numeric ("1"-"22"), "X", "Y",
 * or "MT" without a `chr` prefix, prepend `chr`. Otherwise preserve case.
 * (`MT` is the GRCh37/Ensembl mitochondrial name and stays as-is.)
 */
function normalizeChrom(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  if (/^chr/i.test(trimmed)) return trimmed;
  if (/^(\d+|[XY])$/.test(trimmed)) return `chr${trimmed}`;
  return trimmed;
}

export function parseLocus(input: string): ParseLocusResult {
  if (typeof input !== 'string') {
    return { ok: false, error: 'locus must be a string' };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'locus is empty' };
  }

  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) {
    return { ok: false, error: 'locus must contain ":" between chrom and range' };
  }

  const rawChrom = trimmed.slice(0, colonIdx);
  const rangePart = trimmed.slice(colonIdx + 1).trim();
  const chrom = normalizeChrom(rawChrom);
  if (chrom.length === 0) {
    return { ok: false, error: 'chrom is empty' };
  }
  if (rangePart.length === 0) {
    return { ok: false, error: 'range is empty' };
  }

  // Reject negative numbers anywhere in the range.
  if (rangePart.includes('-') === false) {
    // Single-position form: `chr1:1000000`.
    const pos = parsePosition(rangePart);
    if (pos === null) {
      return { ok: false, error: `invalid position "${rangePart}"` };
    }
    return { ok: true, locus: { chrom, start: pos, end: pos + 1n } };
  }

  // Split on the first hyphen — but it must not be at position 0 (would be negative).
  if (rangePart.startsWith('-')) {
    return { ok: false, error: 'start position cannot be negative' };
  }
  const dashIdx = rangePart.indexOf('-');
  const startRaw = rangePart.slice(0, dashIdx);
  const endRaw = rangePart.slice(dashIdx + 1);
  if (endRaw.startsWith('-')) {
    return { ok: false, error: 'end position cannot be negative' };
  }
  if (endRaw.length === 0) {
    return { ok: false, error: 'end position missing' };
  }

  const start = parsePosition(startRaw);
  if (start === null) {
    return { ok: false, error: `invalid start "${startRaw}"` };
  }
  const end = parsePosition(endRaw);
  if (end === null) {
    return { ok: false, error: `invalid end "${endRaw}"` };
  }
  if (end < start) {
    return { ok: false, error: `end (${end}) is before start (${start})` };
  }

  return { ok: true, locus: { chrom, start, end } };
}

/** Format a `Locus` to the canonical `chrom:start-end` with comma thousands. */
export function formatLocus(locus: Locus): string {
  return `${locus.chrom}:${locus.start.toLocaleString('en-US')}-${locus.end.toLocaleString('en-US')}`;
}
