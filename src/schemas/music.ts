import { z } from 'zod';

/**
 * Mirrors 0100/0101. Every bound here exists so that a refusal the database
 * would make anyway arrives as a field-level message instead of a round trip
 * — the reasoning schemas/inventory.ts sets out for its own.
 */

/** The four short lists 0100's music_reference_kind carries. NOT 7b's merge kinds, which drop SHOW and add SONG. */
export const MUSIC_REFERENCE_KINDS = ['GENRE', 'LABEL', 'ARTIST', 'SHOW'] as const;
export type MusicReferenceKind = (typeof MUSIC_REFERENCE_KINDS)[number];

export const MUSIC_NATIONALITIES = ['DOMESTIC', 'INTERNATIONAL'] as const;
export const MUSIC_VOCALS = ['MALE', 'FEMALE', 'DUO', 'GROUP', 'INSTRUMENTAL'] as const;

/** The one bound on a search term, exported so screens enforce this number rather than a copy of it. */
export const SONG_SEARCH_MAX_LENGTH = 100;

// `text` in Postgres has no length of its own, so an unbounded field here
// would let the form store what no screen could display or compare — the same
// reasoning prizeFormSchema gives internal_code.
const name = z.string().trim().min(1, 'Give it a name.').max(160);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === null || v === undefined || v === '' ? undefined : v));

/**
 * An untouched `<select>` posts an empty string, and a format or enum check
 * refuses it before any `.transform()` could normalise it away — so emptiness
 * is resolved BEFORE validation here, not after. `optionalText` above does the
 * same work in a plain `.transform()` and can, because it carries no format
 * check; doing it differently in the two places would leave one module
 * disagreeing with itself about what an empty field means.
 */
const blankToUndefined = (v: unknown) =>
  v === null || v === undefined || v === '' ? undefined : v;

const optionalUuid = z.preprocess(blankToUndefined, z.string().uuid().optional());

export const referenceFormSchema = z.object({
  companyId: z.string().uuid(),
  kind: z.enum(MUSIC_REFERENCE_KINDS),
  name,
  legacyId: optionalText(120),
});

export type ReferenceFormInput = z.infer<typeof referenceFormSchema>;

export const referenceUpdateSchema = referenceFormSchema.omit({ companyId: true }).extend({
  id: z.string().uuid(),
});

export type ReferenceUpdateInput = z.infer<typeof referenceUpdateSchema>;

export const songFormSchema = z.object({
  companyId: z.string().uuid(),
  title: z.string().trim().min(1, 'Give the song a title.').max(200),
  // Required, and the message says why rather than naming a field: 0101
  // refuses this too, and a song without an artist is a draft, not a record.
  artistId: z.string().uuid('Choose an artist — a song without one is a draft.'),
  labelId: optionalUuid,
  genreId: optionalUuid,
  // Same reasoning as optionalUuid above: an untouched select posts '', and
  // an enum check refuses it before any transform could normalise it away.
  nationality: z.preprocess(blankToUndefined, z.enum(MUSIC_NATIONALITIES).optional()),
  vocal: z.preprocess(blankToUndefined, z.enum(MUSIC_VOCALS).optional()),
  // 0098's check is `duration_seconds is null or duration_seconds > 0`, and
  // the column is an integer. All three refusals happen here first.
  durationSeconds: z
    .number()
    .int('A duration is a whole number of seconds.')
    .positive('A duration is greater than zero.')
    .nullable()
    .optional(),
  internalCode: optionalText(40),
  legacyId: optionalText(120),
});

export type SongFormInput = z.infer<typeof songFormSchema>;

/**
 * Updating a song names the song, never its Station: update_song (0101)
 * resolves the Organization AND the Company from the song row itself, so a
 * companyId here would be a value the RPC ignores — and a parameter that looks
 * like it decides something while deciding nothing is how a caller ends up
 * believing it can move a song between Stations.
 */
export const songUpdateSchema = songFormSchema.omit({ companyId: true }).extend({
  songId: z.string().uuid(),
});

export type SongUpdateInput = z.infer<typeof songUpdateSchema>;
