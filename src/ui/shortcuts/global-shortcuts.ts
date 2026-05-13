import { onCleanup, onMount } from 'solid-js';
import { toggleTheme } from '~state/theme';

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

const shortcuts: Shortcut[] = [
  {
    match: (e) => e.key === 't' && !e.metaKey && !e.ctrlKey && !e.altKey,
    run: () => toggleTheme(),
    hint: 't — toggle theme',
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
