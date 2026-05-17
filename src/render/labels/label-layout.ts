/**
 * Annotation label layout — single-line, shrink-wrap-with-ellipsis.
 *
 * Built on @chenglou/pretext for unicode-correct measurement: short gene
 * symbols are usually ASCII, but transcript IDs and clinical labels can
 * include emoji or non-Latin characters where naïve string slicing would
 * cut a grapheme in half (`measureText` on a half-grapheme returns a
 * width that doesn't match what `fillText` will actually draw).
 *
 * Two-layer caching:
 *
 *   prepareCache  — keeps the opaque pretext `PreparedTextWithSegments`
 *                   handle per (text, font). pretext does one-time bidi /
 *                   segmentation / canvas-measureText work here; we never
 *                   want to re-run it for the same string.
 *   layoutCache   — full `LabelLayoutResult` per (text, font, maxWidthBucket).
 *                   `maxWidthBucket` rounds to MAXWIDTH_QUANTUM_PX so a
 *                   pan that nudges screen widths by a sub-pixel doesn't
 *                   bust the cache; zoom (which changes basePixelWidth
 *                   meaningfully) does.
 *
 * Both caches are LRU-bounded so a long-running tab on a busy genome
 * doesn't grow without bound.
 */

import {
  prepareWithSegments,
  layoutNextLineRange,
  materializeLineRange,
  measureNaturalWidth,
  type PreparedTextWithSegments,
  type LayoutCursor,
} from '@chenglou/pretext';

export interface LabelLayoutInput {
  /** Display string. Empty string ⇒ `visible:false`. */
  text: string;
  /** Maximum pixel width the label may occupy on screen, INCLUDING
   *  `paddingX*2` of breathing room from the annotation block edges. */
  maxWidth: number;
  /** Canvas `font` shorthand — must match the font we'll later call
   *  `ctx.fillText` with. e.g. `"500 11px Inter, sans-serif"`. */
  font: string;
  /** Horizontal breathing room reserved per side. Default 4 px. */
  paddingX?: number;
}

export interface LabelLayoutResult {
  /** True when the label has something to draw. False when the block is
   *  too narrow for any glyph (not even an ellipsis), or the text is empty. */
  visible: boolean;
  /** Final string to draw — may end with `…` if truncated. */
  displayText: string;
  /** Pixel width of `displayText` at the configured font. */
  width: number;
  /** Natural width of the full input `text` at the configured font.
   *  Useful for hover / tooltip code that wants to know "would this fit
   *  if I gave it more room?" without re-measuring. */
  naturalWidth: number;
  /** True when `displayText !== text`. */
  truncated: boolean;
}

// ── Tunables ───────────────────────────────────────────────────────────────

/** Bucket maxWidth to this many CSS px before forming the cache key. With
 *  a 4 px bucket, sub-pixel viewport jitter never busts the cache; an
 *  actual zoom (which shifts pxPerBp by >> 4 px for most features) always
 *  re-keys. */
const MAXWIDTH_QUANTUM_PX = 4;

const PREPARE_CACHE_CAP = 1024;
const LAYOUT_CACHE_CAP = 4096;
const ELLIPSIS = '…';

// ── Caches (module-scoped singletons) ─────────────────────────────────────

const preparedCache = new Map<string, PreparedTextWithSegments>();
const ellipsisWidthCache = new Map<string, number>();
const layoutCache = new Map<string, LabelLayoutResult>();

function lruTouch<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > cap) {
    // Map iteration is insertion order; first key is the oldest.
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}

function getPrepared(text: string, font: string): PreparedTextWithSegments {
  const key = `${font}\x00${text}`;
  const hit = preparedCache.get(key);
  if (hit) {
    lruTouch(preparedCache, key, hit, PREPARE_CACHE_CAP);
    return hit;
  }
  const prepared = prepareWithSegments(text, font);
  lruTouch(preparedCache, key, prepared, PREPARE_CACHE_CAP);
  return prepared;
}

