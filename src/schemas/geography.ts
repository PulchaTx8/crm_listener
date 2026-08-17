import { z } from 'zod';

/**
 * Block 28. What 0215's two aggregates return, checked rather than asserted.
 *
 * The RPC answers `jsonb`, which arrives as `unknown`; `schema.parse(data)` —
 * never an `as` cast — is the one place that makes the declared type true. The
 * same reasoning schemas/dashboards.ts sets out for its own three.
 */

const placePrecision = z.enum(['neighbourhood', 'city', 'region', 'country']);

const geographyPlace = z.object({
  /** The folded key 0214's member_place_key built. Carried through so a screen can key a list by it. */
  key: z.string(),
  /**
   * The names come from `geocoded_places`, not from the listener's own columns:
   * two listeners who wrote "sao luis" and "São Luís" share a key and must
   * share a label, or one dot renders under two spellings. Nullable because a
   * place resolved at country level has no city to name.
   */
  city: z.string().nullable(),
  neighbourhood: z.string().nullable(),
  latitude: z.number(),
  longitude: z.number(),
  /**
   * Shown, not just stored. A dot at a city's centroid and a dot on an actual
   * neighbourhood look identical on a map and mean very different things.
   */
  precision: placePrecision.nullable(),
  count: z.number().int(),
});

export const audienceGeographySchema = z.object({
  places: z.array(geographyPlace),
  /**
   * The coverage line's two numbers. `withPlace` is how many of `total` have a
   * coordinate — a panel says "412 of 1,208 listeners are on this map" rather
   * than showing 412 dots and implying that is everybody.
   */
  with_place: z.number().int(),
  /** By construction, get_audience_dashboard's `listeners` figure for the same window (0215, D11). */
  total: z.number().int(),
});

export const musicGeographySchema = z.object({
  places: z.array(
    geographyPlace.extend({
      /** The most-requested song in this place — the whole reason the music map differs from the audience one. */
      top_song: z.string().nullable(),
      top_song_count: z.number().int().nullable(),
    }),
  ),
  with_place: z.number().int(),
  total: z.number().int(),
});

export type AudienceGeography = z.infer<typeof audienceGeographySchema>;
export type MusicGeography = z.infer<typeof musicGeographySchema>;
export type GeographyPlace = AudienceGeography['places'][number];
export type MusicGeographyPlace = MusicGeography['places'][number];
