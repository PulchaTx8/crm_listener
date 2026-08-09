import { createServiceClient } from '@/lib/supabase/service-client';
import { PostgresRateLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { deezerTransport } from '@/lib/integrations/deezer';
import { authenticate } from '@/lib/api/credentials';
import { mapPostgresError } from '@/lib/api/errors';
import { apiError, guardRequest, jsonOk, requestId } from '@/lib/api/respond';
import { musicRequestSchema, normaliseSong, type NormalisedSong } from '@/schemas/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const REQUESTS_PER_MINUTE = 60;

/**
 * Deezer's quota is per IP, and every Station shares this server's address --
 * the same fact deezer-actions.ts records for the operator-facing tab. So the
 * enrichment gets a budget of its own, separate from the endpoint's, and one
 * Station cannot spend the whole installation's.
 */
const DEEZER_CALLS_PER_MINUTE = 30;

/**
 * Endpoint 2 (design spec §6): record what a listener asked for, registering the
 * song by endpoint 1's rules if the Station does not have it.
 *
 * Excluded from the middleware matcher for the reason the songs route's comment
 * sets out in full.
 *
 * ONE DATABASE DOOR again: the listener, the link, the song, its four references
 * and the request are one transaction. The Deezer call below happens BEFORE that
 * transaction opens, which is the only place it could go -- an outbound HTTP
 * request cannot live inside a plpgsql body, and would hold a transaction open
 * across the network if it could.
 */
export async function POST(request: Request): Promise<Response> {
  const id = requestId(request);

  const guard = guardRequest(request, id);
  if (guard) return guard;

  const supabase = createServiceClient();

  let auth;
  try {
    auth = await authenticate(supabase, request.headers.get('authorization'), 'music.request');
  } catch (cause) {
    logger.error({ err: cause, requestId: id }, 'api: credential lookup failed');
    return apiError('internal', 'The request could not be completed.', 500, id);
  }

  if (!auth.ok) {
    return auth.code === 'forbidden_scope'
      ? apiError('forbidden_scope', 'This key does not hold music.request.', 403, id)
      : apiError('unauthorized', 'That key is not usable.', 401, id);
  }

  const limiter = new PostgresRateLimiter(supabase);
  const gate = await limiter.check(`api:requests:${auth.credentialId}`, REQUESTS_PER_MINUTE, 60);
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

  const parsed = musicRequestSchema.safeParse(raw);
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

  const song = await enrich(normaliseSong(parsed.data.song), auth.companyId, limiter);

  const { data, error } = await supabase.rpc('api_record_music_request', {
    p_credential_id: auth.credentialId,
    p_company_id: auth.companyId,
    p_org: auth.organizationId,
    p_phone: parsed.data.listener.phone,
    p_request_external_id: parsed.data.external_id ?? undefined,
    p_listener_name: parsed.data.listener.name ?? undefined,
    p_show_name: parsed.data.show ?? undefined,
    p_requested_at: parsed.data.requested_at ?? undefined,
    p_song_external_id: song.externalId ?? undefined,
    p_title: song.title ?? undefined,
    p_artist_name: song.artistName ?? undefined,
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
    logger.error(
      { err: error, requestId: id, credentialId: auth.credentialId },
      'api: record music request failed',
    );
    return apiError(mapped.code, mapped.message, mapped.status, id);
  }

  const result = data as unknown as { created: boolean };
  return jsonOk(result, result.created ? 201 : 200, id);
}

/**
 * Design D7. Deezer's `/search` carries no record label, genre, UPC or release
 * date -- verified against a live payload on 2026-08-09, and the reason the
 * external application is not asked to make a second call of its own.
 *
 * BEST EFFORT, NEVER FATAL, copying prefillFromDeezerAction rather than
 * inventing a second behaviour: everything this would add is optional on both
 * the song and the album, and refusing to record a listener's request because an
 * enriching call failed would trade the whole action for three fields nobody
 * asked for.
 *
 * SKIPPED ENTIRELY when the caller already sent both, and skipped when the
 * Station is over its Deezer budget -- in both cases the record simply enters
 * without them, which is the same outcome a failed lookup produces.
 *
 * There is deliberately NO second call to /track/{id} for the ISRC. The Deezer
 * tab makes none either; songs registered from a search live without an ISRC and
 * an operator types it later. Matching that beats diverging from it.
 */
async function enrich(
  song: NormalisedSong,
  companyId: string,
  limiter: PostgresRateLimiter,
): Promise<NormalisedSong> {
  if (song.deezerAlbumId === null) return song;
  if (song.labelName !== null && song.genreName !== null) return song;

  const gate = await limiter.check(`api:deezer:${companyId}`, DEEZER_CALLS_PER_MINUTE, 60);
  if (!gate.allowed) {
    logger.warn({ companyId }, 'api: deezer budget spent; recording without the album');
    return song;
  }

  const found = await deezerTransport().album(song.deezerAlbumId);
  if (!found.ok) {
    logger.warn(
      { reason: found.reason, albumId: song.deezerAlbumId },
      'api: deezer album lookup failed; recording without it',
    );
    return song;
  }

  // `??` on every field, never an overwrite: what the caller sent explicitly
  // outranks what the catalogue says, the same precedence normaliseSong applies
  // between the flat fields and the Deezer object.
  return {
    ...song,
    labelName: song.labelName ?? found.value.label,
    genreName: song.genreName ?? found.value.genreName,
    upc: song.upc ?? found.value.upc,
    releaseDate: song.releaseDate ?? found.value.releaseDate,
    coverMd5: song.coverMd5 ?? found.value.coverMd5,
    albumTitle: song.albumTitle ?? found.value.title,
  };
}
