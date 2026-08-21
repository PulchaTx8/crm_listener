'use server';

import { getTranslations } from 'next-intl/server';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { BusinessRuleError, NotFoundError, UnauthorizedError } from '@/lib/errors';
import { showFormSchema } from '@/schemas/shows';
import { endShow, getShowById, saveShow, type ShowSummary } from '@/services/shows';

/**
 * Block 18. The two writes a programme has.
 *
 * NOT ONE `revalidatePath` IN THIS FILE, the same rule songs, inventory and
 * members all carry: every write here is invoked from the record dialog, and a
 * fresh render of the route would throw away whatever the operator had open,
 * rebuilding the list under them.
 *
 * The list patches the saved row in place instead (`applyRowPatch`). Block 30e's
 * WEEK view cannot: a saved schedule can move a block to another hour or another
 * day, which is a re-layout rather than a row edit, so `ScheduleBoard` asks for a
 * `router.refresh()` of its own after a save. That choice belongs to the view
 * that needs it rather than to this file, which is why it is still true here that
 * nothing revalidates.
 */

export interface ShowFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /** The saved programme, so the grid can patch its row without re-reading the list. */
  record?: ShowSummary;
}

// SHOW_FORM_IDLE lives in the dialog, NOT here. A module carrying 'use server'
// may export nothing but async functions -- an exported const object is a
// runtime error Next raises only when the route is served, which is why no
// typecheck, lint or unit run caught it and the e2e did.

async function accessToken(): Promise<string | null> {
  const supabase = await createUserClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

/**
 * A write refusal, as an operator should read it.
 *
 * `save_show` raises 22023 with a sentence per missing field -- "the programme
 * needs a kind" -- so those travel through verbatim rather than being collapsed
 * into one message that names none of them.
 */
function describe(cause: unknown, t: Awaited<ReturnType<typeof getTranslations>>): string {
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof UnauthorizedError) return t('youDoNotHoldMusicManage');
  if (cause instanceof NotFoundError) return t('thatProgrammeNoLongerExists');
  return t('couldNotSaveTheProgramme');
}

export async function saveShowAction(
  _previous: ShowFormState,
  formData: FormData,
): Promise<ShowFormState> {
  const t = await getTranslations('shows');

  // The bands arrive as one JSON field rather than as N indexed inputs: the
  // editor holds them as objects, save_show takes them as objects, and a form
  // encoding in between would be a third representation to keep in step.
  let bands: unknown;
  try {
    bands = JSON.parse(String(formData.get('bands') ?? '[]'));
  } catch {
    return { status: 'error', message: t('checkTheSchedule') };
  }

  const parsed = showFormSchema.safeParse({
    companyId: formData.get('companyId'),
    showId: formData.get('showId') || undefined,
    name: formData.get('name'),
    kind: formData.get('kind'),
    ageRating: formData.get('ageRating'),
    presenterName: formData.get('presenterName') || null,
    producerName: formData.get('producerName') || null,
    startsOn: formData.get('startsOn'),
    endsOn: formData.get('endsOn') ?? '',
    bands,
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? t('checkTheForm') };
  }

  const token = await accessToken();
  if (!token) return { status: 'error', message: t('couldNotSaveTheProgramme') };

  try {
    const id = await saveShow(parsed.data, token);
    const record = await getShowById(id);
    return record
      ? { status: 'saved', record }
      : { status: 'error', message: t('couldNotSaveTheProgramme') };
  } catch (cause) {
    logger.error({ err: cause, companyId: parsed.data.companyId }, 'save show failed');
    return { status: 'error', message: describe(cause, t) };
  }
}

/**
 * D8's only way out. There is no delete action in this file, and its absence is
 * the decision: nothing pointing at `shows` cascades, so a delete would be
 * refused with 23503 the moment one request named the programme -- the operator
 * would read "could not save" about a row they were removing.
 */
export async function endShowAction(
  _previous: ShowFormState,
  formData: FormData,
): Promise<ShowFormState> {
  const t = await getTranslations('shows');

  const showId = String(formData.get('showId') ?? '');
  const endsOn = String(formData.get('endsOn') ?? '');
  if (!showId || !/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) {
    return { status: 'error', message: t('checkTheForm') };
  }

  const token = await accessToken();
  if (!token) return { status: 'error', message: t('couldNotSaveTheProgramme') };

  try {
    await endShow(showId, endsOn, token);
    const record = await getShowById(showId);
    return record
      ? { status: 'saved', record }
      : { status: 'error', message: t('thatProgrammeNoLongerExists') };
  } catch (cause) {
    logger.error({ err: cause, showId }, 'end show failed');
    return { status: 'error', message: describe(cause, t) };
  }
}
