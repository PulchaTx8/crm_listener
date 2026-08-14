'use server';

import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { requestFormSchema } from '@/schemas/music';
import {
  cancelMusicRequest,
  createMusicRequest,
  markMusicRequestPlayed,
  markMusicRequestRead,
  revealRequestPhone,
  searchSongs,
} from '@/services/music';
import type { SongSearchPage } from '@/services/music';
import { resolveOrCreateMember, searchStationListeners } from '@/services/participations';
import type { StationListenerPage } from '@/services/participations';
import { describeMusicReadError, describeMusicWriteError } from '../errors';
// The two errors thrown inside `resolveOrCreateMember` and
// `searchStationListeners` come from services/participations.ts, not
// services/music.ts — mapParticipationError's own taxonomy, not
// mapMusicError's. describeMusicWriteError/describeMusicReadError still
// pattern-match on the shared error CLASSES (BusinessRuleError,
// UnauthorizedError, …) from @/lib/errors, so nothing throws here, but their
// wording is written for a music-catalogue refusal — "you cannot ${action}
// … in this Station" reads as a doubled sentence when `action` already ends
// "at this Station", and their BusinessRuleError branch invents a wrong
// cause (a catalogue record "still used by other rows") for what is
// actually a create_member refusal. describeParticipationsReadError/
// describeParticipationsWriteError (participations/errors.ts) are the pair
// written for these two functions' own errors — participations/actions.ts
// uses them for the identical calls — so they are used here too rather than
// the music pair.
import {
  describeParticipationsReadError,
  describeParticipationsWriteError,
} from '../../participations/errors';

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
    return {
      status: 'error',
      message: describeParticipationsReadError(cause, await getTranslations('participations'), 'subjectTheListenersOfThisStation'),
    };
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
    return { status: 'error', message: describeMusicReadError(cause, await getTranslations('music')) };
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
    // The hidden `songId` input renders only once a song is picked
    // (record-request-form.tsx), so submitting without one means
    // `formData.get('songId')` is `null` — not a string at all. Zod 3
    // attaches a custom `.uuid(message)` string to the FORMAT check, not the
    // base type check, so a bare `null` would fail with the generic
    // "Expected string, received null" instead of the one sentence this
    // schema wrote for the one mistake an operator will actually make.
    // `?? ''` turns that into an empty string, which fails the uuid format
    // check instead and surfaces the real message.
    songId: formData.get('songId') ?? '',
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
    return { ok: false, message: parsed.error.issues[0]?.message ?? (await getTranslations('music'))('checkTheForm') };
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
            (await getTranslations('music'))('thatListenerIsAtAStationYouCannotReach'),
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
        message: describeParticipationsWriteError(cause, await getTranslations('participations'), 'actionRegisterThisListenerAtThisStation'),
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
        ? (await getTranslations('music'))('registeredButRequestNotRecorded', {
            reason: describeMusicWriteError(
              cause,
              await getTranslations('music'),
              'actionRecordARequest',
            ),
          })
        : describeMusicWriteError(cause, await getTranslations('music'), 'actionRecordARequest'),
    };
  }
}

export type AttendRequestState = { ok: null } | { ok: true } | { ok: false; message: string };

/**
 * A FUNCTION taking `t`, never a module-level constant — the same trap
 * archiveRequestSchema documented before this file replaced it: a `const` here
 * is evaluated when the module first loads, which is outside any request, and
 * getTranslations reads cookies(). The whole route failed to initialise for one
 * line of exactly that shape, and tests/unit/i18n/usage.test.ts now asks the AST
 * about it.
 */
function requestIdSchema(t: (key: string) => string) {
  return z.object({ requestId: z.string().uuid(t('thatRequestCouldNotBeIdentified')) });
}

/**
 * The three marks are one body called three times, each naming its own door and
 * its own log line, so a failure to mark played never reads as a failure to mark
 * read. The permission, the idempotence and the two refusals all live in 0190 —
 * nothing is re-decided here, because a second opinion is a thing that can
 * disagree with the first.
 */
async function attend(
  formData: FormData,
  door: (requestId: string, token: string) => Promise<void>,
  logLabel: string,
): Promise<AttendRequestState> {
  const t = await getTranslations('music');
  const parsed = requestIdSchema(t).safeParse({ requestId: formData.get('requestId') ?? '' });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? t('missingRequest') };
  }
  const { requestId } = parsed.data;
  const token = await requireAccessToken();

  try {
    await door(requestId, token);
    revalidatePath('/music/requests');
    return { ok: true };
  } catch (cause) {
    logger.error({ err: cause, requestId }, logLabel);
    return { ok: false, message: describeMusicWriteError(cause, t, 'actionAttendThisRequest') };
  }
}

export async function markRequestReadAction(
  _prev: AttendRequestState,
  formData: FormData,
): Promise<AttendRequestState> {
  return attend(formData, markMusicRequestRead, 'mark a request read failed');
}

export async function markRequestPlayedAction(
  _prev: AttendRequestState,
  formData: FormData,
): Promise<AttendRequestState> {
  return attend(formData, markMusicRequestPlayed, 'mark a request played failed');
}

export async function callOffRequestAction(
  _prev: AttendRequestState,
  formData: FormData,
): Promise<AttendRequestState> {
  return attend(formData, cancelMusicRequest, 'call off a request failed');
}

export type RevealPhoneResult =
  | { status: 'ok'; phone: string | null }
  | { status: 'error'; message: string };

/**
 * Not a form action: this returns a value to the component that asked, the way
 * searchRequestListenersAction does, because the answer is one string shown in
 * place. No revalidatePath — nothing the list renders has changed.
 */
export async function revealRequestPhoneAction(requestId: string): Promise<RevealPhoneResult> {
  const t = await getTranslations('music');
  const parsed = requestIdSchema(t).safeParse({ requestId });
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? t('missingRequest') };
  }
  const token = await requireAccessToken();
  try {
    return { status: 'ok', phone: await revealRequestPhone(parsed.data.requestId, token) };
  } catch (cause) {
    logger.error({ err: cause, requestId }, 'reveal a listener telephone number failed');
    return { status: 'error', message: t('couldNotShowTheNumber') };
  }
}
