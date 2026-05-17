/**
 * Helpers for blob: URL lifecycle management across track lifecycles.
 *
 * Lives in its own non-JSX module so unit tests can import the pure
 * helpers without dragging Solid's JSX runtime / refresh plugin into
 * the test transform graph.
 */

import { tracks } from '~state/tracks';
import type { TrackConfig } from '~state/types';

/** Revoke any `blob:` URLs a track points at. Call before discarding the
 *  track config so the file Blob is eligible for GC. */
export function revokeBlobUrlsFor(track: TrackConfig): void {
  if (track.url.startsWith('blob:')) {
    try { URL.revokeObjectURL(track.url); } catch { /* ignore */ }
  }
  if (track.kind === 'bam' && track.indexUrl?.startsWith('blob:')) {
    try { URL.revokeObjectURL(track.indexUrl); } catch { /* ignore */ }
  }
  if (track.kind === 'reference' && track.faiUrl?.startsWith('blob:')) {
    try { URL.revokeObjectURL(track.faiUrl); } catch { /* ignore */ }
  }
}

/** Revoke every blob URL currently in the tracks signal (unmount cleanup). */
export function revokeAllBlobUrls(): void {
  for (const t of tracks()) revokeBlobUrlsFor(t);
}
