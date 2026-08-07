'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { mergeFormSchema } from '@/schemas/music';
import { mergeMusicRecords } from '@/services/music';
import { describeMergeError } from '../errors';

// ---------------------------------------------------------------------------
// The one write this screen has. Unlike songs/actions.ts and
// requests/actions.ts, there is no getXById to re-read a single row and
// patch it into a grid: a merge does not touch one row, it removes several
// from the candidate list at once (every loser) and the winner's own
// childCount changes too. revalidatePath is what requests/actions.ts's own
// comment already argues for the identical reason — the operator's place in
// a filtered list resets, and that is the cost worth paying rather than
// hand-rolling a re-read for a write this shaped.
// ---------------------------------------------------------------------------

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

/**
 * `ok: null` is the idle state useActionState needs before anything has been
 * submitted — the action itself never returns it, the same shape
 * RecordRequestState (requests/actions.ts) carries for its own idle case.
 */
export type MergeState = { ok: null } | { ok: true; message: string } | { ok: false; message: string };

/**
 * Collapses the ticked duplicates into the named survivor.
 *
 * The count in the success message is the receipt, not decoration: `moved`
 * is exactly what mergeMusicRecords (services/music.ts) returns from the
 * RPC, and `0 record(s) moved` is a legitimate, honestly-reported outcome —
 * two duplicates nobody had used yet — not a failure dressed up as one.
 * Saying the real number is more honest than a generic "Merged.", which
 * would read identically whether the merge moved four hundred rows or none.
 *
 * Failures go through describeMergeError, not describeMusicWriteError: a
 * merge's own P0002 means one of the ticked records is gone, archived, or —
 * deliberately indistinguishable — in another Station, and
 * describeMusicWriteError's generic "refresh and try again" for that code is
 * written for a stale record dialog, not a stale staging area (Task 7's own
 * reasoning for adding describeMergeError in the first place).
 */
export async function mergeRecordsAction(_prev: MergeState, formData: FormData): Promise<MergeState> {
  const result = mergeFormSchema.safeParse({
    companyId: formData.get('companyId'),
    kind: formData.get('kind'),
    winnerId: formData.get('winnerId'),
    loserIds: formData.getAll('loserIds'),
    reason: formData.get('reason'),
  });

  if (!result.success) {
    return { ok: false, message: result.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    const moved = await mergeMusicRecords(result.data, token);
    revalidatePath('/music/maintenance');
    return { ok: true, message: `Merged. ${moved} record(s) moved to the surviving entry.` };
  } catch (cause) {
    logger.error(
      { err: cause, companyId: result.data.companyId, kind: result.data.kind },
      'merge failed',
    );
    return { ok: false, message: describeMergeError(cause, await getTranslations('music')) };
  }
}
