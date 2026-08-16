import { z } from 'zod';

/**
 * Mirrors 0100/0101. Every bound here exists so that a refusal the database
 * would make anyway arrives as a field-level message instead of a round trip
 * — the reasoning schemas/inventory.ts sets out for its own.
 */

/**
 * The five short lists 0100's music_reference_kind carries since 0204. Not the
 * merge's kinds (MUSIC_MERGE_KINDS below): that set adds SONG and keeps SHOW,
 * after the owner ruled for merge_shows on 2026-08-04, and does NOT include
 * SONGWRITER — whether duplicate songwriters need collapsing is not yet known,
 * and a merge is the one operation in this domain that destroys. This line used
 * to say the merge would drop SHOW, which 0105 corrects at the database as well.
 *
 * SONGWRITER is last because the enum appends (0204 added it as CATEGORY, 0209
 * renamed the value in place): `alter type ... add value` without BEFORE/AFTER
 * puts it at the end, `rename value` does not move it, and
 * 15_music_rpcs.test.sql pins the order. Keeping this array in the same order
 * means the two never have to be read against each other.
 */
export const MUSIC_REFERENCE_KINDS = ['GENRE', 'LABEL', 'ARTIST', 'SHOW', 'SONGWRITER'] as const;
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

/**
 * Two letters of country, three alphanumerics of registrant, two digits of
 * year and five of designation — 0138's `songs_isrc_shape`, restated here so
 * the refusal arrives as a field message instead of a round trip.
 *
 * Folded to upper case BEFORE the check, and 0138/0140 fold it again before
 * storing. An operator reading a code off a sleeve will not shift-lock, and
 * the database check accepts upper case only — so without this a perfectly
 * correct ISRC typed in lower case is refused as malformed, which is the kind
 * of message that makes people distrust a form.
 */
const isrc = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toUpperCase() || undefined : blankToUndefined(v)),
  z
    .string()
    .regex(/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/, 'An ISRC looks like BRPGD9800678.')
    .optional(),
);

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
  // Block 27, under Block 28's word. Optional, like the label and the genre
  // beside it, and for the reason 0205 gives songs.songwriter_id: the whole
  // catalogue predates the column, so requiring one would make every existing
  // song unsavable. optionalUuid rather than optionalText because an untouched
  // <select> posts '' and a uuid check refuses it before any transform could
  // normalise it away — the same trap the comment above optionalUuid sets out.
  songwriterId: optionalUuid,
  // Block 13a. Both hand-editable (design D7), and both reach create_song
  // (0140) and update_song (0138). There is deliberately no deezerTrackId
  // beside them: that column has one write path, 0139's two doors, and a
  // schema field for it would be the first step back towards the hole 0102
  // closed for legacy_id.
  albumId: optionalUuid,
  isrc,
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
/**
 * ... and `internalCode` is dropped for the third time on the same reasoning,
 * in Block 27. The field left the Song data tab for the Integration tab, so
 * this form stopped carrying it — and 0208 removed update_song's
 * p_internal_code parameter for exactly the reason 0102 removed p_legacy_id: an
 * update form that never carries a value forward is indistinguishable, to the
 * RPC, from somebody who cleared it, and every ordinary save would have erased
 * the code. set_song_integration_code is the write path now, and
 * songIntegrationFormSchema below is what feeds it.
 */
export const songUpdateSchema = songFormSchema
  .omit({ companyId: true, legacyId: true, internalCode: true })
  .extend({ songId: z.string().uuid() });

export type SongUpdateInput = z.infer<typeof songUpdateSchema>;

/**
 * Block 27. The card describing one song in the customer's own system (0207).
 *
 * The bounds are save_song_integration's own, restated here for the reason this
 * file's header gives — a refusal the database would make anyway arrives as a
 * field message rather than a round trip — and for a second reason the rest of
 * this file has never needed: TWO CALLERS PARSE THIS SCHEMA. The Integration
 * tab's form does, and so does the JSON import
 * (src/lib/song-integration-file.ts), on a file the operator supplies. One
 * definition rather than two is what stops a file being accepted with a value
 * the form would have refused.
 *
 * `code` is required and `title`/`artistName`/`categoryName` are not: a card
 * whose code is known and whose words are not yet filled in is a legitimate
 * thing to save, and the door clears what it is not sent.
 */
