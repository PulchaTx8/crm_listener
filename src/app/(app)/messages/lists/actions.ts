'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import {
  createSendListSchema,
  deleteSendListSchema,
  memberSendListFiltersSchema,
  participationSendListFiltersSchema,
  renameSendListSchema,
  requestSendListFiltersSchema,
  sendListReachRequestSchema,
} from '@/schemas/send-lists';
import type {
  MemberSendListFilters,
  ParticipationSendListFilters,
  RequestSendListFilters,
  SendListSource,
} from '@/schemas/send-lists';
import {
  createSendList,
  deleteSendList,
  filterMemberIdsLinkedToStation,
  listReach,
  renameSendList,
  resolveListMembers,
  SendListResolutionCappedError,
  RESOLVE_CAP,
} from '@/services/send-lists';
import type { ListReach } from '@/services/send-lists';
import { describeCreateSendListError, describeSendListWriteError } from '../errors';

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
 *
 * WITH ONE EXCEPTION, since the whole-branch review's F12: a LIVING list that
 * has GROWN past one of the resolver's two bounds is not a transient failure
 * and never will be, so "try again" is advice that can only ever be followed
 * for ever. That is a permanent condition with a fixable cause, and it gets
 * the same two sentences resolveSendListPreviewAction below already shows for
 * the identical refusal on the way IN -- the operator is told to narrow the
 * list, which is the only thing that actually changes the answer.
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
    if (cause instanceof SendListResolutionCappedError) {
      // Not logged as an error: nothing failed. The list outgrew a bound, and
      // the sentence below says so.
      return { status: 'error', message: await describeResolutionCap(cause) };
    }
    logger.error({ err: cause, listId: parsed.data.listId }, 'could not compute reach for a send list');
    return { status: 'error', message: (await getTranslations('templates'))('reachCouldNotLoad') };
  }
}

/**
 * The one sentence for each of the resolver's two bounds, in one place because
 * both actions below and above show them and two copies would drift.
 *
 * `bound` rather than the error's own message text: that message is English
 * prose for a log, and which of the two conditions fired is the only thing a
 * translated string can be keyed on -- see SendListResolutionCappedError
 * (services/send-lists.ts) for why the two cannot share one sentence.
 */
async function describeResolutionCap(cause: SendListResolutionCappedError): Promise<string> {
  const t = await getTranslations('templates');
  return cause.bound === 'people'
    ? t('sendListTooManyPeople', { cap: String(RESOLVE_CAP) })
    : t('sendListTooManyRows');
}

// ---------------------------------------------------------------------------
// Task 7: the button where the filters already are. CreateSendListDialog
// (components/send-lists/create-list-dialog.tsx) is the one caller of both
// actions below, mounted on the three source screens rather than here --
// they live beside rename/delete/reach anyway because create_send_list is
// the write Task 6 deliberately left unwrapped, not because this route owns
// the dialog.
// ---------------------------------------------------------------------------

export type ResolveSendListPreviewState =
  | { status: 'ok'; ids: string[] }
  | { status: 'capped'; message: string }
  | { status: 'error'; message: string };

/**
 * Resolves a NOT-YET-CREATED list's candidate people, so the dialog can show
 * "this will hold N people" before Save is even enabled -- the operator sees
 * what they are about to keep before they keep it. Calls resolveListMembers
 * (Task 4) exactly the way the three listing screens' own filters already
 * resolve them -- nothing here re-implements a filter, the same rule
 * resolveListMembers' own header states for its three resolvers.
 *
 * THE PARSE-THEN-DISPATCH BELOW IS DELIBERATELY NOT A CALL TO
 * resolveLivingListPeople (services/send-lists.ts), even though the two do
 * the identical two steps (parse through the matching schema, call the
 * matching resolveListMembers overload). That function reads an EXISTING
 * living list's stored row, and its own doc comment says so in words --
 * "A FIXED list does NOT go through here" -- which would become false the
 * moment this action used it too: this resolves a CANDIDATE list with no row
 * and no kind decided yet, and for a FIXED one the very ids returned here are
 * what createSendListAction goes on to freeze (see its own comment on
 * `memberIds`). Reusing that function's name for a second, differently-true
 * caller is how its own comment ends up describing only one of two things it
 * does. The four-line duplication below is dispatch only -- the actual
 * filtering logic lives in resolveListMembers and the three listing
 * services, exactly once, on both sides.
 *
 * NEITHER CAP IS SILENTLY SHORTENED. resolveListMembers throws
 * SendListResolutionCappedError rather than returning a truncated array
 * (RESOLVE_CAP's and RESOLVE_PAGE_CAP's own comments state why), and that is
 * the one branch this catches by type rather than folding into the generic
 * error -- a capped filter gets its own message, telling the operator to
 * narrow rather than reading as an unrelated failure. The error carries WHICH
 * bound refused, because "too many people" and "too many rows behind them" ask
 * the operator to narrow different things (whole-branch review, F11).
 *
 * `companyId` (fix round 1, F6): the Station this list will belong to,
 * ALWAYS the caller's real, already-resolved choice -- never optional, and
 * the dialog does not call this action for Members until one is chosen (see
 * create-list-dialog.tsx's own `noStation` state). USED ONLY for `members`:
 * that source resolves Organization-wide (resolveMemberIds' own comment,
 * services/send-lists.ts), while create_send_list aborts the WHOLE creation
 * on the first candidate it finds unlinked to the chosen Station
 * (0239:83-91) -- so a Members preview that ignored `companyId` would show a
 * number the door would refuse for any Organization whose audience spans
 * more than one Station. Participations and Requests are already scoped to
 * one Station THROUGH THEIR OWN `filters.companyId` (`listParticipationsPage`/
 * `listMusicRequestsPage` both take it directly), so `companyId` here is
 * accepted but unused for those two branches -- narrowing again would be
 * asking the same question a second time.
 */
