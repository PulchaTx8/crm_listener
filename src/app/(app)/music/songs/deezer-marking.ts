import type { DeezerTrack } from '@/lib/integrations/deezer/transport';

/** A search result, plus what this Station already knows about it. */
export type DeezerSearchRow = DeezerTrack & {
  /** The song already registered for this recording, or null. Design D9. */
  registeredSongId: string | null;
};

/**
 * Which of these tracks this Station already has (design D9).
 *
 * The interface half of the duplicate guard, and only the interface half:
 * songs_deezer_live (0138) is what actually holds when two tabs race, and this
 * is what stops the operator getting there. A plain module with no
 * 'use server', so the unit suite can reach it without a request.
 */
export function markRegistered(
  tracks: DeezerTrack[],
  existing: Map<number, string>,
): DeezerSearchRow[] {
  return tracks.map((track) => ({
    ...track,
    registeredSongId: existing.get(track.id) ?? null,
  }));
}
