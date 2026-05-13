import { createSignal } from 'solid-js';
import type { Selection } from './types';

/**
 * Selection signal — L3 state, ARCHITECTURE §4.1.
 *
 * `null` = nothing selected. Esc clears it (handled in global-shortcuts).
 */
const [selection, setSelection] = createSignal<Selection | null>(null);

export { selection, setSelection };
