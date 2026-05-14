import { For, Show, createMemo, createSignal } from 'solid-js';
import { setTracks, tracks } from '~state/tracks';
import { tileCache } from '~state/tile-cache';
import type { TileKey, TileStatus, TrackConfig, TrackKind } from '~state/types';
import GripVertical from 'lucide-solid/icons/grip-vertical';
import ChartBar from 'lucide-solid/icons/chart-bar';
import Layers from 'lucide-solid/icons/layers';
import Dna from 'lucide-solid/icons/dna';
import SquareIcon from 'lucide-solid/icons/square';
import Eye from 'lucide-solid/icons/eye';
import EyeOff from 'lucide-solid/icons/eye-off';
import Ellipsis from 'lucide-solid/icons/ellipsis';
import Plus from 'lucide-solid/icons/plus';

/**
 * TrackPanel — left sidebar (220px) listing tracks.
 *
 * Per-track row layout (DESIGN_SYSTEM §5):
 *   [grip] [kind] [label]                          [eye] [⋯]
 *
 * The drag-handle is a Phase-2 placeholder (no DnD wiring). Visibility
 * toggle and remove-via-menu are wired to the `tracks` signal directly.
 * Per-track loading/ready/error state is derived from `tileCache`.
 *
 * Selection: this panel owns a local `selectedTrackId` signal for the
 * accent stripe. The L3 `selection` signal is variant/read-scoped, not
 * track-scoped, so a separate signal here is correct for now. Lift to L3
 * the day a third caller needs track selection.
 */

type AggregateState = 'idle' | 'loading' | 'ready' | 'error';

interface TrackSummary {
  state: AggregateState;
  total: number;
  ready: number;
  reads: number;
  bins: number;
  errorMessage: string | null;
}

/** See GenomeView's now-removed `summarize` for the original logic. */
function summarize(
  trackId: string,
  snapshot: ReadonlyMap<TileKey, TileStatus>,
): TrackSummary {
  let total = 0;
  let ready = 0;
  let pending = 0;
  let error = 0;
  let reads = 0;
  let bins = 0;
  let errorMessage: string | null = null;

  for (const status of snapshot.values()) {
    if (status.state !== 'ready') continue;
    if (status.tile.trackId !== trackId) continue;
    total++;
    ready++;
    if (status.tile.payload === 'reads') {
      reads += status.tile.count;
    } else if (status.tile.payload === 'coverage') {
      bins += status.tile.values.length;
    }
  }

  for (const [key, status] of snapshot) {
    if (status.state === 'ready') continue;
    const colon = key.indexOf(':');
    const keyTrackId = colon > 0 ? key.slice(0, colon) : '';
    if (keyTrackId !== trackId) continue;
    total++;
    if (status.state === 'pending') {
      pending++;
    } else {
      error++;
      if (!errorMessage) errorMessage = status.message;
    }
  }

  let state: AggregateState = 'idle';
  if (total === 0) state = 'idle';
  else if (pending > 0) state = 'loading';
  else if (error > 0 && ready === 0) state = 'error';
  else state = 'ready';

  return { state, total, ready, reads, bins, errorMessage };
}

function statusLabel(t: TrackConfig, s: TrackSummary): string {
  if (s.state === 'idle') return 'idle';
  if (s.state === 'loading') return `loading ${s.ready}/${s.total}`;
  if (s.state === 'error') return `error: ${s.errorMessage ?? 'unknown'}`;
  if (t.kind === 'bam') {
    if (s.reads > 0) return `${s.reads.toLocaleString('en-US')} reads`;
    if (s.bins > 0) return `${s.bins.toLocaleString('en-US')} bins`;
  }
  return `${s.total} tile${s.total === 1 ? '' : 's'}`;
}

interface KindIconProps {
  kind: TrackKind;
}

function KindIcon(props: KindIconProps) {
  // 14px aligns with text-sm baseline cap-height — DESIGN_SYSTEM §3.
  const size = 14;
  if (props.kind === 'bigwig') return <ChartBar size={size} />;
  if (props.kind === 'bam') return <Layers size={size} />;
  if (props.kind === 'reference') return <Dna size={size} />;
  if (props.kind === 'vcf') return <SquareIcon size={size} />;
  // gene / bed fallback — generic.
  return <SquareIcon size={size} />;
}

/** Validate a parsed JSON value as a TrackConfig. Mirrors url-sync rules. */
const TRACK_KINDS: ReadonlySet<TrackKind> = new Set<TrackKind>([
  'reference',
  'bam',
  'bigwig',
  'vcf',
  'gene',
  'bed',
]);

