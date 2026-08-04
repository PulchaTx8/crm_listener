import { z } from 'zod';

/**
 * Mirrors 0100/0101. Every bound here exists so that a refusal the database
 * would make anyway arrives as a field-level message instead of a round trip
 * — the reasoning schemas/inventory.ts sets out for its own.
 */

/**
 * The four short lists 0100's music_reference_kind carries. Not the merge's
 * kinds (MUSIC_MERGE_KINDS below): that set adds SONG and keeps SHOW, after
 * the owner ruled for merge_shows on 2026-08-04. This line used to say the
 * merge would drop SHOW, which 0105 corrects at the database as well.
 */
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

/**
 * `legacyId` is dropped here, not merely left unread by a caller: 0102
 * removed update_music_reference's p_legacy_id parameter entirely, after a
 * form that carried the field forward unset (it renders read-only, with no
 * `name` attribute) silently erased it on every ordinary save. Keeping the
 * field on this schema would let a caller build a payload the RPC has no way
 * to accept — a parameter that looks like it decides something while
 * deciding nothing is exactly what 0101's own comment on create_song warns
 * against, one layer up. `legacyId` stays on referenceFormSchema above: that
 * is the create path, and create_music_reference still takes it.
 */
export const referenceUpdateSchema = referenceFormSchema
  .omit({ companyId: true, legacyId: true })
  .extend({ id: z.string().uuid() });

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
 *
 * `legacyId` is dropped for the same reason `companyId` is, and it is the
 * more serious of the two: 0102 removed update_song's p_legacy_id parameter
 * entirely, after the read-only legacy-id field (no `name` attribute, so it
 * never reached FormData) left every ordinary save omitting it — which the
 * pre-0102 RPC took as "set it to null", silently erasing a song's ETL
 * handle on its very first edit. There is no longer an RPC parameter to send
 * this value to, so the schema does not accept it either. `legacyId` stays
 * on songFormSchema above: that is the create path, and create_song still
 * takes it.
 */
export const songUpdateSchema = songFormSchema
  .omit({ companyId: true, legacyId: true })
  .extend({ songId: z.string().uuid() });

export type SongUpdateInput = z.infer<typeof songUpdateSchema>;

/** The five 0105's music_merge_kind carries. Shows are here on the owner's 2026-08-04 ruling. */
export const MUSIC_MERGE_KINDS = ['SONG', 'ARTIST', 'LABEL', 'GENRE', 'SHOW'] as const;
export type MusicMergeKind = (typeof MUSIC_MERGE_KINDS)[number];

export const MUSIC_REQUEST_CHANNELS = ['MANUAL', 'IMPORT'] as const;

/**
 * A reason has to fit in a sentence somebody will read in six months.
 * `text` in Postgres has no length of its own, so the bound is here.
 */
export const MERGE_REASON_MAX_LENGTH = 300;

/**
 * Mirrors 0106's three refusals, so each arrives as a field-level message
 * instead of a round trip: a blank reason, an empty loser list, and a survivor
 * named among the losers.
 *
 * The duplicate collapse is here as well as in the core. The core dedupes
 * because a repeated id would archive one record and write two history rows
 * claiming different child counts for it; this dedupes because a checkbox list
 * that somehow submits the same id twice should not depend on the database to
 * be correct about it.
 */
export const mergeFormSchema = z
  .object({
    companyId: z.string().uuid(),
    kind: z.enum(MUSIC_MERGE_KINDS),
    winnerId: z.string().uuid('Choose which record stays.'),
    loserIds: z
      .array(z.string().uuid())
      .min(1, 'Choose at least one record to absorb.')
      .transform((ids) => [...new Set(ids)]),
    reason: z
      .string()
      .trim()
      .min(1, 'Say why these are the same record.')
      .max(MERGE_REASON_MAX_LENGTH),
  })
  .refine((v) => !v.loserIds.includes(v.winnerId), {
    message: 'The record that stays cannot also be one of the ones being absorbed.',
    path: ['winnerId'],
  });

export type MergeFormInput = z.infer<typeof mergeFormSchema>;

/**
 * Blank means "now" — create_music_request (0107) takes it as
 * `coalesce(p_requested_at, now())`, so omitting the key and sending an
 * empty one mean the same thing. Anything else has to be a real instant:
 * this is the shape fromZonedWallClock (promotions/zone.ts) always produces
 * (`new Date(...).toISOString()`), and Task 7's review flagged that this
 * field carried no check of its own before this — an unparseable string
 * would sail through `optionalText` untouched and reach Postgres's own
 * `timestamptz` cast, which answers with an opaque internal error rather
 * than a field-level message, the one thing this file's own top comment
 * says every bound here exists to avoid. z.string().datetime() is Zod's
 * strict ISO-8601 UTC check (a 'Z' suffix required, arbitrary sub-second
 * precision allowed) rather than a bare `Date.parse` — narrower on purpose,
 * since the only legitimate source of a non-blank value is that one
 * `toISOString()` call, and anything else is either a bug in this form or a
 * hand-crafted request.
 */
const optionalInstant = z.preprocess(
  blankToUndefined,
  z.string().datetime({ message: 'That date could not be read. Pick it again.' }).optional(),
);

/**
 * Manual entry, which has two shapes because Block 3's deduplication has two:
 * the operator either picked a listener from the search results (`memberId`)
 * or typed enough to find-or-create one (`fullName` and at least one
 * identifier). resolveOrCreateMember (services/participations.ts) is what
 * turns the second into the first, and the form calls it before the request
 * door — the same two doors record-participation-form.tsx already has.
 *
 * D5: `songId` is required and there is no free-text alternative. A request
 * points at a catalogued song or it is not recorded.
 */
export const requestFormSchema = z
  .object({
    companyId: z.string().uuid(),
    songId: z.string().uuid('Choose a song — a request never points at free text.'),
    showId: optionalUuid,
    memberId: optionalUuid,
    requestedAt: optionalInstant,
    fullName: optionalText(160),
    phone: optionalText(40),
    email: optionalText(160),
    cpf: optionalText(20),
    passport: optionalText(40),
  })
  .refine((v) => Boolean(v.memberId) || Boolean(v.fullName), {
    message: 'Pick a listener, or give a name to register one.',
    path: ['memberId'],
  });

export type RequestFormInput = z.infer<typeof requestFormSchema>;