function getEllipsisWidth(font: string): number {
  const hit = ellipsisWidthCache.get(font);
  if (hit !== undefined) return hit;
  const p = prepareWithSegments(ELLIPSIS, font);
  const w = measureNaturalWidth(p);
  ellipsisWidthCache.set(font, w);
  return w;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Lay out a single-line annotation label. Returns immediately from cache
 * on repeat calls with the same (text, font, bucketed-maxWidth).
 */
export function layoutAnnotationLabel(input: LabelLayoutInput): LabelLayoutResult {
  const { text, font } = input;
  const paddingX = input.paddingX ?? 4;
  const usable = input.maxWidth - paddingX * 2;
  const bucket = Math.max(0, Math.round(usable / MAXWIDTH_QUANTUM_PX) * MAXWIDTH_QUANTUM_PX);

  if (text === '') {
    return { visible: false, displayText: '', width: 0, naturalWidth: 0, truncated: false };
  }

  const cacheKey = `${font}\x00${bucket}\x00${text}`;
  const cached = layoutCache.get(cacheKey);
  if (cached !== undefined) {
    lruTouch(layoutCache, cacheKey, cached, LAYOUT_CACHE_CAP);
    return cached;
  }

  const result = computeLayout(text, font, bucket);
  lruTouch(layoutCache, cacheKey, result, LAYOUT_CACHE_CAP);
  return result;
}

function computeLayout(text: string, font: string, usable: number): LabelLayoutResult {
  const prepared = getPrepared(text, font);
  const natural = measureNaturalWidth(prepared);

  // Fast path: full text fits.
  if (natural <= usable) {
    return {
      visible: true,
      displayText: text,
      width: natural,
      naturalWidth: natural,
      truncated: false,
    };
  }

  // Truncation path: reserve room for the ellipsis glyph, then ask pretext
  // for the longest grapheme range that fits in the remaining space.
  const ellipsisWidth = getEllipsisWidth(font);
  if (ellipsisWidth >= usable) {
    return {
      visible: false,
      displayText: '',
      width: 0,
      naturalWidth: natural,
      truncated: false,
    };
  }

  const cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 };
  const range = layoutNextLineRange(prepared, cursor, usable - ellipsisWidth);
  if (range === null) {
    return {
      visible: false,
      displayText: '',
      width: 0,
      naturalWidth: natural,
      truncated: false,
    };
  }

  const line = materializeLineRange(prepared, range);
  // pretext may keep trailing whitespace at a line break; strip it before
  // concatenating the ellipsis so we don't print "BRCA1 …".
  const trimmedText = line.text.replace(/\s+$/, '');
  if (trimmedText === '') {
    return {
      visible: false,
      displayText: '',
      width: 0,
      naturalWidth: natural,
      truncated: false,
    };
  }

  // line.width already excludes the trimmed trailing whitespace's break
  // width but may overstate slightly if we trimmed graphemes; recomputing
  // by preparing the trimmed string is overkill — the visual error is
  // sub-pixel and the cache key already buckets at 4 px.
  return {
    visible: true,
    displayText: trimmedText + ELLIPSIS,
    width: line.width + ellipsisWidth,
    naturalWidth: natural,
    truncated: true,
  };
}

/**
 * Test / dev helper: drop all cached layouts. Useful after font changes,
 * theme toggles, or when measuring "cold" cache cost in benchmarks.
 */
export function clearLabelCaches(): void {
  preparedCache.clear();
  ellipsisWidthCache.clear();
  layoutCache.clear();
}

/** Diagnostic. Test helper, not for hot-path consumption. */
export function labelCacheStats(): {
  prepareCount: number;
  layoutCount: number;
  ellipsisFonts: number;
} {
  return {
    prepareCount: preparedCache.size,
    layoutCount: layoutCache.size,
    ellipsisFonts: ellipsisWidthCache.size,
  };
}