function isTrackConfig(value: unknown): value is TrackConfig {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['id'] === 'string' &&
    typeof obj['kind'] === 'string' &&
    TRACK_KINDS.has(obj['kind'] as TrackKind) &&
    typeof obj['label'] === 'string' &&
    typeof obj['url'] === 'string' &&
    typeof obj['visible'] === 'boolean'
  );
}

function promptForTrackConfig(): TrackConfig | null {
  if (typeof window === 'undefined') return null;
  const raw = window.prompt(
    'Paste a track JSON config (id, kind, label, url, visible, ...)',
  );
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    window.alert(`Invalid JSON: ${(err as Error).message}`);
    return null;
  }
  if (!isTrackConfig(parsed)) {
    window.alert(
      'Track config must have string id/kind/label/url and boolean visible. kind ∈ reference|bam|bigwig|vcf|gene|bed.',
    );
    return null;
  }
  return parsed;
}

function toggleVisibility(id: string): void {
  setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, visible: !t.visible } : t)));
}

function removeTrack(id: string): void {
  setTracks((prev) => prev.filter((t) => t.id !== id));
}

function addTrack(): void {
  const cfg = promptForTrackConfig();
  if (cfg === null) return;
  setTracks((prev) => {
    if (prev.some((t) => t.id === cfg.id)) {
      window.alert(`Track id "${cfg.id}" already exists.`);
      return prev;
    }
    return [...prev, cfg];
  });
}

interface RowProps {
  track: TrackConfig;
  selected: boolean;
  onSelect: (id: string) => void;
}

function TrackRow(props: RowProps) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const summary = createMemo(() => summarize(props.track.id, tileCache()));

  function handleRowClick(e: MouseEvent): void {
    // Don't steal selection from button clicks inside the row.
    const target = e.target as HTMLElement;
    if (target.closest('button')) return;
    props.onSelect(props.track.id);
  }

  function handleMenuRemove(): void {
    setMenuOpen(false);
    removeTrack(props.track.id);
  }

  return (
    <div
      class="chroma-track-row"
      classList={{ 'chroma-track-row--selected': props.selected }}
      data-track-id={props.track.id}
      onClick={handleRowClick}
    >
      <span class="chroma-track-handle" aria-hidden="true">
        <GripVertical size={12} />
      </span>
      <span class="chroma-track-kind" aria-hidden="true">
        <KindIcon kind={props.track.kind} />
      </span>
      <span class="chroma-track-label" title={props.track.label}>
        {props.track.label}
      </span>
      <span
        class="chroma-track-row-status"
        data-state={summary().state}
        title={statusLabel(props.track, summary())}
      >
        {statusLabel(props.track, summary())}
      </span>
      <button
        type="button"
        class="chroma-track-icon-btn"
        title={props.track.visible ? 'Hide track' : 'Show track'}
        aria-label={props.track.visible ? 'Hide track' : 'Show track'}
        aria-pressed={props.track.visible}
        onClick={() => toggleVisibility(props.track.id)}
      >
        <Show when={props.track.visible} fallback={<EyeOff size={14} />}>
          <Eye size={14} />
        </Show>
      </button>
      <div class="chroma-track-menu-wrap">
        <button
          type="button"
          class="chroma-track-icon-btn"
          title="Track actions"
          aria-label="Open track menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen()}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <Ellipsis size={14} />
        </button>
        <Show when={menuOpen()}>
          <menu
            class="chroma-track-menu"
            role="menu"
            onMouseLeave={() => setMenuOpen(false)}
          >
            <li role="presentation">
              <button
                type="button"
                role="menuitem"
                class="chroma-track-menu-item"
                onClick={handleMenuRemove}
              >
                Remove
              </button>
            </li>
          </menu>
        </Show>
      </div>
    </div>
  );
}

export function TrackPanel() {
  const [selectedId, setSelectedId] = createSignal<string | null>(null);

  return (
    <aside class="chroma-track-panel" aria-label="Tracks">
      <header class="chroma-track-panel-header">Tracks</header>
      <div class="chroma-track-panel-list" role="list">
        <For
          each={tracks()}
          fallback={
            <div class="chroma-track-panel-empty">No tracks loaded.</div>
          }
        >
          {(t) => (
            <TrackRow
              track={t}
              selected={selectedId() === t.id}
              onSelect={setSelectedId}
            />
          )}
        </For>
      </div>
      <footer class="chroma-track-panel-footer">
        <button
          type="button"
          class="chroma-track-panel-add"
          onClick={addTrack}
        >
          <Plus size={14} />
          <span>Add track</span>
        </button>
      </footer>
    </aside>
  );
}
