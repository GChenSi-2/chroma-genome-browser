import { createSignal } from 'solid-js';

/**
 * UI focus dispatch — a tiny signal-driven bridge that lets keyboard
 * shortcuts (L4) ask a specific UI region to take focus without crossing
 * the layer boundary.
 *
 * Why a signal and not `document.querySelector`:
 *   - TopBar can register a callback when it mounts; if the element isn't
 *     in the DOM yet (race during onMount), the shortcut still works as
 *     soon as the listener registers.
 *   - Tests don't need a real DOM tree — they just check the listener
 *     was called.
 *
 * Ownership: agent-ui. Lead pre-approved as a single new state file for
 * T2.D.1 (handoff brief). Append-only on `src/state/index.ts` re-export.
 */

export type FocusTarget = 'locus-input';

type Listener = () => void;

const listeners = new Map<FocusTarget, Set<Listener>>();

/**
 * Subscribe to focus requests for `target`. Returns the unsubscribe fn —
 * call it from `onCleanup` so listener sets don't leak across hot reloads.
 */
export function onRequestFocus(target: FocusTarget, listener: Listener): () => void {
  let set = listeners.get(target);
  if (!set) {
    set = new Set();
    listeners.set(target, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(target);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(target);
  };
}

/**
 * Ask whoever owns `target` (e.g. the TopBar locus input) to focus itself.
 * No-op when no listener is registered — that's the desired behaviour
 * during early boot before the component mounts.
 *
 * The signal below isn't read directly by anyone; it exists so future
 * consumers can `createEffect` on focus pulses without registering a
 * listener. Bumping the counter wakes them.
 */
const [focusPulse, setFocusPulse] = createSignal(0);
export { focusPulse };

export function requestFocus(target: FocusTarget): void {
  const set = listeners.get(target);
  if (set) {
    for (const listener of set) listener();
  }
  setFocusPulse((n) => n + 1);
}

/**
 * Test helper: drop all listeners. Used by unit tests so a leaked
 * subscription from a prior test doesn't fire on the next render.
 */
export function _resetUiFocusForTests(): void {
  listeners.clear();
}
