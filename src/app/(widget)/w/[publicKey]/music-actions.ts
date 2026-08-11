'use server';

import { cookies } from 'next/headers';
import { env } from '@/lib/env';
import { deezerTransport } from '@/lib/integrations/deezer';
import { logger } from '@/lib/logger';
import { PostgresRateLimiter } from '@/lib/rate-limit';
import { createServiceClient } from '@/lib/supabase/service-client';
import { readAnswer } from '@/lib/widget/door-answer';
import { callerIp, ipKey, withinLimits } from '@/lib/widget/limits';
import {
  deezerRefusal,
  readShows,
  recordRefusal,
  toWidgetTrack,
  type RequestRefusal,
  type SearchRefusal,
  type WidgetShow,
  type WidgetTrack,
} from '@/lib/widget/music-mapping';
import { WIDGET_SESSION_COOKIE, readSessionFor, type WidgetClaims } from '@/lib/widget/session';
import { publicKeySchema } from '@/schemas/widget';
import { requestSongSchema, searchSchema } from '@/schemas/widget-music';

/**
 * Block 17b. The widget's first button: a listener searches Deezer, picks a
 * recording, and it becomes a request with channel `WEB`.
 *
 * SEPARATE FROM `actions.ts` because that file is 28 KB before this block adds
 * a line to it, and the music screen sets the precedent by keeping
 * `deezer-actions.ts` beside its own `actions.ts`.
 *
 * WHAT EVERY EXPORT HERE HAS IN COMMON: `readSessionFor`, never `readSession`.
 * The widget cookie's Path is `/w` -- one path for every installation this
 * deployment serves -- so a browser that identified at Station A presents that
 * same cookie to Station B. `readSession` answers "we minted this" and CANNOT
 * answer "we minted it here"; 17a's own comment predicted this file as the
 * place that distinction gets forgotten.
 */

/**
 * Searching is cheap for us and not free for Deezer, whose per-IP limit is
 * shared across everything this deployment does. The panel debounces at 400 ms,
 * so a fast typist produces at most two or three of these a second in bursts;
 * twenty a minute is a ceiling on a script, not on a listener.
 */
const SEARCH_PER_IP_MINUTE = { limit: 20, windowSeconds: 60 } as const;
const SEARCH_PER_STATION_MINUTE = { limit: 60, windowSeconds: 60 } as const;

/**
 * Submitting is the expensive one: it can create a row in the Station's
 * catalogue. The per-LISTENER ceiling is the Station's cooldown and lives in
 * the database (0167), where it is atomic with the insert. This is the one the
 * database cannot express, because it has no idea what an IP address is --
 * 0161's own comment says exactly that about the code limits.
 */
const REQUEST_PER_IP_HOUR = { limit: 30, windowSeconds: 3600 } as const;

/**
 * `WidgetTrack`, `toWidgetTrack`, `recordRefusal` and `deezerRefusal` live in
 * `@/lib/widget/music-mapping` rather than here, and being testable is the
 * whole reason: this file carries `'use server'`, so a mapping written in it
 * cannot be imported by a test at all. Two of those guarantees -- that the
 * signed preview URL never reaches the browser, and that a reason this code
 * does not know becomes `failed` rather than rendering as nothing -- should
 * fail a suite rather than a code review.
 */
export type SearchState =
  | { status: 'idle' }
  | { status: 'results'; tracks: WidgetTrack[] }
  | { status: 'refused'; reason: SearchRefusal };

export type RequestState =
  | { status: 'idle' }
  | { status: 'recorded' }
  | { status: 'refused'; reason: RequestRefusal; waitSeconds?: number };

export type WaitState =
  | { ok: true; waitSeconds: number }
  | { ok: false; reason: RequestRefusal };

/**
 * The session, or null -- and the public key it was checked against.
 *
 * Returns the key alongside the claims because every caller needs both, and the
 * one thing that must not happen is a caller parsing the key, forgetting to
 * pass it here, and getting a genuine session for the wrong Station.
 */
