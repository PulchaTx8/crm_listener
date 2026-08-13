'use server';

import { getTranslations } from 'next-intl/server';
import { logger } from '@/lib/logger';
import { getAlbumById } from '@/services/music';
import type { AlbumSummary } from '@/services/music';
import { describeMusicReadError } from '../../music/errors';

export interface AlbumRecord {
  companyId: string;
  album: AlbumSummary;
}

/**
 * Three outcomes, and `not-found` covers two facts on purpose: the album does
 * not exist, and the album is at a Station this caller cannot reach. RLS
 * decides which rows exist (0136's `deleted_at is null and
 * has_permission('music.view', company_id)`) and this must not let the
 * screen tell them apart — the same reasoning the artist record carries
 * (music/artists/record.ts).
 */
export type AlbumRecordResult =
  | { status: 'ok'; record: AlbumRecord }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

/**
 * One round trip for the whole record. Unlike getArtistRecordAction, there is
 * no second fetch alongside it: an album's record is its fields and its
 * picture (ALBUM_TABS, src/lib/record-params.ts), not fields plus a related
 * list the way an artist's songs tab is — the songs naming an album are
 * reached from the Songs screen, not from here.
 */
export async function getAlbumRecordAction(albumId: string): Promise<AlbumRecordResult> {
  try {
    const found = await getAlbumById(albumId);
    if (!found) return { status: 'not-found' };

    return { status: 'ok', record: { companyId: found.companyId, album: found.album } };
  } catch (cause) {
    logger.error({ err: cause, albumId }, 'could not load this album record');
    return { status: 'error', message: describeMusicReadError(cause, await getTranslations('music')) };
  }
}
