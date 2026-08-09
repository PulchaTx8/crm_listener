import { z } from 'zod';

/**
 * The two request bodies, and the one place Deezer's own shape is understood.
 *
 * STRICT EVERYWHERE EXCEPT INSIDE `song.deezer`. For an automation a mistyped
 * field name must fail on the first test run rather than disappear for six
 * months, so an unknown key at our own boundary is a 422. The Deezer object is
 * the exception on purpose: it is a third party's payload, Deezer may add to it
 * at any time, and the integration must not break the day it does.
 */

// songs_isrc_shape (0138): two letters of country, three of registrant, two of
// year, five of designation. Accepted in either case here and folded to upper by
// apply_song_intake, because neither an operator reading a sleeve nor a calling
// system will reliably shift-lock.
const ISRC = /^[A-Za-z]{2}[A-Za-z0-9]{3}[0-9]{7}$/;

// albums.cover_md5 (0136) and coverUrl (lib/integrations/deezer/cover.ts) both
// insist on a plain MD5. Refused here so the failure names the field rather than
// a constraint.
const MD5 = /^[0-9a-f]{32}$/;

const albumSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    release_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    upc: z.string().trim().max(50).optional(),
    cover_md5: z.string().regex(MD5, 'a cover hash is a plain md5').optional(),
    deezer_album_id: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Deezer's own track object, as `/search` returns it.
 *
 * Every field is optional, including `id` and `title`: this schema's job is to
 * describe what may arrive, and whether enough arrived is decided after
 * normalisation, where a flat `title` can have supplied what the Deezer object
 * did not.
 *
 * `.passthrough()` is the deliberate exception to strictness described above.
 */
const deezerTrackSchema = z
  .object({
    id: z.number().int().positive().optional(),
    title: z.string().trim().min(1).max(300).optional(),
    duration: z.number().int().nonnegative().optional(),
    // Present on /track/{id} and ABSENT from /search -- verified against a live
    // payload on 2026-08-09. Accepted because a caller that made the extra call
    // should not have to drop it.
    isrc: z.string().regex(ISRC).optional(),
    artist: z
      .object({ name: z.string().trim().min(1).max(300).optional() })
      .passthrough()
      .optional(),
    album: z
      .object({
        id: z.number().int().positive().optional(),
        title: z.string().trim().min(1).max(300).optional(),
        md5_image: z.string().regex(MD5).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const songBody = {
  external_id: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  artist: z.string().trim().min(1).max(300).optional(),
  label: z.string().trim().min(1).max(300).optional(),
  genre: z.string().trim().min(1).max(300).optional(),
  nationality: z.enum(['DOMESTIC', 'INTERNATIONAL']).optional(),
  vocal: z.enum(['MALE', 'FEMALE', 'DUO', 'GROUP', 'INSTRUMENTAL']).optional(),
  duration_seconds: z.number().int().nonnegative().optional(),
  isrc: z.string().regex(ISRC, 'that is not an ISRC').optional(),
  internal_code: z.string().trim().min(1).max(100).optional(),
  album: albumSchema.optional(),
  deezer_track_id: z.number().int().positive().optional(),
  deezer: deezerTrackSchema.optional(),
};

/**
 * Endpoint 1's body.
 *
 * `title` and `artist` are REQUIRED by the endpoint but optional here, because
 * either may arrive through `deezer` instead. Requiring them at this layer would
 * refuse a perfectly good Deezer payload; the route checks them after
 * normalisation, where both sources have been considered.
 */
export const songIntakeSchema = z.object(songBody).strict();
export type SongIntake = z.infer<typeof songIntakeSchema>;

export const musicRequestSchema = z
  .object({
    external_id: z.string().trim().min(1).max(200).optional(),
    listener: z
      .object({
        phone: z.string().trim().min(5).max(40),
        // Optional here, required by the door when the listener is NEW (design
        // D6). The distinction cannot be made at this layer, which does not know
        // whether the Station has seen this phone before.
        name: z.string().trim().min(1).max(200).optional(),
      })
      .strict(),
    song: z.object(songBody).strict(),
    show: z.string().trim().min(1).max(300).optional(),
    requested_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type MusicRequestIntake = z.infer<typeof musicRequestSchema>;

export interface NormalisedSong {
  externalId: string | null;
  title: string | null;
  artistName: string | null;
  labelName: string | null;
  genreName: string | null;
  albumTitle: string | null;
  nationality: 'DOMESTIC' | 'INTERNATIONAL' | null;
  vocal: 'MALE' | 'FEMALE' | 'DUO' | 'GROUP' | 'INSTRUMENTAL' | null;
  durationSeconds: number | null;
  isrc: string | null;
  internalCode: string | null;
  deezerTrackId: number | null;
  deezerAlbumId: number | null;
  upc: string | null;
  coverMd5: string | null;
  releaseDate: string | null;
}

/**
 * Folds `deezer` into the flat shape the database doors take.
 *
 * THE FLAT FIELDS WIN. Somebody who sent `title` alongside a Deezer object was
 * being explicit, and this API does not overrule that -- the same instinct
 * registerFromDeezerAction follows when it reads every reference out of the form
 * rather than out of the payload the dialog was opened with.
 *
 * `label`, `genre`, `upc` and `release_date` have NO Deezer source here, and
 * that is not an omission: /search carries none of them. They come from
 * /album/{id}, which the route calls itself (design D7).
 */
export function normaliseSong(input: SongIntake): NormalisedSong {
  const d = input.deezer;
  const pick = <T>(explicit: T | undefined, fromDeezer: T | undefined): T | null =>
    explicit ?? fromDeezer ?? null;

  return {
    externalId: input.external_id ?? null,
    title: pick(input.title, d?.title),
    artistName: pick(input.artist, d?.artist?.name),
    labelName: input.label ?? null,
    genreName: input.genre ?? null,
    albumTitle: pick(input.album?.title, d?.album?.title),
    nationality: input.nationality ?? null,
    vocal: input.vocal ?? null,
    durationSeconds: pick(input.duration_seconds, d?.duration),
    isrc: pick(input.isrc, d?.isrc),
    internalCode: input.internal_code ?? null,
    deezerTrackId: pick(input.deezer_track_id, d?.id),
    deezerAlbumId: pick(input.album?.deezer_album_id, d?.album?.id),
    upc: input.album?.upc ?? null,
    // Deezer carries md5_image on the track AND on the album; they are the same
    // hash. The ALBUM's is read because the column it lands in belongs to the
    // album -- Block 13a's design D5: the cover lives on the album, not on the
    // song.
    coverMd5: pick(input.album?.cover_md5, d?.album?.md5_image),
    releaseDate: input.album?.release_date ?? null,
  };
}
