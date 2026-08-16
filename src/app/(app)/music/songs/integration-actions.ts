'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { songIntegrationFormSchema } from '@/schemas/music';
import {
  countSongsSharingCode,
  getSongIntegration,
  saveSongIntegration,
  setSongIntegrationCode,
} from '@/services/music';
import type { SongIntegration } from '@/services/music';
import { describeMusicWriteError } from '../errors';

export interface SongIntegrationState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /** The card as the database now holds it, handed back so the tab renders what was stored rather than what was typed. */
  integration?: SongIntegration;
  /** The code the song now carries, likewise — the tab's own record prop is a stale copy the moment this succeeds. */
  code?: string;
  /**
   * How many live songs carry that code now, this one included, re-counted after
   * the write. Sent back because the warning it feeds would otherwise be a
   * number belonging to the PREVIOUS code: an operator who repoints a song from
   * a code four songs share to one nobody else uses would keep reading "4 other
   * songs carry this code" until they closed the record. One extra count on a
   * write path is a fair price for a warning that is true.
   */
  sharedCodeCount?: number;
}

/**
 * Block 27. The one write path from the Integration tab — for a hand-typed edit
 * and for a form the JSON import filled alike. The import writes nothing of its
 * own (design D9, the Deezer prefill's contract), so there is one action here
 * rather than two, and one place where the schema and the permission are
 * checked.
 *
 * NO revalidatePath, and the reason is the one music/songs/actions.ts already
 * records for this screen: the song record is a client-side read
 * (getSongRecordAction) keyed by an id useRecordDialog put in the URL through
 * the raw history API, which Next's router never learns about — revalidating
 * here would re-render against the router's STALE idea of the current search
 * params rather than the address the browser is actually showing. The saved card
 * is handed back instead, and the tab patches itself with it.
 *
 * The card is RE-READ after the write rather than assembled from the input: the
 * door trims, bounds and clears fields, so what it stored is not always what was
 * posted, and a tab rendering the posted values would disagree with the next
 * person to open the record.
 */
export async function saveSongIntegrationAction(
  _prev: SongIntegrationState,
  formData: FormData,
): Promise<SongIntegrationState> {
  const parsed = songIntegrationFormSchema.safeParse({
    companyId: formData.get('companyId'),
    songId: formData.get('songId'),
    code: formData.get('code'),
    title: formData.get('title') || null,
    artistName: formData.get('artistName') || null,
    categoryName: formData.get('categoryName') || null,
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');

  try {
    // TWO WRITES, IN THIS ORDER, and they are not one transaction.
    //
    // The code belongs to the SONG and the three words belong to the CARD, which
    // is the whole shape of 0207: several songs may resolve one card. Two rows,
    // two doors, each resolving its own Station and re-checking music.manage in
    // its own body.
    //
    // The code goes first, so the worst interleaving leaves the song pointing at
    // a code whose card was not updated — a state the tab already renders
    // honestly ("no card is registered for this code yet") and that pressing
    // Save again repairs. The other order would leave a card nothing points at,
    // which is invisible and therefore worse.
    await setSongIntegrationCode(parsed.data.songId, parsed.data.code, token);
    await saveSongIntegration(parsed.data, token);

    // Re-read rather than echoing the input: the door trims, bounds and clears,
    // so what it stored is not always what was posted, and a tab rendering the
    // posted values would disagree with the next person to open the record.
    const [integration, sharedCodeCount] = await Promise.all([
      getSongIntegration(parsed.data.companyId, parsed.data.code),
      countSongsSharingCode(parsed.data.companyId, parsed.data.code),
    ]);
    return {
      status: 'saved',
      integration: integration ?? undefined,
      code: parsed.data.code,
      sharedCodeCount,
    };
  } catch (cause) {
    logger.error({ err: cause, companyId: parsed.data.companyId }, 'save song integration failed');
    return {
      status: 'error',
      message: describeMusicWriteError(
        cause,
        await getTranslations('music'),
        // A key, not a phrase: describeMusicWriteError resolves it itself, the
        // same shape catalog/references/actions.ts passes from its ACTION_KEYS
        // map. Written out here rather than looked up because this action serves
        // one kind of record and has nothing to discriminate on.
        'actionSaveThisIntegrationCard',
      ),
    };
  }
}
