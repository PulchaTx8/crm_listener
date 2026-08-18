'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import {
  deleteSendListSchema,
  renameSendListSchema,
  sendListReachRequestSchema,
} from '@/schemas/send-lists';
import { deleteSendList, listReach, renameSendList } from '@/services/send-lists';
import type { ListReach } from '@/services/send-lists';
import { describeSendListWriteError } from '../errors';

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

export type RenameSendListState =
  | { status: 'idle' }
  | { status: 'renamed' }
  | { status: 'error'; message: string };

/**
 * Renames a list through `rename_send_list` (0239), which resolves the
 * Station from the row rather than trusting one this form could carry.
 *
 * A failed `renameSendListSchema.safeParse` here means the form itself was
 * bypassed -- `name` carries the same `required`/non-blank rule client-side
 * -- so this returns one fixed sentence rather than surfacing Zod's own
 * (English, unlocalized) issue text the way a couple of this section's older
 * actions still do.
 */
export async function renameSendListAction(
  _prev: RenameSendListState,
  formData: FormData,
): Promise<RenameSendListState> {
  const parsed = renameSendListSchema.safeParse({
    listId: formData.get('listId'),
    name: formData.get('name'),
  });

  if (!parsed.success) {
    return { status: 'error', message: (await getTranslations('templates'))('theListNeedsAName') };
  }

  const token = await requireAccessToken();

  try {
    await renameSendList(parsed.data, token);
    revalidatePath('/messages/lists');
    return { status: 'renamed' };
  } catch (cause) {
    logger.error({ err: cause, listId: parsed.data.listId }, 'rename a send list failed');
    return {
      status: 'error',
      message: describeSendListWriteError(
        cause,
        await getTranslations('templates'),
        'actionRenameThisSendList',
      ),
    };
  }
}

export type DeleteSendListState =
  | { status: 'idle' }
  | { status: 'deleted' }
  | { status: 'error'; message: string };

/**
 * Soft-deletes a list through `delete_send_list` (0239). Never a DELETE from
 * this side either: the door itself sets `deleted_at`, which is what takes the
 * row out from under 0238's own select policy -- this action does not decide
 * that, it only asks for it.
 */
export async function deleteSendListAction(
  _prev: DeleteSendListState,
  formData: FormData,
): Promise<DeleteSendListState> {
  const parsed = deleteSendListSchema.safeParse({ listId: formData.get('listId') ?? '' });
  if (!parsed.success) {
    return {
      status: 'error',
      message: (await getTranslations('templates'))('thatSendListCouldNotBeIdentified'),
    };
  }

  const token = await requireAccessToken();

  try {
    await deleteSendList(parsed.data, token);
    revalidatePath('/messages/lists');
    return { status: 'deleted' };
  } catch (cause) {
    logger.error({ err: cause, listId: parsed.data.listId }, 'delete a send list failed');
    return {
      status: 'error',
      message: describeSendListWriteError(
        cause,
        await getTranslations('templates'),
        'actionDeleteThisSendList',
      ),
    };
  }
}

export type GetSendListReachState =
  | { status: 'ok'; reach: ListReach }
  | { status: 'error'; message: string };

/**
 * Task 6, fix round 1 (F5, Critical). Reach is no longer computed for every
 * row on every page load -- listSendLists' own header explains the cost that
 * made that unbounded (up to RESOLVE_CAP/50 sequential pages for one LIVING
 * list, times however many rows the grid held). This is the on-demand
 * replacement: called directly from a row's own button onClick
 * (ReachCells, lists-grid.tsx), never through useActionState, the same shape
 * previewCampaignEmailAction (messages/templates/actions.ts) already
 * establishes for a read that is not a form submission -- nothing about
 * revealing a number should behave like a save.
 *
 * A short, fixed message on failure rather than the section's own
 * describeSendListReadError taxonomy: that taxonomy exists for a
 * page-level load, and this control renders inside three narrow table
 * cells, where "could not load" already says everything an operator needs
 * before trying again. 'forbidden' is not a failure here at all -- it is
 * listReach's own successful answer for a channel the caller may not ask
 * about, carried inside `reach` unchanged.
 */
export async function getSendListReachAction(listId: string): Promise<GetSendListReachState> {
  const parsed = sendListReachRequestSchema.safeParse({ listId });
  if (!parsed.success) {
    return {
      status: 'error',
      message: (await getTranslations('templates'))('thatSendListCouldNotBeIdentified'),
    };
  }

  const token = await requireAccessToken();

  try {
    const reach = await listReach(parsed.data.listId, token);
    return { status: 'ok', reach };
  } catch (cause) {
    logger.error({ err: cause, listId: parsed.data.listId }, 'could not compute reach for a send list');
    return { status: 'error', message: (await getTranslations('templates'))('reachCouldNotLoad') };
  }
}
