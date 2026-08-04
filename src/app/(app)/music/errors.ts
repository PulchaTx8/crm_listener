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
 * Every read these screens perform — listCompanyAccess, listMusicReferences,
 * listSongsPage, getSongById, listArtistsPage, getArtistById, getArtistSongs
 * — only ever throws InternalError today: none of them call an RPC, so none
 * of the write-side codes mapMusicError (services/music.ts) maps can surface
 * here. The full taxonomy is handled anyway: collapsing it to a single
 * generic message would work today and silently stop being true the moment a
 * read starts going through an RPC.
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
