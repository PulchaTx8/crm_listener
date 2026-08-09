import { createServiceClient } from '@/lib/supabase/service-client';
import { PostgresRateLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { authenticate } from '@/lib/api/credentials';
import { mapPostgresError } from '@/lib/api/errors';
import { apiError, guardRequest, jsonOk, requestId } from '@/lib/api/respond';
import { normaliseSong, songIntakeSchema } from '@/schemas/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const REQUESTS_PER_MINUTE = 120;

/**
 * Endpoint 1 (design spec §5): register a song's record with every dependency it
 * names, idempotently.
 *
 * IT IS EXCLUDED FROM THE MIDDLEWARE MATCHER (src/middleware.ts), and that is
 * load-bearing rather than tidy. An automation holds no session cookie, so
 * matched it would pay a Supabase Auth round trip and then be answered with a
 * 307 to /login -- and none of this would run. That defect reached both the
 * webhook route and the worker tick before it, and NOTHING HERE CAN BE TESTED
 * FOR IT: this file's tests import the handler and call it directly, which is
 * precisely how it survived twice.
 *
 * ONE DATABASE DOOR, and everything it writes is one transaction. Resolving the
 * artist, the label, the genre and the album from four round trips here would
 * leave orphan rows in a Station's catalogue on any failure after the first
 * write, with nothing to explain where they came from.
 */
export async function POST(request: Request): Promise<Response> {
  const id = requestId(request);

  const guard = guardRequest(request, id);
  if (guard) return guard;

  const supabase = createServiceClient();

  let auth;
  try {
    auth = await authenticate(supabase, request.headers.get('authorization'), 'music.manage');
  } catch (cause) {
    // A failed lookup is ours, not theirs. Answering 401 here would send a
    // correct integrator off to rotate a key that was never the problem.
    logger.error({ err: cause, requestId: id }, 'api: credential lookup failed');
    return apiError('internal', 'The request could not be completed.', 500, id);
  }

  if (!auth.ok) {
    return auth.code === 'forbidden_scope'
      ? apiError('forbidden_scope', 'This key does not hold music.manage.', 403, id)
      : apiError('unauthorized', 'That key is not usable.', 401, id);
  }

  // PER CREDENTIAL, NOT PER IP: an automation has one address, so an IP limit
  // would be one bucket for every Station this server serves. And the Postgres
  // limiter rather than the in-memory one the Deezer tab uses -- with
  // `output: 'standalone'` there may be several instances, each with its own
  // counter, which is acceptable for a person clicking and not for a machine.
  const gate = await new PostgresRateLimiter(supabase).check(
    `api:songs:${auth.credentialId}`,
    REQUESTS_PER_MINUTE,
    60,
  );
  if (!gate.allowed) {
    const retryAfter = Math.max(1, Math.ceil((gate.resetAt.getTime() - Date.now()) / 1000));
    return apiError('rate_limited', 'Too many requests.', 429, id, undefined, {
      'retry-after': String(retryAfter),
    });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return apiError('malformed_json', 'That body is not JSON.', 400, id);
  }

  const parsed = songIntakeSchema.safeParse(raw);
  if (!parsed.success) {
    return apiError(
      'invalid_payload',
      'That body was refused.',
      422,
      id,
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }

  const song = normaliseSong(parsed.data);

  // Checked HERE rather than in the schema because either may arrive through
  // `deezer`, and a schema-level requirement would refuse a perfectly good
  // Deezer payload for lacking a field it never carries under that name.
  const { title, artistName } = song;
  if (!title || !artistName) {
    return apiError(
      'invalid_payload',
      'A song needs a title and an artist.',
      422,
      id,
      [
        title ? null : { path: 'title', message: 'Required' },
        artistName ? null : { path: 'artist', message: 'Required' },
      ].filter((detail): detail is { path: string; message: string } => detail !== null),
    );
  }

  // `?? undefined` on every optional argument, the convention services/music.ts
  // already follows: a parameter declared `default null` in SQL is generated as
  // OPTIONAL, so `null` is not among its types. Sending undefined omits it and
  // lets the default apply, which is what "absent" means here.
  const { data, error } = await supabase.rpc('api_register_song', {
    p_credential_id: auth.credentialId,
    p_company_id: auth.companyId,
    p_org: auth.organizationId,
    p_title: title,
    p_artist_name: artistName,
    p_external_id: song.externalId ?? undefined,
    p_label_name: song.labelName ?? undefined,
    p_genre_name: song.genreName ?? undefined,
    p_album_title: song.albumTitle ?? undefined,
    p_nationality: song.nationality ?? undefined,
    p_vocal: song.vocal ?? undefined,
    p_duration_seconds: song.durationSeconds ?? undefined,
    p_isrc: song.isrc ?? undefined,
    p_internal_code: song.internalCode ?? undefined,
    p_deezer_track_id: song.deezerTrackId ?? undefined,
    p_deezer_album_id: song.deezerAlbumId ?? undefined,
    p_upc: song.upc ?? undefined,
    p_cover_md5: song.coverMd5 ?? undefined,
    p_release_date: song.releaseDate ?? undefined,
  });

  if (error) {
    const mapped = mapPostgresError(error.code, error.message);
    // Logged with the raw text, answered without it: the fault may be ours and
    // the message may carry a database error, which is not something to publish
    // into somebody else's log file.
    logger.error(
      { err: error, requestId: id, credentialId: auth.credentialId },
      'api: register song failed',
    );
    return apiError(mapped.code, mapped.message, mapped.status, id);
  }

  const result = data as unknown as { song_id: string; created: boolean };
  return jsonOk(result, result.created ? 201 : 200, id);
}
