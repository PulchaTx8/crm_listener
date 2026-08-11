import { z } from 'zod';

/**
 * Block 17b. What a listener's browser posts from the widget's music panel, and
 * the only shapes the server actions in `src/app/(widget)/w/[publicKey]/` will
 * act on.
 *
 * STRICT, the rule `src/schemas/widget.ts` states for the same boundary and for
 * the same reason: a field name this product does not know did not come from
 * the form this product renders. Nothing here is a third-party payload, so
 * there is no `.passthrough()` to make an exception for.
 */

/**
 * What the visitor typed into the search box.
 *
 * TWO CHARACTERS MINIMUM, matching the panel's own debounce guard. One letter
 * is not a search: it costs a Deezer call and returns twenty arbitrary rows.
 * The maximum is a cap on a string that becomes a rate-limit key — a ceiling
 * keyed by something a caller can vary without limit is not a ceiling, which is
 * the reasoning `publicKeySchema` already carries.
 */
export const searchSchema = z
  .object({ query: z.string().trim().min(2).max(120) })
  .strict();

/**
 * The chosen recording, and what the listener wanted to say about it.
 *
 * THE TRACK ID IS THE WHOLE PAYLOAD (D4). The server fetches the recording from
 * Deezer itself, so a browser cannot name the title, the artist or the album
 * that lands in a Station's catalogue.
 *
 * PARSED, NOT COERCED. `z.coerce.number()` reads like the same rule and is not:
 * it accepts '1.5', it turns '' into 0, and it trims ' 12 ' into 12. A Deezer
 * id is a positive integer with no leading zero or it is nothing — the same
 * instinct `verifySchema` applies to keeping a six-digit code a string with a
 * regex rather than a number.
 */
export const requestSongSchema = z
  .object({
    deezerTrackId: z
      .string()
      .regex(/^[1-9]\d{0,17}$/, 'not the shape of a Deezer track id')
      .transform((value) => Number(value)),
    /**
     * 500 is `music_requests_note_length` (0167), repeated here so a refusal
     * from the database is never the first news of it.
     *
     * An empty note becomes `undefined` rather than `''`: the column is
     * nullable and "the listener wrote nothing" is an absence, not an empty
     * string somebody later has to remember to test for.
     */
    note: z
      .string()
      .trim()
      .max(500)
      .transform((value) => (value.length === 0 ? undefined : value))
      .optional(),
    /**
     * Block 18. Which programme the song is for, or absent for any time.
     *
     * OPTIONAL BY DESIGN (D6): a listener who just wants a song played should
     * not have to answer a question about scheduling. An unchosen select posts
     * an empty string, which becomes `undefined` here rather than a failed
     * parse — the same shape `note` above takes for the same reason.
     *
     * The id is checked for SHAPE only. Whether it names a programme of THIS
     * Station is `widget_record_music_request`'s to decide, and it does:
     * anything else resolves to null rather than reaching the row.
     */
    showId: z
      .string()
      .trim()
      .regex(
        /^$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        'not the shape of a programme id',
      )
      .transform((value) => (value.length === 0 ? undefined : value))
      .optional(),
  })
  .strict();

export type SearchInput = z.infer<typeof searchSchema>;
export type RequestSongInput = z.infer<typeof requestSongSchema>;
