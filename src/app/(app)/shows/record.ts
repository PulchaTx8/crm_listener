'use server';

import { getTranslations } from 'next-intl/server';
import { logger } from '@/lib/logger';
import { getShowById } from '@/services/shows';
import type { ShowSummary } from '@/services/shows';

/**
 * Block 18. One programme's record, read when the dialog opens.
 *
 * The dialog reads rather than being handed the row it was opened from, for the
 * reason every other record dialog here does: `?record=<id>` is an address an
 * operator can paste, and the row it names may be on a page this browser never
 * loaded. Reading makes both openings the same path instead of one that works
 * and one that renders an empty form.
 *
 * `not-found` covers two facts deliberately: no such programme, and a programme
 * at a Station this caller cannot reach. `shows_select_music_view` decides which
 * rows exist, and the screen must not be able to tell the two apart -- the same
 * contract music/songs/record.ts and inventory/record.ts carry.
 */
export type ShowRecordResult =
  | { status: 'ok'; record: ShowSummary }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

export async function getShowRecordAction(showId: string): Promise<ShowRecordResult> {
  try {
    const found = await getShowById(showId);
    return found ? { status: 'ok', record: found } : { status: 'not-found' };
  } catch (cause) {
    logger.error({ err: cause, showId }, 'could not load this programme record');
    const t = await getTranslations('shows');
    return { status: 'error', message: t('couldNotReadTheProgramme') };
  }
}
