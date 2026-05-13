import { ThemeToggle } from '~ui/components/ThemeToggle';
import { useGlobalShortcuts } from '~ui/shortcuts/global-shortcuts';

/**
 * App shell — DESIGN_SYSTEM §8.2 empty state.
 *
 * This is the T0.2 placeholder. After M1 the genome view replaces the empty
 * state, and TopBar / TrackPanel / MiniMap mount around it.
 */
export default function App() {
  useGlobalShortcuts();
  return (
    <div class="chroma-shell">
      <header class="chroma-topbar">
        <div class="chroma-brand">
          <span class="chroma-mark" aria-hidden="true" />
          <span class="chroma-wordmark">Chroma</span>
        </div>
        <div class="chroma-topbar-spacer" />
        <ThemeToggle />
      </header>

      <main class="chroma-stage chroma-empty">
        <div class="chroma-empty-card">
          <h1 class="chroma-empty-title">Chroma</h1>
          <p class="chroma-empty-tagline">
            A genome browser that respects your time.
          </p>
          <ul class="chroma-empty-actions">
            <li>Load HG002 (Illumina, GRCh38)</li>
            <li>Load HG002 (PacBio HiFi)</li>
            <li>Load your URL…</li>
          </ul>
          <p class="chroma-empty-hint">
            Press <kbd>?</kbd> for shortcuts
          </p>
        </div>
      </main>
    </div>
  );
}