export const songIntegrationSchema = z.object({
  code: z.string().trim().min(1, 'Give the card an integration code.').max(40),
  title: optionalText(200),
  artistName: optionalText(160),
  categoryName: optionalText(160),
});

export type SongIntegrationInput = z.infer<typeof songIntegrationSchema>;

/**
 * What the Integration tab posts.
 *
 * `companyId` is a real parameter, unlike songUpdateSchema's absent one, because
 * save_song_integration takes it: a card is keyed by (company_id, code) and
 * there is no row to resolve the Station from before the first save.
 *
 * `songId` is here because the tab performs TWO writes — the code belongs to the
 * song and the three words belong to the card — and set_song_integration_code
 * (0208) resolves its own Station from that row rather than trusting the
 * companyId beside it.
 */
export const songIntegrationFormSchema = songIntegrationSchema.extend({
  companyId: z.string().uuid(),
  songId: z.string().uuid(),
});

export type SongIntegrationFormInput = z.infer<typeof songIntegrationFormSchema>;

/**
 * What the Deezer register form posts (Block 13a).
 *
 * Names, not ids — create_song_from_deezer (0139) resolves or creates all four
 * references inside the same transaction as the song, so a failure anywhere
 * leaves no orphan artist behind. The bounds match the reference tables' own
 * `name` column bound above.
 *
 * There is deliberately NO deezerTrackId here. The track id, the album id, the
 * cover hash, the UPC and the release date are not things a person types and
 * are not validated as if they were: they travel in hidden fields the tab
 * filled, and 0139 is the only write path to any of them (design D6).
 */
export const deezerRegistrationSchema = z.object({
  title: z.string().trim().min(1, 'Give the song a title.').max(200),
  artistName: z
    .string()
    .trim()
    .min(1, 'A song without an artist is a draft — name one.')
    .max(160),
  labelName: optionalText(160),
  genreName: optionalText(160),
  albumTitle: optionalText(160),
  isrc,
});

export type DeezerRegistrationInput = z.infer<typeof deezerRegistrationSchema>;

/**
 * 12 to 14 digits -- albums_upc_shape (0136), restated here so a malformed
 * barcode arrives as a field message rather than a round trip to the RPC's
 * own check-constraint violation. Blank clears it (create_album and
 * update_album both take that as "no UPC"), the same reading optionalText
 * above gives every other optional text field.
 */
const upc = z.preprocess(
  blankToUndefined,
  z.string().regex(/^[0-9]{12,14}$/, 'A UPC is 12 to 14 digits.').optional(),
);

/**
 * `<input type="date">` posts yyyy-mm-dd or '' -- the shape Postgres's `date`
 * cast already accepts, so this exists only to turn an implausible
 * hand-crafted value into a field message rather than a raw cast error at
 * create_album/update_album.
 */
const releaseDate = z.preprocess(
  blankToUndefined,
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'That date could not be read. Pick it again.')
    .optional(),
);

/**
 * The Albums screen's create form (catalog/albums), Block 20c. Unlike
 * referenceFormSchema's four tables, an album is not a name and a legacy id
 * (0136): it carries a UPC and a release date too, and create_album (0137)
 * takes both as optional parameters of its own -- registering a record with
 * some fields left blank is an intention somebody had, the reasoning 0187's
 * header gives for why create_album keeps its defaults while update_album
 * lost its.
 */
export const albumFormSchema = z.object({
  companyId: z.string().uuid(),
  title: z.string().trim().min(1, 'Give the album a title.').max(160),
  upc,
  releaseDate,
});

export type AlbumFormInput = z.infer<typeof albumFormSchema>;

