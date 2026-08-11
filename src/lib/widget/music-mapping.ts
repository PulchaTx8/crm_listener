import type { DeezerFailureReason, DeezerTrack } from '@/lib/integrations/deezer/transport';

/**
 * Block 17b. The pure half of `music-actions.ts`.
 *
 * IT LIVES HERE TO BE TESTABLE. A module carrying `'use server'` may export
 * nothing but async functions, so a mapping left in that file cannot be
 * imported by a test at all -- and two of the guarantees below are the kind
 * that should fail a suite rather than a code review.
 */

/** What a listener's browser is given. Deliberately not `DeezerTrack`. */
export interface WidgetTrack {
  id: number;
  title: string;
  artistName: string;
  albumTitle: string;
  coverMd5: string | null;
  durationSeconds: number;
}

/**
 * ONE FIELD IS ARGUED FOR BY ITS ABSENCE: `previewUrl`.
 *
 * `transport.ts` says in writing that Deezer signs it with
 * `hdnea=exp=<unix>~hmac=…` and that it must not be stored in a column, a cache
 * or a form field -- it works in testing and is dead in production the next
 * day. A server action's return value is serialised into the page, which is a
 * form field with extra steps, so this drops it rather than trusting every
 * future caller to remember.
 *
 * `albumId` goes too, for a different reason: the browser has no use for it.
 * The server resolves the album from the track it fetched itself (D4).
 */
export function toWidgetTrack(track: DeezerTrack): WidgetTrack {
  return {
    id: track.id,
    title: track.title,
    artistName: track.artistName,
    albumTitle: track.albumTitle,
    coverMd5: track.coverMd5,
    durationSeconds: track.durationSeconds,
  };
}

export type SearchRefusal =
  | 'invalid'
  | 'no_session'
  | 'rate_limited'
  | 'deezer_quota'
  | 'deezer_unavailable'
  | 'failed';

export type RequestRefusal =
  | 'invalid'
  | 'no_session'
  | 'rate_limited'
  | 'cooldown'
  | 'listener_anonymized'
  | 'unknown_installation'
  | 'not_found'
  | 'deezer_quota'
  | 'deezer_unavailable'
  | 'failed';

/**
 * Deezer's four failure reasons, narrowed to the two sentences a visitor can
 * act on: wait a moment, or something is wrong at our end. `not-found` is
 * handled by the caller where it means something specific.
 */
export function deezerRefusal(reason: DeezerFailureReason): SearchRefusal {
  return reason === 'quota' ? 'deezer_quota' : 'deezer_unavailable';
}

/**
 * A reason from 0167, narrowed to one this application has a sentence for.
 *
 * AN UNRECOGNISED VALUE BECOMES `failed` rather than reaching the client
 * verbatim. The panel renders a message per reason, and a reason with no
 * message renders as nothing at all -- the failure mode where the box simply
 * does nothing when submitted, which is worse than an error.
 *
 * `unknown_listener` is deliberately NOT passed through as itself. The door
 * uses it both for a listener belonging to another Station and for one that
 * does not exist; from a visitor's side those are the same fact, neither is
 * something they can act on, and what they CAN do is identify again.
 */
export function recordRefusal(reason: string | null): RequestRefusal {
  switch (reason) {
    case 'cooldown':
    case 'listener_anonymized':
    case 'unknown_installation':
      return reason;
    case 'unknown_listener':
      return 'no_session';
    default:
      return 'failed';
  }
}
