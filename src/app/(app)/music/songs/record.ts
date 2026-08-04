'use server';

import { logger } from '@/lib/logger';
import { getSongById } from '@/services/music';
import type { SongSummary } from '@/services/music';
import { describeMusicReadError } from '../errors';

export interface SongRecord {
  companyId: string;
  song: SongSummary;
}

/**
 * Three outcomes, and `not-found` covers two facts on purpose: the song does
 * not exist, and the song is at a Station this caller cannot reach. RLS
 * decides which rows exist (0099's `deleted_at is null and
 * has_permission('music.view', company_id)`) and this must not let the
 * screen tell them apart — the same reasoning the prize record carries
 * (inventory/record.ts).
 */
export type SongRecordResult =
  | { status: 'ok'; record: SongRecord }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

/**
 * One round trip for the whole record. The reference lists a song's fields
 * are chosen from (artists, labels, genres) are not re-read here: they are
 * already on the page from the list's own Promise.all and are passed down as
 * props, so opening a record cannot re-run those reads either.
 */
export async function getSongRecordAction(songId: string): Promise<SongRecordResult> {
  try {
    const found = await getSongById(songId);
    if (!found) return { status: 'not-found' };

    return { status: 'ok', record: { companyId: found.companyId, song: found.song } };
  } catch (cause) {
    logger.error({ err: cause, songId }, 'could not load this song record');
    return { status: 'error', message: describeMusicReadError(cause) };
  }
}
