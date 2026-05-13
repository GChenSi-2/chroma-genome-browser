/**
 * State layer barrel — the only entry point cross-layer imports should use.
 *
 * AGENT_PLAYBOOK §2.2 ownership:
 *   ✏ agent-ui  — may change implementations.
 *   👀 agent-render, agent-data — read-only.
 *
 * AGENT_PLAYBOOK §6.1: types and signal accessors here are frozen at T0.2.
 * Any rename/removal requires a lead decision.
 */

export * from './types';
export { viewport, setViewport, DEFAULT_VIEWPORT } from './viewport';
export { tracks, setTracks } from './tracks';
export { selection, setSelection } from './selection';
export { tileCache, setTileCache, type TileCacheSnapshot } from './tile-cache';
export {
  basePixelWidth,
  semanticLevel,
  binSizeForViewport,
  visibleTileKeys,
} from './derived';
export { theme, toggleTheme, type Theme } from './theme';
export { parseLocus, formatLocus, type ParseLocusResult } from './locus-parser';
export { startUrlSync } from './url-sync';
export { panBy, zoomBy, jumpTo, clampViewport } from './viewport-actions';