async function sessionFor(
  rawPublicKey: FormDataEntryValue | null,
): Promise<{ publicKey: string; claims: WidgetClaims } | null> {
  const key = publicKeySchema.safeParse(rawPublicKey);
  if (!key.success) return null;

  const secret = env.WIDGET_SESSION_SECRET;
  if (!secret) {
    logger.error('widget: WIDGET_SESSION_SECRET is not configured; refusing a music request');
    return null;
  }

  const token = (await cookies()).get(WIDGET_SESSION_COOKIE)?.value;
  if (!token) return null;

  const claims = readSessionFor(token, secret, key.data);
  return claims === null ? null : { publicKey: key.data, claims };
}

export async function searchSongsAction(
  _previous: SearchState,
  formData: FormData,
): Promise<SearchState> {
  const session = await sessionFor(formData.get('publicKey'));
  if (!session) return { status: 'refused', reason: 'no_session' };

  const parsed = searchSchema.safeParse({ query: formData.get('query') });
  if (!parsed.success) return { status: 'refused', reason: 'invalid' };

  const supabase = createServiceClient();
  const limiter = new PostgresRateLimiter(supabase);
  const ip = await callerIp();

  const refusedBy = await withinLimits(limiter, session.publicKey, [
    {
      key: `widget:music:search:ip:${ipKey(ip)}`,
      label: 'music/search/ip/minute',
      ...SEARCH_PER_IP_MINUTE,
    },
    {
      key: `widget:music:search:station:${session.publicKey}`,
      label: 'music/search/station/minute',
      ...SEARCH_PER_STATION_MINUTE,
    },
  ]);
  if (refusedBy) return { status: 'refused', reason: 'rate_limited' };

  // `track:` and not a bare query: the panel has one box, and a listener types
  // a song name into it. Deezer's advanced syntax puts the term where it
  // belongs rather than matching it against artists and albums as well.
  const result = await deezerTransport().search({ track: parsed.data.query });

  if (!result.ok) {
    logger.warn(
      { publicKey: session.publicKey, reason: result.reason },
      'widget: deezer refused a search',
    );
    return { status: 'refused', reason: deezerRefusal(result.reason) };
  }

  return { status: 'results', tracks: result.value.map(toWidgetTrack) };
}

/**
 * Block 18. The Station's programmes, so a listener can say which one the song
 * is for.
 *
 * NOT a `useActionState` pair, like `getWaitAction` beside it: it takes no form
 * and answers a question. Failure is answered with an EMPTY LIST rather than a
 * refusal — choosing is optional (D6), so a listener whose programme list could
 * not be read should still be able to ask for a song.
 */
export async function listShowsAction(rawPublicKey: string): Promise<WidgetShow[]> {
  const session = await sessionFor(rawPublicKey);
  if (!session) return [];

  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc('widget_shows', {
    p_public_key: session.publicKey,
    p_member_id: session.claims.memberId,
  });

  if (error) {
    logger.warn(
      { publicKey: session.publicKey, code: error.code, message: error.message },
      'widget: could not read the programmes',
    );
    return [];
  }

  const answer = readAnswer(data);
  if (!answer?.ok) return [];

  return readShows((data as { shows?: unknown }).shows);
}

