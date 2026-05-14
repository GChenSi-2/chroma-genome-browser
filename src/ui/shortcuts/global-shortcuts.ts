import { onCleanup, onMount } from 'solid-js';
import { toggleTheme } from '~state/theme';
import { setViewport } from '~state/viewport';
import { panBy, zoomBy, jumpTo } from '~state/viewport-actions';
import { setTracks, tracks } from '~state/tracks';
import { requestFocus } from '~state/ui-focus';

/**
 * Global keyboard shortcuts.
 *
 * Bound on document.body. Each entry: predicate -> handler.
 * Full shortcut list lives in DESIGN_SYSTEM §6.2; this file owns dispatch.
 *
 * NOTE: input/textarea/contenteditable targets are skipped so typing in
 * the locus input doesn't trigger zoom etc.
 */

type ShortcutPredicate = (e: KeyboardEvent) => boolean;
type ShortcutHandler = (e: KeyboardEvent) => void;

interface Shortcut {
  match: ShortcutPredicate;
  run: ShortcutHandler;
  /** Human-readable hint shown in HelpOverlay. */
  hint: string;
}

/** Pan fraction per `h`/`l` press (20% of current span per DESIGN_SYSTEM §6.2). */
const PAN_FRACTION = 0.2;
/** Wheel/keyboard zoom step (DESIGN_SYSTEM §6.3). */
const ZOOM_STEP = 1.25;
/** Default "zoom to fit" span when no chrom length is known yet (Day 1). */
const FIT_SPAN_DEFAULT = 1_000_000n;

// ── Helpers ────────────────────────────────────────────────────────────────

function isUnmodified(e: KeyboardEvent): boolean {
  return !e.metaKey && !e.ctrlKey && !e.altKey;
}

function panLeft(): void {
  setViewport((v) => panBy(v, -PAN_FRACTION));
}

function panRight(): void {
  setViewport((v) => panBy(v, PAN_FRACTION));
}

function zoomIn(): void {
  // factor < 1 zooms in (smaller span).
  setViewport((v) => zoomBy(v, 1 / ZOOM_STEP));
}

function zoomOut(): void {
  setViewport((v) => zoomBy(v, ZOOM_STEP));
}

/**
 * "Zoom to fit chrom" — Day 1 stand-in: snap span to FIT_SPAN_DEFAULT
 * centred on the current midpoint. Proper chromosome-length lookup lands
 * once the FASTA index is wired (Phase 2).
 */
function zoomToFit(): void {
  setViewport((v) => {
    const mid = v.start + (v.end - v.start) / 2n;
    const half = FIT_SPAN_DEFAULT / 2n;
    const start = mid > half ? mid - half : 0n;
    return jumpTo(v, v.chrom, start, start + FIT_SPAN_DEFAULT);
  });
}

/**
 * "Go to" — focuses the TopBar locus input via the ui-focus signal.
 * The input handles parsing, validation, and the viewport mutation.
 */
function goTo(): void {
  requestFocus('locus-input');
}

/**
 * Pick a "target" track for v/d/Delete shortcuts. With no formal track
 * selection signal yet (lands with selection rework), use the first
 * visible track, falling back to the first track outright. Returns null
 * when no tracks are loaded — caller no-ops.
 */
function pickTargetTrack(): { id: string } | null {
  const list = tracks();
  if (list.length === 0) return null;
  const visible = list.find((t) => t.visible);
  const target = visible ?? list[0];
  return target ? { id: target.id } : null;
}

function toggleTargetVisibility(): void {
  const target = pickTargetTrack();
  if (!target) return;
  setTracks((prev) =>
    prev.map((t) => (t.id === target.id ? { ...t, visible: !t.visible } : t)),
  );
}

function duplicateTargetTrack(): void {
  const target = pickTargetTrack();
  if (!target) return;
  setTracks((prev) => {
    const idx = prev.findIndex((t) => t.id === target.id);
    if (idx < 0) return prev;
    const original = prev[idx];
    if (!original) return prev;
    // New id: append `-copy` and a short timestamp so multiple dupes don't
    // collide. ARCHITECTURE §4.1 tracks signal stores TrackConfig; copy
    // preserves the discriminated-union shape with a spread.
    const suffix = Date.now().toString(36).slice(-4);
    const copy = { ...original, id: `${original.id}-copy-${suffix}` };
    const next = prev.slice();
    next.splice(idx + 1, 0, copy);
    return next;
  });
}

function removeTargetTrack(): void {
  const target = pickTargetTrack();
  if (!target) return;
  setTracks((prev) => prev.filter((t) => t.id !== target.id));
}

function showHelpPlaceholder(): void {
  // Real overlay lands in T2.D.4. No-op for now so `?` doesn't accidentally
  // submit a form or scroll. We intentionally do nothing visible — logging
  // would litter the console (HANDOFF §7.2 forbids console.log in commits).
}

// ── Dispatch table ─────────────────────────────────────────────────────────

const shortcuts: Shortcut[] = [
  // Navigation
  {
    match: (e) => e.key === 'h' && isUnmodified(e),
    run: () => panLeft(),
    hint: 'h — pan left',
  },
  {
    match: (e) => e.key === 'l' && isUnmodified(e),
    run: () => panRight(),
    hint: 'l — pan right',
  },
  {
    // `+` is shift+= on most layouts; accept either so users with US/EN
    // keyboards don't need the shift.
    match: (e) => (e.key === '+' || e.key === '=') && isUnmodified(e),
    run: () => zoomIn(),
    hint: '+ — zoom in',
  },
  {
    match: (e) => e.key === '-' && isUnmodified(e),
    run: () => zoomOut(),
    hint: '- — zoom out',
  },
  {
    match: (e) => e.key === '0' && isUnmodified(e),
    run: () => zoomToFit(),
    hint: '0 — zoom to fit',
  },
  {
    match: (e) => e.key === 'g' && isUnmodified(e),
    run: () => goTo(),
    hint: 'g — go to locus',
  },
  // Track operations (DESIGN_SYSTEM §6.2 Track section)
  {
    match: (e) => e.key === 'v' && isUnmodified(e),
    run: () => toggleTargetVisibility(),
    hint: 'v — toggle track visibility',
  },
  {
    match: (e) => e.key === 'd' && isUnmodified(e),
    run: () => duplicateTargetTrack(),
    hint: 'd — duplicate track',
  },
  {
    match: (e) => e.key === 'Delete' && isUnmodified(e),
    run: () => removeTargetTrack(),
    hint: 'Delete — remove track',
  },
  // View
  {
    match: (e) => e.key === 't' && isUnmodified(e),
    run: () => toggleTheme(),
    hint: 't — toggle theme',
  },
  {
    match: (e) => e.key === '?' && isUnmodified(e),
    run: () => showHelpPlaceholder(),
    hint: '? — help overlay',
  },
];

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    target.isContentEditable
  );
}

export function useGlobalShortcuts() {
  const handler = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    for (const s of shortcuts) {
      if (s.match(e)) {
        s.run(e);
        e.preventDefault();
        return;
      }
    }
  };

  onMount(() => {
    document.addEventListener('keydown', handler);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', handler);
  });
}

export function shortcutHints(): ReadonlyArray<string> {
  return shortcuts.map((s) => s.hint);
}
