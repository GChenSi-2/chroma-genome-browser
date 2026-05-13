import { onCleanup, onMount } from 'solid-js';
import { ThemeToggle } from '~ui/components/ThemeToggle';
import { Stage } from '~ui/components/Stage';
import { useGlobalShortcuts } from '~ui/shortcuts/global-shortcuts';
import { startUrlSync } from '~state/url-sync';

/**
 * App shell — M1 viewport navigation.
 *
 * Day 1 finisher: empty state retired in favour of a signal-driven Stage
 * placeholder, and `startUrlSync` is wired so viewport mutations from the
 * keyboard shortcuts round-trip through the URL hash. Real GenomeView with
 * a WebGL canvas replaces `<Stage>` once the renderer + tracks land.
 */
export default function App() {
  useGlobalShortcuts();
  let disposeUrlSync: () => void = () => {};
  onMount(() => {
    disposeUrlSync = startUrlSync();
  });
  onCleanup(() => disposeUrlSync());
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

      <main class="chroma-stage chroma-stage-host">
        <Stage />
      </main>
    </div>
  );
}