export async function requestSongAction(
  _previous: RequestState,
  formData: FormData,
): Promise<RequestState> {
  const session = await sessionFor(formData.get('publicKey'));
  if (!session) return { status: 'refused', reason: 'no_session' };

  const parsed = requestSongSchema.safeParse({
    deezerTrackId: formData.get('deezerTrackId'),
    note: formData.get('note') ?? '',
    showId: formData.get('showId') ?? '',
  });
  if (!parsed.success) return { status: 'refused', reason: 'invalid' };

  const supabase = createServiceClient();
  const limiter = new PostgresRateLimiter(supabase);
  const ip = await callerIp();

  const refusedBy = await withinLimits(limiter, session.publicKey, [
    {
      key: `widget:music:request:ip:${ipKey(ip)}`,
      label: 'music/request/ip/hour',
      ...REQUEST_PER_IP_HOUR,
    },
  ]);
  if (refusedBy) return { status: 'refused', reason: 'rate_limited' };

  const deezer = deezerTransport();

  // D4: THE BROWSER SENT AN INTEGER, and this is where it becomes a recording.
  // Nothing the client posted describes the song, so nothing the client posts
  // can name what lands in the Station's catalogue.
  const track = await deezer.track(parsed.data.deezerTrackId);
  if (!track.ok) {
    logger.warn(
      { publicKey: session.publicKey, reason: track.reason },
      'widget: deezer could not read the chosen track',
    );
    return {
      status: 'refused',
      reason: track.reason === 'not-found' ? 'not_found' : deezerRefusal(track.reason),
    };
  }

  // The album is ENRICHMENT AND NOT A PREREQUISITE: UPC, label, genre and
  // release date are absent from a search result, and a request recorded
  // without them is a correct request with four empty fields. Failing here
  // would refuse a listener because a second Deezer call was unlucky.
  const album = await deezer.album(track.value.albumId);
  if (!album.ok) {
    logger.warn(
      { publicKey: session.publicKey, albumId: track.value.albumId, reason: album.reason },
      'widget: recording the request without album detail',
    );
  }
  const detail = album.ok ? album.value : null;

  const { data, error } = await supabase.rpc('widget_record_music_request', {
    p_public_key: session.publicKey,
    // FROM THE SESSION, NEVER FROM THE FORM. requestSongSchema is `.strict()`,
    // so a posted `memberId` is refused before this line -- but the reason it
    // is safe is here: the only listener this action can act for is the one the
    // signed cookie names.
    p_member_id: session.claims.memberId,
    p_deezer_track_id: track.value.id,
    p_title: track.value.title,
    p_artist_name: track.value.artistName,
    p_album_title: track.value.albumTitle,
    p_duration_seconds: track.value.durationSeconds,
    // `undefined` AND NOT `null` for every optional argument: supabase-js
    // generates a parameter with a SQL default as optional rather than
    // nullable, and an explicit null is a different call from an omitted
    // argument. They happen to mean the same thing to these particular
    // defaults, and typing the difference away with `as` would be a lie about
    // the one place it stops being true.
    p_isrc: track.value.isrc ?? undefined,
    p_cover_md5: track.value.coverMd5 ?? detail?.coverMd5 ?? undefined,
    p_deezer_album_id: track.value.albumId,
    p_upc: detail?.upc ?? undefined,
    p_label_name: detail?.label ?? undefined,
    p_genre_name: detail?.genreName ?? undefined,
    p_release_date: detail?.releaseDate ?? undefined,
    p_note: parsed.data.note ?? undefined,
    // Block 18. Shape-checked here; whether it names a programme of THIS
    // Station is the door's to decide, and anything else resolves to null.
    p_show_id: parsed.data.showId ?? undefined,
  });

  if (error) {
    logger.error(
      { publicKey: session.publicKey, code: error.code, message: error.message },
      'widget: record_music_request failed',
    );
    return { status: 'refused', reason: 'failed' };
  }

  const answer = readAnswer(data);
  if (!answer) {
    logger.error(
      { publicKey: session.publicKey },
      'widget: record_music_request answered a shape this code does not know',
    );
    return { status: 'refused', reason: 'failed' };
  }

  if (!answer.ok) {
    return {
      status: 'refused',
      reason: recordRefusal(answer.reason),
      ...(answer.waitSeconds !== null ? { waitSeconds: answer.waitSeconds } : {}),
    };
  }

  return { status: 'recorded' };
}

/**
 * How long before this listener may ask again -- asked when the panel opens.
 *
 * NOT A `useActionState` PAIR: it takes no form and answers a question rather
 * than performing a submission. It exists so that nobody is invited to search,
 * choose a recording and write a note before learning they must wait two hours;
 * the ceiling itself is enforced inside the write, because a guard only the
 * screen respects is not a guard.
 */
export async function getWaitAction(rawPublicKey: string): Promise<WaitState> {
  const session = await sessionFor(rawPublicKey);
  if (!session) return { ok: false, reason: 'no_session' };

  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc('widget_music_request_wait', {
    p_public_key: session.publicKey,
    p_member_id: session.claims.memberId,
  });

  if (error) {
    logger.error(
      { publicKey: session.publicKey, code: error.code, message: error.message },
      'widget: music_request_wait failed',
    );
    return { ok: false, reason: 'failed' };
  }

  const answer = readAnswer(data);
  if (!answer) return { ok: false, reason: 'failed' };
  if (!answer.ok) return { ok: false, reason: recordRefusal(answer.reason) };

  return { ok: true, waitSeconds: answer.waitSeconds ?? 0 };
}

