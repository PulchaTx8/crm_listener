'use server';

import { logger } from '@/lib/logger';
import { getArtistById, getArtistSongs } from '@/services/music';
import type { ArtistSongSummary, ArtistSummary } from '@/services/music';
import { describeMusicReadError } from '../errors';

export interface ArtistRecord {
  companyId: string;
  artist: ArtistSummary;
  /** Every live song naming this artist, from the same fetch as the artist itself — see this module's own doc comment. */
  songs: ArtistSongSummary[];
  /** True when getArtistSongs' 200-row cap was hit: the songs tab is a summary, not the whole catalogue for a prolific artist. */
  songsCapped: boolean;
}

/**
 * Three outcomes, and `not-found` covers two facts on purpose: the artist
 * does not exist, and the artist is at a Station this caller cannot reach.
 * RLS decides which rows exist (0099's `deleted_at is null and
 * has_permission('music.view', company_id)`) and this must not let the
 * screen tell them apart — the same reasoning the song record carries
 * (songs/record.ts) and the prize record before it.
 */
export type ArtistRecordResult =
  | { status: 'ok'; record: ArtistRecord }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

/**
 * One round trip for the whole record, covering BOTH tabs: getArtistSongs is
 * called here, once, alongside getArtistById — not from the songs tab's own
 * render. The two tabs the record dialog offers (data, songs) render off
 * this single result, so switching between them is a state change in the
 * browser and never reaches the server; nothing about it can re-run
 * getArtistSongs, let alone the Artists list's own keyset query behind the
 * dialog.
 */
export async function getArtistRecordAction(artistId: string): Promise<ArtistRecordResult> {
  try {
    const found = await getArtistById(artistId);
    if (!found) return { status: 'not-found' };

    const songs = await getArtistSongs(found.companyId, artistId);

    return {
      status: 'ok',
      record: {
        companyId: found.companyId,
        artist: found.artist,
        songs: songs.rows,
        songsCapped: songs.hasMore,
      },
    };
  } catch (cause) {
    logger.error({ err: cause, artistId }, 'could not load this artist record');
    return { status: 'error', message: describeMusicReadError(cause) };
  }
}
