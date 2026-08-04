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
 * `action` phrase — "register songs", "save this song", "archive this song"
 * and so on — so a 403 reads as "you cannot do THIS, here" rather than a
 * generic "music" refusal. mapMusicError (services/music.ts) itself only ever
 * throws UnauthorizedError with the raw Postgres text ("permission denied:
 * music.manage required") — it names the permission code, not the action in
 * the person's own words, so that message is rewritten here rather than
 * passed through.
 *
 * ConflictError and BusinessRuleError already carry a complete, specific
 * sentence from mapMusicError's own mapping: a duplicate legacy id names the
 * handle, and a refused archive over a live reference names the count of
 * rows still using it. Those pass through verbatim — replacing either with
 * something generic would throw away the one detail the person actually
 * needed to read.
 */
export function describeMusicWriteError(cause: unknown, action: string): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof BusinessRuleError) return cause.message;
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
