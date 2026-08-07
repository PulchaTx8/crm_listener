// Kept synchronous and free of 'use server' (mirrors inventory/errors.ts) so a
// Server Component (music/songs/page.tsx, and the Artists/Requests screens
// that follow it) can call describeMusicReadError directly without an
// unnecessary await.
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';

/**
 * Shared by all three music screens (Songs, Artists/catalogue, Requests),
 * which is why this sits at `music/` and not `music/songs/` — one taxonomy
 * for the whole block rather than three copies drifting apart, the same
 * reasoning inventory/errors.ts gives for its own two functions.
 *
 * listCompanyAccess, listMusicReferences, listSongsPage, getSongById,
 * listArtistsPage, getArtistById and getArtistSongs still only ever throw
 * InternalError: none of them call an RPC, so none of the write-side codes
 * mapMusicError (services/music.ts) maps can surface from them. Block 7b adds
 * two reads that break that pattern on purpose: listMusicRequestsPage and
 * listMergeCandidates go through list_music_requests and list_merge_candidates,
 * both SECURITY DEFINER and gated on a permission check, so their errors are
 * mapMusicError's like a write's — a 42501 is a genuinely reachable case from
 * a read now, not a hypothetical one. The full taxonomy was handled here
 * anyway, which is exactly what makes that change require no edit to this
 * function: collapsing it to a single generic message would have worked
 * until this moment and silently stopped being true at it.
 */
export function describeMusicReadError(
  cause: unknown,
  t: (key: string, values?: Record<string, string>) => string,
): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof NotFoundError) {
    return t('thatCouldNotBeFound');
  }
  if (cause instanceof UnauthorizedError) {
    return t('youDoNotHavePermissionToViewTheCatalogue');
  }
  if (cause instanceof ValidationError) return cause.message;
  // Generic on purpose: InternalError means the fault is ours, not theirs,
  // and its message may carry a raw database error — not something to show.
  return t('couldNotLoadTheCatalogue');
}

/**
 * Same taxonomy as describeMusicReadError, worded for a write instead of a
 * page load. Each mutating action across the three screens passes its own
 * `action` phrase — "register songs", "save this song", "archive this song",
 * "archive this artist" and so on — so a 403 reads as "you cannot do THIS,
 * here" rather than a generic "music" refusal. mapMusicError (services/music.ts)
 * itself only ever throws UnauthorizedError with the raw Postgres text
 * ("permission denied: music.manage required") — it names the permission
 * code, not the action in the person's own words, so that message is
 * rewritten here rather than passed through.
 *
 * ConflictError already carries a complete, specific sentence from
 * mapMusicError's own mapping — a duplicate legacy id names the handle — and
 * passes through verbatim: replacing it with something generic would throw
 * away the one detail the person actually needed to read.
 *
 * BusinessRuleError does not: mapMusicError's `23503` branch is the ONLY
 * place this taxonomy ever constructs one, and that branch fires from a
 * single source — archive_music_reference's refusal while a live song (or,
 * for a show, a live request) still names the record being archived — with
 * one message written for all four reference kinds at once: "this record is
 * still used by N live row(s); change them first". It cannot say "artist" or
 * "songs" because the RPC that raises it does not know which screen is
 * calling; naming the record's kind is this function's job, done with the
 * `action` phrase the caller already passed for the 403 case above (every
 * archive action in this block phrases it "archive this <kind>").
 */
export function describeMusicWriteError(
  cause: unknown,
  t: (key: string, values?: Record<string, string>) => string,
  actionKey: string,
): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof BusinessRuleError) {
    return t('youCannotYetItStillHasRecords', { action: t(actionKey) });
  }
  if (cause instanceof NotFoundError) {
    return t('thatCouldNotBeFound');
  }
  if (cause instanceof UnauthorizedError) {
    return t('youDoNotHavePermissionToHere', { action: t(actionKey) });
  }
  if (cause instanceof ValidationError) return cause.message;
  // Generic on purpose: InternalError means the fault is ours, not theirs,
  // and its message may carry a raw database error — not something to show.
  return t('couldNotSave');
}

/**
 * A merge's own refusals. Separate from describeMusicWriteError because its
 * NotFoundError sentence ("refresh and try again") is right for a stale record
 * dialog and misleading here: a merge's P0002 means one of the records the
 * operator ticked is gone, archived, or — deliberately indistinguishable — in
 * another Station, and "refresh the page" is the correct advice for only the
 * first of those.
 */
export function describeMergeError(
  cause: unknown,
  t: (key: string, values?: Record<string, string>) => string,
): string {
  if (cause instanceof NotFoundError) {
    return t('oneOfTheRecordsYouSelected');
  }
  if (cause instanceof UnauthorizedError) {
    return t('youDoNotHavePermissionToMerge');
  }
  if (cause instanceof ValidationError) return cause.message;
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof ConflictError) return cause.message;
  return t('couldNotMerge');
}

// describeMaintenanceReadError briefly lived here (Task 9's first pass):
// listMergeCandidates's list_merge_candidates (0108) originally checked
// music.merge, not music.view like every other read this taxonomy serves,
// so describeMusicReadError's fixed "...view the music catalogue..."
// sentence would have misnamed the permission a 403 was actually about.
// Fix round 1 corrected the mismatch at its real source instead: 0108 is now
// gated on music.view (see that migration's own comment for why — D8 scopes
// music.merge to the five doors that actually destroy something, and this
// read leaks nothing a music.view caller could not already assemble by
// hand). That also fixed a Critical the gate change surfaced: page.tsx reads
// this list and getMusicPermissions in one Promise.all, so gating the READ
// on music.merge made `permissions.merge === false` and "the read already
// threw" the same event — the Maintenance screen's own required read-only
// mode could never render. With the gate now music.view,
// describeMusicReadError's existing sentence is correct again, so the
// Maintenance screen's page.tsx uses it directly and this describer is gone.
