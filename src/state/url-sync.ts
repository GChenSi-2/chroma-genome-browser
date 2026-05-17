import { createEffect, createRoot, on } from 'solid-js';
import { viewport, setViewport } from './viewport';
import { tracks, setTracks } from './tracks';
import { formatLocus, parseLocus } from './locus-parser';
import type { TrackConfig, TrackKind } from './types';

/**
 * URL ↔ state bidirectional sync — ARCHITECTURE §4.3.
 *
 *   hash  → viewport (chrom:start-end)
 *   query → tracks   (?t=base64(JSON(tracks)))
 *
 * Write side uses `history.replaceState` (no history pollution) and is
 * debounced (100ms viewport / 200ms tracks). Read side fires on mount and
 * on `hashchange` (back/forward navigation).
 *
 * Ownership: agent-ui. Pure module — no imports outside ./.
 */

const VIEWPORT_DEBOUNCE_MS = 100;
const TRACKS_DEBOUNCE_MS = 200;

const TRACK_KINDS: ReadonlySet<TrackKind> = new Set<TrackKind>([
  'reference',
  'bam',
  'bigwig',
  'vcf',
  'gene',
  'bed',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Track config validation
// ─────────────────────────────────────────────────────────────────────────────

function isTrackConfig(value: unknown): value is TrackConfig {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj['id'] !== 'string') return false;
  if (typeof obj['kind'] !== 'string') return false;
  if (!TRACK_KINDS.has(obj['kind'] as TrackKind)) return false;
  if (typeof obj['label'] !== 'string') return false;
  if (typeof obj['url'] !== 'string') return false;
  if (typeof obj['visible'] !== 'boolean') return false;
  return true;
}

/** True iff any of the track's referenced URLs is a `blob:` URL. Such
 *  tracks are local-file-backed via URL.createObjectURL and therefore
 *  not shareable across documents — `url-sync` skips them when writing
 *  the `?t=…` query. */
function isBlobBacked(t: TrackConfig): boolean {
  if (t.url.startsWith('blob:')) return true;
  if (t.kind === 'bam' && t.indexUrl?.startsWith('blob:')) return true;
  if (t.kind === 'reference' && t.faiUrl?.startsWith('blob:')) return true;
  return false;
}

function parseTracksFromQuery(search: string): ReadonlyArray<TrackConfig> | null {
  // Strip leading '?' if present.
  const qs = search.startsWith('?') ? search.slice(1) : search;
  if (qs.length === 0) return null;

  // Find `t=` parameter.
  const params = qs.split('&');
  let tParam: string | null = null;
  for (const p of params) {
    if (p.startsWith('t=')) {
      tParam = p.slice(2);
      break;
    }
  }
  if (tParam === null) return null;

  try {
    const decoded = decodeURIComponent(tParam);
    const json = atob(decoded);
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    const validated: TrackConfig[] = [];
    for (const item of parsed) {
      if (!isTrackConfig(item)) return null;
      validated.push(item);
    }
    return validated;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hash <-> viewport helpers
// ─────────────────────────────────────────────────────────────────────────────

function readHashLocus(): { chrom: string; start: bigint; end: bigint } | null {
  const raw = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (raw.length === 0) return null;
  const result = parseLocus(decodeURIComponent(raw));
  return result.ok ? result.locus : null;
}

function buildUrl(viewportHash: string, tracksQuery: string): string {
  const { pathname } = window.location;
  return `${pathname}${tracksQuery}${viewportHash}`;
}

function currentUrlSuffix(): string {
  return `${window.location.search}${window.location.hash}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start URL ↔ state synchronisation. Idempotent in the sense that calling
 * the returned disposer cleans up listeners and pending writes; calling
 * `startUrlSync` again creates a fresh subscription.
 */
export function startUrlSync(): () => void {
  // ── Initial read from URL ──────────────────────────────────────────────
  const initialLocus = readHashLocus();
  if (initialLocus !== null) {
    const current = viewport();
    setViewport({
      chrom: initialLocus.chrom,
      start: initialLocus.start,
      end: initialLocus.end,
      pxWidth: current.pxWidth,
      pxHeight: current.pxHeight,
    });
  }

  const initialTracks = parseTracksFromQuery(window.location.search);
  if (initialTracks !== null) {
    setTracks(initialTracks);
  }

  // ── Debounce state ──────────────────────────────────────────────────────
  let viewportTimer: ReturnType<typeof setTimeout> | null = null;
  let tracksTimer: ReturnType<typeof setTimeout> | null = null;

  function writeUrl(): void {
    const v = viewport();
    const hash = '#' + formatLocus({ chrom: v.chrom, start: v.start, end: v.end });
    // Strip `blob:` tracks — they're document-scoped (created via
    // URL.createObjectURL) so the URL string isn't valid for anyone but
    // this tab in this session. Sharing the link with a blob: track
    // baked in would dump an unloadable config on the recipient.
    const tList = tracks().filter((t) => !isBlobBacked(t));
    const tracksQuery =
      tList.length > 0 ? `?t=${encodeURIComponent(btoa(JSON.stringify(tList)))}` : '';
    const next = `${tracksQuery}${hash}`;
    if (next === currentUrlSuffix()) return;
    history.replaceState(null, '', buildUrl(hash, tracksQuery));
  }

  // ── Subscribe to viewport / tracks signals via effects ──────────────────
  const dispose = createRoot((disposeRoot) => {
    // `on(..., { defer: true })` skips the initial run, so the very first
    // read from URL above doesn't trigger an immediate write-back.
    createEffect(
      on(
        viewport,
        () => {
          if (viewportTimer !== null) clearTimeout(viewportTimer);
          viewportTimer = setTimeout(() => {
            viewportTimer = null;
            writeUrl();
          }, VIEWPORT_DEBOUNCE_MS);
        },
        { defer: true },
      ),
    );
    createEffect(
      on(
        tracks,
        () => {
          if (tracksTimer !== null) clearTimeout(tracksTimer);
          tracksTimer = setTimeout(() => {
            tracksTimer = null;
            writeUrl();
          }, TRACKS_DEBOUNCE_MS);
        },
        { defer: true },
      ),
    );
    return disposeRoot;
  });

  // ── hashchange listener (back/forward navigation) ───────────────────────
  function onHashChange(): void {
    const locus = readHashLocus();
    if (locus === null) return;
    const current = viewport();
    if (
      current.chrom === locus.chrom &&
      current.start === locus.start &&
      current.end === locus.end
    ) {
      return;
    }
    setViewport({
      chrom: locus.chrom,
      start: locus.start,
      end: locus.end,
      pxWidth: current.pxWidth,
      pxHeight: current.pxHeight,
    });
  }
  window.addEventListener('hashchange', onHashChange);

  // ── Disposer ────────────────────────────────────────────────────────────
  return () => {
    window.removeEventListener('hashchange', onHashChange);
    if (viewportTimer !== null) {
      clearTimeout(viewportTimer);
      viewportTimer = null;
    }
    if (tracksTimer !== null) {
      clearTimeout(tracksTimer);
      tracksTimer = null;
    }
    dispose();
  };
}
