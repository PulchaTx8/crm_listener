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
export function describeMusicReadError(cause: unknown): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof NotFoundError) {
    return 'That could not be found. Refresh the page and try again.';
  }
  if (cause instanceof UnauthorizedError) {
    return 'You do not have permission to view the music catalogue in this Station.';
  }
  if (cause instanceof ValidationError) return cause.message;
  // Generic on purpose: InternalError means the fault is ours, not theirs,
  // and its message may carry a raw database error — not something to show.
  return 'Could not load the catalogue. Refresh the page and try again.';
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
export function describeMusicWriteError(cause: unknown, action: string): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof BusinessRuleError) {
    return `You cannot ${action} yet — it still has other records registered against it. Move or archive them first.`;
  }
  if (cause instanceof NotFoundError) {
    return 'That could not be found. Refresh the page and try again.';
  }
  if (cause instanceof UnauthorizedError) {
    return `You do not have permission to ${action} in this Station.`;
  }
  if (cause instanceof ValidationError) return cause.message;
  // Generic on purpose: InternalError means the fault is ours, not theirs,
  // and its message may carry a raw database error — not something to show.
  return 'Could not save. Refresh the page and try again.';
}

/**
 * A merge's own refusals. Separate from describeMusicWriteError because its
 * NotFoundError sentence ("refresh and try again") is right for a stale record
 * dialog and misleading here: a merge's P0002 means one of the records the
 * operator ticked is gone, archived, or — deliberately indistinguishable — in
 * another Station, and "refresh the page" is the correct advice for only the
 * first of those.
 */
export function describeMergeError(cause: unknown): string {
  if (cause instanceof NotFoundError) {
    return 'One of the records you selected is no longer available — it may have been archived or merged by somebody else. Refresh the list and start again.';
  }
  if (cause instanceof UnauthorizedError) {
    return 'You do not have permission to merge records in this Station.';
  }
  if (cause instanceof ValidationError) return cause.message;
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof ConflictError) return cause.message;
  return 'Could not merge. Refresh the page and try again.';
}

/**
 * describeMusicReadError's taxonomy, worded for the Maintenance screen's own
 * page-load read. Task 7's review flagged this exactly: listMergeCandidates
 * is gated on `music.merge`, not `music.view` like every other read this
 * taxonomy already served, so describeMusicReadError's fixed
 * UnauthorizedError sentence ("you do not have permission to view the music
 * catalogue in this Station") would misname the permission a caller is
 * actually missing here. Checked against 0108: list_merge_candidates raises
 * `42501` the identical way every other RPC in this taxonomy does, so that
 * one branch is the only thing that needed its own wording — every other
 * branch is delegated rather than copied, since a merge candidate read
 * throws through the same mapMusicError taxonomy as everything else.
 *
 * Not describeMergeError: that function's NotFoundError sentence
 * ("...may have been archived or merged by somebody else. Refresh the list
 * and start again.") is written for the merge ACTION's own P0002, a case
 * list_merge_candidates cannot raise at all — it names no record id, so
 * there is nothing for it to find missing. Reusing describeMergeError here
 * would be exactly the misapplied-branch mistake this function's own
 * UnauthorizedError fix is closing.
 */
export function describeMaintenanceReadError(cause: unknown): string {
  if (cause instanceof UnauthorizedError) {
    return 'You do not have permission to merge records in this Station.';
  }
  return describeMusicReadError(cause);
}