/**
 * The album record dialog's save (catalog/albums), on update_album (0187):
 * title, UPC and release date are the three fields it replaces on EVERY
 * call, none of them optional at the RPC -- omitting either is 42883, not a
 * clear. `upc`/`releaseDate` parse to `undefined` here, the same `optional()`
 * as albumFormSchema's above (a blank box means "no value" whichever form it
 * is typed into); the create/update actions differ only in what they DO with
 * that undefined -- createAlbumAction passes it straight through to
 * create_album's own default, updateAlbumAction coalesces it to `null`
 * because update_album has none to fall back on.
 */
export const albumUpdateSchema = z.object({
  albumId: z.string().uuid(),
  title: z.string().trim().min(1, 'Give the album a title.').max(160),
  upc,
  releaseDate,
});

export type AlbumUpdateInput = z.infer<typeof albumUpdateSchema>;

/** The five 0105's music_merge_kind carries. Shows are here on the owner's 2026-08-04 ruling. */
export const MUSIC_MERGE_KINDS = ['SONG', 'ARTIST', 'LABEL', 'GENRE', 'SHOW'] as const;
export type MusicMergeKind = (typeof MUSIC_MERGE_KINDS)[number];

export const MUSIC_REQUEST_CHANNELS = ['MANUAL', 'IMPORT'] as const;

/**
 * The two derived statuses 0189 stores as GENERATED ALWAYS columns and 0190's
 * three doors write the stamps behind. Defined here, not in services/music.ts
 * where the rest of Block 22's requests surface lives, because
 * src/services/music.ts:1 is `import 'server-only'` and
 * music/requests/list-params.ts (Task 5) needs REQUEST_LIMIT_MIN/MAX at
 * runtime from a module in the client graph (requests-filters.tsx is
 * 'use client' and imports from list-params.ts). This file is already
 * imported by that same client component for MUSIC_REQUEST_CHANNELS, so it is
 * the client-safe home; services/music.ts re-exports both types (erased at
 * compile time, so re-exporting them from a server-only module is harmless)
 * and both constants (re-exported as values, not redefined, so there is
 * exactly one definition for the URL parser and the RPC to agree on).
 */
export type MusicRequestReadStatus = 'UNREAD' | 'READ' | 'CANCELLED';
export type MusicRequestPlayStatus = 'NOT_PLAYED' | 'PLAYED' | 'CANCELLED';

/**
 * The four orderings the Requests screen offers. `requested` is the one a
 * keyset cursor can walk — list_music_requests (0191) orders by
 * (requested_at desc, id desc) for it and compares exactly those columns —
 * so it is also the only one that pages.
 */
export type RequestSortKey = 'requested' | 'song' | 'artist' | 'show';

/** The bounds the URL parser and the RPC both enforce, exported so neither can drift from the other. */
export const REQUEST_LIMIT_MIN = 1;
export const REQUEST_LIMIT_MAX = 200;

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
    // Validated here, logged on a write failure (maintenance/actions.ts),
    // and carried in the confirmation dialog's hidden input — but never sent
    // to Postgres: mergeMusicRecords (services/music.ts) posts only
    // p_winner_id/p_loser_ids/p_reason to the door, and every one of 0106's
    // five doors resolves the Station from the WINNER row itself, inside the
    // scoped lock, rather than trusting a caller-supplied id. Read this field
    // as a courtesy for the UI's own bookkeeping (which Station's screen is
    // this?), not as a tenancy guard — there isn't one here to be. Fix round
    // 1 added this comment after a Critical found the actual boundary
    // (MergePanel's own React state persisting across a Company switch) one
    // layer up, in the UI that builds this input, not in this schema.
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
    // 200, matching record-request-form.tsx's own maxLength and the pattern
    // this form copies (participationFormSchema.fullName /
    // record-participation-form.tsx, both 200) — this used to say 160, a
    // bound the browser's input never enforced, so a name between 161 and
    // 200 characters passed the form and was refused only at the RPC.
    fullName: optionalText(200),
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
