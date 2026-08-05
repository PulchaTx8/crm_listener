import { z } from 'zod';

/**
 * The shared envelope 0118–0120 all three return: `period`, `stations`,
 * `cards`, `monthly`, `breakdowns`, `top`, `withheld`. One file covers all
 * three because the three migrations' own headers say so explicitly —
 * 0119's: "the withheld key is still present and empty, so the three
 * payloads share one shape and one Zod schema."
 *
 * THE ONE THING HERE THAT MUST NOT MOVE (D13). A figure the caller's
 * permissions cannot support is OMITTED from the payload and named in
 * `withheld` instead of zeroed — `jsonb_strip_nulls` on the Postgres side is
 * what turns a `null` value into an absent key. `.optional()` is the only
 * correct mirror of "absent key" in Zod: `.nullable()` would accept a key
 * that is present and `null` (which these functions never send and jsonb
 * arrives to jsonb_strip_nulls stripped entirely), `.default(0)` or a `??`
 * anywhere on this path would silently turn "you may not see this" back into
 * "zero" — the exact confusion D13 exists to prevent, undone by one keystroke.
 * The rule below is: wherever a migration's own `case when ... else null end`
 * can produce the null that gets stripped, the matching schema field here is
 * `.optional()`, never `.default(...)`, never `.catch(...)`.
 *
 * `jsonb` arrives over `.rpc(...)` as `unknown` (`Json` in
 * `database.types.ts`), and `schema.parse(data)` in `services/dashboards.ts`
 * is what makes the return type true — never an `as` cast, which would only
 * assert the shape without checking it.
 *
 * THE THREE `cards` OBJECTS ARE `.strict()`, and nothing else in this file is.
 * Zod's default is to STRIP an unknown key silently, which on a D13 payload is
 * the wrong default in one specific direction: `cards` is the object where a
 * key's presence or absence carries the meaning, so a typo'd key name in a
 * migration would leave the real figure absent (rendered as "withheld", a
 * permission claim that is false) while the misspelled one was quietly
 * discarded — a page that lies with nothing failing. Strict turns that into a
 * parse error somebody has to look at. THE COST, stated because a future
 * author will meet it: deploys here run `supabase db push` before the
 * frontend, so a migration that ADDS a card to one of these functions makes
 * that dashboard throw until the matching schema line ships. Add the field
 * here first, deploy, then add it in SQL — the reverse of the order the
 * runbook's `reports.consolidated` trap warns about, and for the opposite
 * reason.
 */

// ---------------------------------------------------------------------------
// The pieces every dashboard payload is built from
// ---------------------------------------------------------------------------

/**
 * One figure, both windows. `previous` is `.optional()` for a different
 * reason than the withheld fields below — not a permission the caller lacks,
 * but a comparison that would not mean anything (`live_now`, `overdue`: see
 * 0120's own header on why "a fact about right now" carries no `previous`
 * key at all). Never a `.default(0)`, for the same reason as everywhere else
 * in this file: a `previous` of 0 and a `previous` that was never asked for
 * are not the same claim.
 */
export const cardSchema = z.object({
  current: z.number(),
  previous: z.number().optional(),
});
export type Card = z.infer<typeof cardSchema>;

/**
 * One bar or list entry, shared across every breakdown and every top-ten in
 * this file. `id` and `key` are both optional because no single producer
 * uses both: `blocks_by_kind`, `nationality`, `vocal` and
 * `participation_status`/`prize_cycle` each carry `key` (an enum value or a
 * fixed code) and no `id`; `discovery_source`, `first_contact_origin`,
 * `top.songs`, `top.genres` and `top.promotions` each carry `id` (a raw
 * value or a uuid) and no `key`. `id` is nullable as well as optional because
 * a discovery-source bucket's `id` is `coalesce(m.discovery_source, '')` —
 * never actually null on the wire today, but the column itself is nullable
 * and this schema should not fail the day a future edit stops coalescing it.
 */
export const sliceSchema = z.object({
  id: z.string().nullable().optional(),
  key: z.string().optional(),
  label: z.string(),
  count: z.number(),
});
export type Slice = z.infer<typeof sliceSchema>;

/** One bucket of a twelve-month bar chart: `{ month: 'YYYY-MM', count }'. */
export const monthPointSchema = z.object({
  month: z.string(),
  count: z.number(),
});
export type MonthPoint = z.infer<typeof monthPointSchema>;

/**
 * The chosen window and its comparison window, both dates — `preset` is
 * carried back verbatim rather than re-derived, so the screen can highlight
 * the active button without recomputing what the database already resolved.
 */
export const periodSchema = z.object({
  preset: z.string(),
  from: z.string(),
  to: z.string(),
  previous_from: z.string(),
  previous_to: z.string(),
});
export type Period = z.infer<typeof periodSchema>;