export async function resolveSendListPreviewAction(
  source: SendListSource,
  filters: MemberSendListFilters | ParticipationSendListFilters | RequestSendListFilters,
  companyId: string,
): Promise<ResolveSendListPreviewState> {
  const token = await requireAccessToken();

  try {
    let ids: string[];
    switch (source) {
      case 'members': {
        const candidates = await resolveListMembers(
          'members',
          memberSendListFiltersSchema.parse(filters),
          token,
        );
        // F6: narrow the Organization-wide candidate set down to who is
        // actually linked to the Station this list will belong to -- see
        // filterMemberIdsLinkedToStation's own header for what this does and
        // does not guarantee.
        ids = await filterMemberIdsLinkedToStation(candidates, companyId, token);
        break;
      }
      case 'participations':
        ids = await resolveListMembers(
          'participations',
          participationSendListFiltersSchema.parse(filters),
          token,
        );
        break;
      case 'requests':
        ids = await resolveListMembers('requests', requestSendListFiltersSchema.parse(filters), token);
        break;
      default: {
        // Exhaustiveness: a fourth send_list_source value added to 0237
        // without a branch here is a compile error, the same guard
        // resolveListMembers' own switch (services/send-lists.ts) carries.
        const exhaustive: never = source;
        throw new Error(`Unknown send list source: ${String(exhaustive)}`);
      }
    }
    return { status: 'ok', ids };
  } catch (cause) {
    if (cause instanceof SendListResolutionCappedError) {
      return { status: 'capped', message: await describeResolutionCap(cause) };
    }
    logger.error({ err: cause, source }, 'could not resolve a send list preview');
    return { status: 'error', message: (await getTranslations('templates'))('sendListPreviewFailed') };
  }
}

export type CreateSendListState =
  | { status: 'idle' }
  | { status: 'created'; listId: string }
  | { status: 'error'; message: string };

/**
 * Creates a list through create_send_list (0239), Station and all. The
 * dialog resolves the Station itself before this is ever called -- either
 * the source screen's own selection, or one the operator picked when it had
 * none (D3) -- and this action trusts the companyId it is given the same way
 * TemplateDialog's own companyId prop is trusted: the RPC re-checks
 * messaging.manage there regardless (0239's own body), so a caller who
 * bypassed the dialog entirely is refused there, not here.
 *
 * `memberIds` IS EMPTY FOR A LIVING LIST, ALWAYS -- never the ids
 * resolveSendListPreviewAction happened to return for it. 0239's own door
 * refuses a living list carrying any id as 22023, and CreateSendListDialog
 * (components/send-lists) enforces this at the call site: it only reads its
 * own resolved ids back out for anything but the count when kind is 'fixed'.
 *
 * `filters` is validated a SECOND time here, through whichever schema
 * matches `source` -- the dialog already validated the same object once, on
 * its own way OUT of resolveSendListPreviewAction's caller, but a Server
 * Action is a network boundary and this file does not trust a client-typed
 * object to still be the shape its type claims.
 */
export async function createSendListAction(input: {
  companyId: string;
  name: string;
  source: SendListSource;
  kind: 'fixed' | 'living';
  filters: MemberSendListFilters | ParticipationSendListFilters | RequestSendListFilters;
  memberIds: string[];
}): Promise<CreateSendListState> {
  const parsed = createSendListSchema.safeParse({
    companyId: input.companyId,
    name: input.name,
    source: input.source,
    kind: input.kind,
    memberIds: input.memberIds,
  });

  if (!parsed.success) {
    return { status: 'error', message: (await getTranslations('templates'))('theListNeedsAName') };
  }

  let filters: MemberSendListFilters | ParticipationSendListFilters | RequestSendListFilters;
  try {
    switch (parsed.data.source) {
      case 'members':
        filters = memberSendListFiltersSchema.parse(input.filters);
        break;
      case 'participations':
        filters = participationSendListFiltersSchema.parse(input.filters);
        break;
      case 'requests':
        filters = requestSendListFiltersSchema.parse(input.filters);
        break;
      default: {
        const exhaustive: never = parsed.data.source;
        throw new Error(`Unknown send list source: ${String(exhaustive)}`);
      }
    }
  } catch (cause) {
    logger.error(
      { err: cause, source: parsed.data.source },
      'a send list filters payload did not match its own source',
    );
    return { status: 'error', message: (await getTranslations('templates'))('couldNotSave') };
  }

  const token = await requireAccessToken();

  try {
    const listId = await createSendList(
      {
        companyId: parsed.data.companyId,
        name: parsed.data.name,
        source: parsed.data.source,
        kind: parsed.data.kind,
        filters,
        memberIds: parsed.data.memberIds,
      },
      token,
    );
    revalidatePath('/messages/lists');
    return { status: 'created', listId };
  } catch (cause) {
    logger.error(
      { err: cause, companyId: parsed.data.companyId, source: parsed.data.source },
      'create a send list failed',
    );
    return {
      status: 'error',
      message: describeCreateSendListError(cause, await getTranslations('templates')),
    };
  }
}
