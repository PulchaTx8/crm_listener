'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { requestFormSchema } from '@/schemas/music';
import { archiveMusicRequest, createMusicRequest, searchSongs } from '@/services/music';
import type { SongSearchPage } from '@/services/music';
import { resolveOrCreateMember, searchStationListeners } from '@/services/participations';
import type { StationListenerPage } from '@/services/participations';
import { describeMusicReadError, describeMusicWriteError } from '../errors';

// ---------------------------------------------------------------------------
// Unlike songs/actions.ts, the two writes below DO revalidatePath. There is
// no getRequestById here to re-read one row and patch it into the grid the
// way the song and member records do — Task 7's service layer never shipped
// one, because a request has no record dialog to feed. list_music_requests
// orders newest first, so a fresh render after a create puts the new row
// exactly where an operator recording several requests in a row expects to
// find it: at the top of page one. The cost is the one row-patch spares —
// the operator's place in a filtered, paged list resets — and it is paid
// deliberately here, not overlooked.
// ---------------------------------------------------------------------------

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

export type StationListenerSearchResult =
  | { status: 'ok'; page: StationListenerPage }
  | { status: 'error'; message: string };

/**
 * The manual form's listener picker, called per keystroke and debounced in
 * the browser — the same shape searchStationListenersAction
 * (participations/actions.ts) has, kept local rather than imported so this
 * screen's actions do not reach into another screen's module for something
 * this brief already lists as consumed straight from the service.
 */
export async function searchRequestListenersAction(
  companyId: string,
  search: string,
): Promise<StationListenerSearchResult> {
  const token = await requireAccessToken();
  try {
    return { status: 'ok', page: await searchStationListeners(companyId, search, token) };
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'could not search the listeners of this station');
    return { status: 'error', message: describeMusicReadError(cause) };
  }
}

export type SongSearchResult =
  | { status: 'ok'; page: SongSearchPage }
  | { status: 'error'; message: string };

/** The manual form's song picker, the same shape as the listener one above. */
export async function searchRequestSongsAction(
  companyId: string,
  search: string,
): Promise<SongSearchResult> {
  const token = await requireAccessToken();
  try {
    return { status: 'ok', page: await searchSongs(companyId, search, token) };
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'could not search songs for a request');
    return { status: 'error', message: describeMusicReadError(cause) };
  }
}

/**
 * What one submission of the manual-entry form answers with.
 *
 * `ok: null` is the idle state useActionState needs before anything has been
 * submitted — the action itself never returns it, only the initial value
 * passed to the hook does, the same reason RecordParticipationState's own
 * `{ status: 'idle' }` exists on that screen's wider enum.
 */
export type RecordRequestState =
  | { ok: null }
  | { ok: true; requestId: string; listener: 'picked' | 'resolved' | 'created' }
  | {
      ok: false;
      message: string;
      /**
       * True when a listener was REGISTERED and the request then failed. The
       * two writes are two transactions, so this is a real half-finished
       * state — the identical reasoning RecordParticipationState carries for
       * its own listenerRegistered.
       */
      listenerRegistered?: boolean;
    };

/**
 * One hand-typed request, in two writes that are two transactions when the
 * listener is not already picked.
 *
 * The Station is posted (`companyId`), unlike recordParticipationAction's
 * deliberate omission of one: a request names no promotion to resolve it
 * from, and create_music_request re-checks music.request against exactly
 * this Station before writing anything, so a caller cannot escalate by
 * naming one they do not hold the permission in — the database bounds it
 * the same way inventory's and songs' own companyId-carrying writes are
 * already bounded.
 */
export async function recordRequestAction(
  _prev: RecordRequestState,
  formData: FormData,
): Promise<RecordRequestState> {
  const parsed = requestFormSchema.safeParse({
    companyId: formData.get('companyId'),
    songId: formData.get('songId'),
    showId: formData.get('showId') || null,
    memberId: formData.get('memberId') || null,
    requestedAt: formData.get('requestedAt'),
    fullName: formData.get('fullName'),
    phone: formData.get('phone'),
    email: formData.get('email'),
    cpf: formData.get('cpf'),
    passport: formData.get('passport'),
  });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();
  const input = parsed.data;

  let memberId = input.memberId;
  let listener: 'picked' | 'resolved' | 'created' = 'picked';

  if (!memberId) {
    try {
      // Block 3's deduplication, reused rather than re-implemented: the same
      // function the participations form calls, so the two doors into a
      // listener cannot drift.
      const resolved = await resolveOrCreateMember(
        {
          companyId: input.companyId,
          // The schema's own refine has already required fullName whenever
          // memberId is absent, so this is present by construction — asserted
          // with `??` rather than `!` so a future change to that refinement
          // fails loudly at the RPC instead of sending "undefined" as a name.
          fullName: input.fullName ?? '',
          phone: input.phone,
          email: input.email,
          cpf: input.cpf,
          passport: input.passport,
        },
        token,
      );
      // `elsewhere` is not an error and not a write — an identifier matches
      // somebody this caller may not reach, no id comes back on purpose, and
      // registering a second listener with it is impossible: 0031's
      // per-Organization unique indexes would refuse the duplicate. The
      // request simply cannot be recorded against them.
      if (resolved.outcome === 'elsewhere') {
        return {
          ok: false,
          message:
            'That listener is registered at a Station you cannot reach. Ask somebody who can.',
        };
      }
      memberId = resolved.memberId;
      listener = resolved.outcome;
    } catch (cause) {
      logger.error(
        { err: cause, companyId: input.companyId },
        'resolve listener for a request failed',
      );
      return {
        ok: false,
        message: describeMusicWriteError(cause, 'register this listener at this Station'),
      };
    }
  }

  try {
    const requestId = await createMusicRequest(
      {
        companyId: input.companyId,
        memberId,
        songId: input.songId,
        showId: input.showId,
        requestedAt: input.requestedAt,
      },
      token,
    );
    revalidatePath('/music/requests');
    return { ok: true, requestId, listener };
  } catch (cause) {
    logger.error({ err: cause, companyId: input.companyId }, 'record a request failed');
    const registered = listener === 'created';
    return {
      ok: false,
      listenerRegistered: registered,
      message: registered
        ? `The listener was registered, but the request was not recorded. ${describeMusicWriteError(cause, 'record a request')} They are now linked to this Station, so pick them from the search above rather than typing them again.`
        : describeMusicWriteError(cause, 'record a request'),
    };
  }
}

export type ArchiveRequestState = { ok: null } | { ok: true } | { ok: false; message: string };

/** Withdraws a mistyped manual entry — never a DELETE (0107's own comment on archive_music_request). */
export async function archiveRequestAction(
  _prev: ArchiveRequestState,
  formData: FormData,
): Promise<ArchiveRequestState> {
  const requestId = String(formData.get('requestId') ?? '');
  if (!requestId) return { ok: false, message: 'Missing request.' };

  const token = await requireAccessToken();

  try {
    await archiveMusicRequest(requestId, token);
    revalidatePath('/music/requests');
    return { ok: true };
  } catch (cause) {
    logger.error({ err: cause, requestId }, 'withdraw request failed');
    return { ok: false, message: describeMusicWriteError(cause, 'withdraw this request') };
  }
}
