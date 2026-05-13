import { createSignal } from 'solid-js';
import type { TrackConfig } from './types';

/**
 * Tracks signal — L3 state, ARCHITECTURE §4.1.
 *
 * Ownership: agent-ui ✏ / agent-data 👀 / agent-render 👀.
 *
 * Track ordering is rendering order (top first). Visibility lives on the
 * config object itself (not a side signal) so URL state captures it.
 */
const [tracks, setTracks] = createSignal<ReadonlyArray<TrackConfig>>([]);

export { tracks, setTracks };
