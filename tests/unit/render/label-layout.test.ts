import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock pretext with a deterministic char-width model so we can assert on
// the wrapper's *decision logic* without booting a real Canvas2D context.
// Real measurement is validated via the live preview verification flow.
//
// Char model: every grapheme is 8 px wide, except '…' which is 12 px.
// This keeps assertions arithmetically clean.
const CHAR_PX = 8;
const ELLIPSIS_PX = 12;

vi.mock('@chenglou/pretext', () => {
  function widthOf(text: string): number {
    let w = 0;
    for (const ch of text) w += ch === '…' ? ELLIPSIS_PX : CHAR_PX;
    return w;
  }
  return {
    prepareWithSegments: (text: string, _font: string) => ({
      __mock: true,
      text,
      chars: [...text],
    }),
    measureNaturalWidth: (p: { chars: string[] }) =>
      p.chars.reduce((s, c) => s + (c === '…' ? ELLIPSIS_PX : CHAR_PX), 0),
    layoutNextLineRange: (
      p: { chars: string[] },
      _cursor: { segmentIndex: number; graphemeIndex: number },
      maxWidth: number,
    ) => {
      // Greedy: consume graphemes left-to-right while they still fit.
      let w = 0;
      let n = 0;
      for (let i = 0; i < p.chars.length; i++) {
        const ch = p.chars[i]!;
        const cw = ch === '…' ? ELLIPSIS_PX : CHAR_PX;
        if (w + cw > maxWidth) break;
        w += cw;
        n++;
      }
      if (n === 0) return null;
      return {
        width: w,
        start: { segmentIndex: 0, graphemeIndex: 0 },
        end: { segmentIndex: 0, graphemeIndex: n },
      };
    },
    materializeLineRange: (
      p: { chars: string[] },
      range: { end: { graphemeIndex: number }; width: number },
    ) => ({
      text: p.chars.slice(0, range.end.graphemeIndex).join(''),
      width: range.width,
      start: { segmentIndex: 0, graphemeIndex: 0 },
      end: range.end,
    }),
  };
});

import {
  layoutAnnotationLabel,
  clearLabelCaches,
  labelCacheStats,
} from '~render/labels/label-layout';

const FONT = '500 11px Inter, sans-serif';

describe('layoutAnnotationLabel', () => {
  beforeEach(() => {
    clearLabelCaches();
  });

  it('returns visible:false for empty text', () => {
    const r = layoutAnnotationLabel({ text: '', maxWidth: 200, font: FONT });
    expect(r.visible).toBe(false);
    expect(r.displayText).toBe('');
  });

  it('returns full text when it fits comfortably', () => {
    // "TP53" = 4 chars × 8px = 32 px, usable = 200-8 = 192 px
    const r = layoutAnnotationLabel({ text: 'TP53', maxWidth: 200, font: FONT });
    expect(r.visible).toBe(true);
    expect(r.displayText).toBe('TP53');
    expect(r.truncated).toBe(false);
    expect(r.width).toBe(32);
    expect(r.naturalWidth).toBe(32);
  });

  it('truncates with ellipsis when text exceeds usable space', () => {
    // "ABCDEFGHIJ" = 10 chars × 8 = 80 px. maxWidth=48, paddingX=4 → usable=40
    // ellipsis=12, so layoutNextLineRange gets 40-12=28 → fits 3 chars (24 px)
    // → "ABC…"  total width 24+12 = 36
    const r = layoutAnnotationLabel({
      text: 'ABCDEFGHIJ',
      maxWidth: 48,
      font: FONT,
    });
    expect(r.visible).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.displayText).toBe('ABC…');
    expect(r.width).toBe(36);
    expect(r.naturalWidth).toBe(80);
  });

  it('returns visible:false when even the ellipsis does not fit', () => {
    // usable = maxWidth - 8 (padding) = 10 - 8 = 2. ellipsis=12 > usable
    // → visible:false even though naturalWidth could be computed.
    const r = layoutAnnotationLabel({ text: 'BRCA1', maxWidth: 10, font: FONT });
    expect(r.visible).toBe(false);
    expect(r.displayText).toBe('');
    expect(r.naturalWidth).toBe(40); // 5 chars × 8 px
  });

  it('returns visible:false when usable space is zero or negative', () => {
    const r = layoutAnnotationLabel({ text: 'TP53', maxWidth: 4, font: FONT });
    expect(r.visible).toBe(false);
  });

  it('caches identical (text, font, bucketed-maxWidth) inputs', () => {
    // usable = maxWidth - 8; bucket = round(usable / 4) * 4.
    // 99 → 91 → 92, 100 → 92 → 92, 101 → 93 → 92. All same bucket.
    layoutAnnotationLabel({ text: 'TP53', maxWidth: 99, font: FONT });
    layoutAnnotationLabel({ text: 'TP53', maxWidth: 100, font: FONT });
    layoutAnnotationLabel({ text: 'TP53', maxWidth: 101, font: FONT });
    expect(labelCacheStats().layoutCount).toBe(1);
  });

  it('separates cache entries for different maxWidth buckets', () => {
    layoutAnnotationLabel({ text: 'TP53', maxWidth: 100, font: FONT });
    layoutAnnotationLabel({ text: 'TP53', maxWidth: 200, font: FONT });
    expect(labelCacheStats().layoutCount).toBe(2);
  });

  it('clearLabelCaches resets all caches', () => {
    layoutAnnotationLabel({ text: 'TP53', maxWidth: 100, font: FONT });
    expect(labelCacheStats().layoutCount).toBeGreaterThan(0);
    expect(labelCacheStats().prepareCount).toBeGreaterThan(0);
    clearLabelCaches();
    expect(labelCacheStats()).toEqual({
      prepareCount: 0,
      layoutCount: 0,
      ellipsisFonts: 0,
    });
  });

  it('reuses prepared handle across maxWidth changes (zoom hot path)', () => {
    layoutAnnotationLabel({ text: 'TP53', maxWidth: 100, font: FONT });
    const after1 = labelCacheStats();
    expect(after1.prepareCount).toBe(1);

    layoutAnnotationLabel({ text: 'TP53', maxWidth: 50, font: FONT });
    layoutAnnotationLabel({ text: 'TP53', maxWidth: 25, font: FONT });
    const after3 = labelCacheStats();
    // prepareWithSegments called once for 'TP53'; ellipsis was prepared too
    // once at the truncation-needed call → 2 prepared entries total.
    expect(after3.prepareCount).toBeLessThanOrEqual(2);
  });
});