/**
 * One Station named in the payload — every one the caller's Station ids
 * resolved to, consolidated or not.
 *
 * `from` and `to` are this Station's OWN resolved window, and they are here
 * because D5 (as amended on 2026-08-05) keeps presets resolving from `now()`
 * at each Station's clock. On the turn of a month a Station at UTC+14 and one
 * at UTC−3 resolve **different calendar months**, so `period` above — the
 * overall bounds — is not a claim about any individual Station. A screen that
 * printed one date range over a consolidated set would be asserting a
 * uniformity the query does not provide; these are what let it notice the
 * disagreement and name the Stations it applies to instead. `to` is exclusive,
 * exactly as `period.to` is.
 */
export const stationSchema = z.object({
  id: z.string(),
  name: z.string(),
  timezone: z.string(),
  from: z.string(),
  to: z.string(),
});
export type Station = z.infer<typeof stationSchema>;

/** One entry of `withheld`: which figure, and the permission that would fill it in. */
export const withheldSchema = z.object({
  figure: z.string(),
  needs: z.string(),
});
export type Withheld = z.infer<typeof withheldSchema>;

// ---------------------------------------------------------------------------
// get_audience_dashboard (0118)
// ---------------------------------------------------------------------------

const audienceCardsSchema = z.object({
  listeners: cardSchema,
  new_listeners: cardSchema,
  /** Withheld without participations.view (D13) — omitted, never zeroed. */
  took_part: cardSchema.optional(),
  barred: cardSchema,
}).strict();

const audienceBreakdownsSchema = z.object({
  blocks_by_kind: z.array(sliceSchema),
});

const audienceTopSchema = z.object({
  discovery_source: z.array(sliceSchema),
  first_contact_origin: z.array(sliceSchema),
});

export const audienceDashboardSchema = z.object({
  period: periodSchema,
  stations: z.array(stationSchema),
  cards: audienceCardsSchema,
  monthly: z.array(monthPointSchema),
  breakdowns: audienceBreakdownsSchema,
  top: audienceTopSchema,
  withheld: z.array(withheldSchema),
});
export type AudienceDashboard = z.infer<typeof audienceDashboardSchema>;

// ---------------------------------------------------------------------------
// get_music_dashboard (0119) — nothing here is ever withheld (D13): every
// table it reads is gated by music.view, this panel's own gate. The
// `withheld` key stays because the payload shape is shared, not because this
// panel ever populates it.
// ---------------------------------------------------------------------------

const musicCardsSchema = z.object({
  catalogue: cardSchema,
  new_songs: cardSchema,
  requests: cardSchema,
}).strict();

const musicBreakdownsSchema = z.object({
  nationality: z.array(sliceSchema),
  vocal: z.array(sliceSchema),
});

const musicTopSchema = z.object({
  songs: z.array(sliceSchema),
  genres: z.array(sliceSchema),
});

export const musicDashboardSchema = z.object({
  period: periodSchema,
  stations: z.array(stationSchema),
  cards: musicCardsSchema,
  monthly: z.array(monthPointSchema),
  breakdowns: musicBreakdownsSchema,
  top: musicTopSchema,
  withheld: z.array(withheldSchema),
});
export type MusicDashboard = z.infer<typeof musicDashboardSchema>;

// ---------------------------------------------------------------------------
// get_promotions_dashboard (0120) — the panel where D13 bites hardest.
// participations.view gates the whole entry side: cards.participations,
// cards.distinct_participants, breakdowns.participation_status, top.promotions
// AND the top-level `monthly` key itself, which 0120's own header explains is
// omitted rather than emptied because an empty twelve-month chart reads as
// "nobody took part", the same false claim a zero card would make. The prize
// cycle (cards.awarded/overdue, breakdowns.prize_cycle) is unaffected: winners
// answers to promotions.view alone.
// ---------------------------------------------------------------------------

const promotionsCardsSchema = z.object({
  /** No `previous` at all — a fact about this instant, not the chosen period. */
  live_now: cardSchema,
  ended: cardSchema,
  participations: cardSchema.optional(),
  distinct_participants: cardSchema.optional(),
  awarded: cardSchema,
  /** No `previous` either, for the same reason as `live_now`. */
  overdue: cardSchema,
}).strict();

const promotionsBreakdownsSchema = z.object({
  participation_status: z.array(sliceSchema).optional(),
  prize_cycle: z.array(sliceSchema),
});

const promotionsTopSchema = z.object({
  promotions: z.array(sliceSchema).optional(),
});

export const promotionsDashboardSchema = z.object({
  period: periodSchema,
  stations: z.array(stationSchema),
  cards: promotionsCardsSchema,
  /** The whole key is absent, not an empty array, without participations.view. */
  monthly: z.array(monthPointSchema).optional(),
  breakdowns: promotionsBreakdownsSchema,
  top: promotionsTopSchema,
  withheld: z.array(withheldSchema),
});
export type PromotionsDashboard = z.infer<typeof promotionsDashboardSchema>;
