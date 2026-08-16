'use server';

import { getTranslations } from 'next-intl/server';
import { logger } from '@/lib/logger';
import { countSongsSharingCode, getSongById, getSongIntegration } from '@/services/music';
import type { SongIntegration, SongSummary } from '@/services/music';
import { describeMusicReadError } from '../errors';

export interface SongRecord {
  companyId: string;
  song: SongSummary;
  /**
   * Block 27. The card describing this song in the customer's own system, found
   * by its integration code, or null — which means either that the song carries
   * no code at all or that no card has been registered for the code it carries.
   * The Integration tab tells those two apart itself, from the code.
   */
  integration: SongIntegration | null;
  /**
   * How many live songs in this Station carry the same integration code, THIS
   * ONE INCLUDED. The tab warns with it before an edit: correcting a card
   * corrects it for every song that resolves it, and a screen that quietly
   * rewrote four other records would be the defect this number exists to
   * prevent. Zero when the song has no code.
   */
  sharedCodeCount: number;
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
 * The whole record, in one round trip plus — since Block 27 — two more, and
 * only when the song carries an integration code.
 *
 * The reference lists a song's fields are chosen from (artists, labels, genres,
 * categories) are still not re-read here: they are already on the page from the
 * list's own Promise.all and are passed down as props, so opening a record
 * cannot re-run those reads either.
 *
 * THE CARD CANNOT BE EMBEDDED IN THE FIRST READ. 0207 links by code with no
 * foreign key (its header says why), so PostgREST has nothing to join through —
 * and putting it on SONG_COLUMNS would cost the LIST a lookup per row for a
 * column nobody asked to see. Two extra queries on ONE OPEN RECORD is the price
 * of that, paid in parallel and only when there is a code to look up.
 */
export async function getSongRecordAction(songId: string): Promise<SongRecordResult> {
  try {
    const found = await getSongById(songId);
    if (!found) return { status: 'not-found' };

    const code = found.song.internalCode;
    const [integration, sharedCodeCount] = code
      ? await Promise.all([
          getSongIntegration(found.companyId, code),
          countSongsSharingCode(found.companyId, code),
        ])
      : [null, 0];

    return {
      status: 'ok',
      record: { companyId: found.companyId, song: found.song, integration, sharedCodeCount },
    };
  } catch (cause) {
    logger.error({ err: cause, songId }, 'could not load this song record');
    return { status: 'error', message: describeMusicReadError(cause, await getTranslations('music')) };
  }
}
