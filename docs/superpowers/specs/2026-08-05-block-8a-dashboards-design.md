# Block 8a — Three dashboards, one period, and the timezone that makes them true — Design Spec

**Date:** 2026-08-05
**Status:** approved by the owner
**Splits:** master spec §11 Block 8 — this half ships the three dashboards; the report engine, the three export formats, asynchronous generation and `saved_reports` are **Block 8b**
**Depends on:** Block 3 (members), Block 4 (promotions and participations), Block 6 (draws, winners, the pickup deadline), Block 7 (the music catalogue and its requests)

---

## 1. What this block is for

Sixteen blocks have written data into this system and **nothing reads it back as a number.** An operator can list listeners one page at a time, open a promotion and count its entries by eye, and see which prizes are awaiting pickup — but nobody can answer "how many listeners did this Station gain last month", "which song did the audience ask for most", or "of the prizes we drew this quarter, how many were actually collected".

The master spec §11 names three dashboards, and this block builds them: **Audience**, **Music** and **Promotions**, each over a Station or a consolidated set of Stations, each sliced by a period computed **in the Station's own timezone** (requirement L2).

---

## 2. Decisions

### D1 — Block 8 ships in two halves, and this is the first

The block as written in §11 is two subsystems that do not depend on each other: read-only aggregation with charts, and a file factory with a queue, storage and a history table. A report needs no dashboard to exist. The owner's ruling of 2026-08-05 splits them, on the same reasoning that split Block 6 into four: a diff carrying SQL aggregation, three file formats, a worker and a screen is a diff nobody reviews.

**8a is this document.** 8b is the report engine, Excel/CSV/PDF export, asynchronous generation and `saved_reports`.

### D2 — Each panel is gated by its own domain's permission. There is no `dashboards.view`

Audience requires `members.view`, Music requires `music.view`, Promotions requires `promotions.view` — codes that already exist and already gate the corresponding lists.

A single new code covering all three was rejected because it opens exactly the hole a dashboard is good at opening: **a counter is a small leak of a fact the caller was not allowed to see.** Someone without `members.view` would learn how many listeners the Station has, where they came from, and how many arrived last month, without ever being able to open the list they were counted from.

One code is new: **`reports.consolidated`** (master spec §7 names it). See D3.

### D3 — The consolidated view sums only Stations the caller could already see one at a time

Selecting more than one Station requires `reports.consolidated` **in every Station in the selection**, on top of the domain permission in each. Holding it in one Station does not confer a group-wide view.

The rule exists so the consolidated total can never be an oracle: every number in it is a number the caller could have produced by visiting each Station's own panel in turn.

### D4 — Aggregation runs in `SECURITY INVOKER` functions, so RLS keeps applying

Every `SECURITY DEFINER` function in this codebase has to **restate by hand each predicate RLS used to apply for free**. `0095_list_pickups.sql` documents four such rules in its header and records that one of them — an archived promotion's rows staying hidden — was lost for five commits and caught only by the isolation suite.

An aggregate carries the same risk with a worse symptom. A list that leaks a row looks wrong; **a count that includes rows the caller may not read looks like a number.**

So the three functions are `SECURITY INVOKER`: they run as the caller, the existing select policies apply inside them, and the multi-tenant cut is structural rather than remembered. What each function still does by hand is the permission check on its first lines — `has_permission` per Station, raising `42501` — because a caller without the permission must be told so, not shown a screen of zeros. **Zero and "you may not see this" must never render alike.**

This is a deliberate departure from the `SECURITY DEFINER` shape used by `list_pickups` and `list_participations`. Those functions decide per row what to disclose (a listener's name only with `members.view`, and null otherwise), which requires reading data before deciding. An aggregate makes no per-row disclosure decision: it counts what the caller may read, and that is precisely what RLS already answers.

### D5 — The period travels as local dates. Presets are resolved in SQL, per Station

The period is a pair of **dates**, not instants: `p_from` inclusive, `p_to` exclusive. For a **custom** range the dates are identical for every Station in the selection, and each converts them with its own timezone inside the query — `p_from::timestamp at time zone c.timezone` — which is what makes requirement L2 true for a group whose radios sit in different timezones.

**For a preset, the dates are not always identical, and the first draft of this decision claimed they were.** Presets resolve from `now()` at each Station's clock (below), so on the turn of a month a Station at UTC+14 and one at UTC−3 resolve *different calendar months*. The owner's ruling of 2026-08-05, taken after the whole-branch review surfaced it: **keep the per-Station resolution.** Each Station measures its own month, which is what requirement L2 asks for and what "how did the group do last month" actually means — a Station is not well measured by a calendar it does not live in.

What changes is the reporting, not the arithmetic. The payload carries **each Station's own resolved dates** alongside its id and timezone, and the screen's note fires when those dates disagree — naming the Stations that differ — rather than asserting unconditionally that the dates are the same everywhere. A page must never claim a uniformity the query does not provide.

The presets `current_month`, `previous_month` and `current_year` are resolved **in SQL, per Station**, from `now() at time zone c.timezone`. Resolving them in Node would use the server's clock, and the server runs UTC: three hours of error puts the last evening of a month into the next one, in every card on the page, silently. `0062_ingest_whatsapp_event.sql` and `0112_sweep_pickup_reminders.sql` already carry this rule for what a listener is told; this is the same rule applied to what the owner is shown.

The half-open window matches the convention `0040` set for a promotion's own window and `situationOf()` restates: a period is over at the instant it ends, not a moment after.

### D6 — The comparison is the immediately preceding window of the same length

Every flow card carries a second number: the same measure over the window immediately before, of equal length — the previous month for `current_month`, the previous year for `current_year`, the preceding N days for a custom range of N days. Both windows are computed in one call, by the same function, per Station.

Stock cards (how many listeners exist, how large the catalogue is) are measured **as of the end of each window** rather than as of now, so a historical period compares two true totals instead of comparing the past against today.

### D7 — Recharts, as §3.1 named

The owner's ruling of 2026-08-05, against the alternative of hand-rolled server-rendered SVG. `recharts@3.10.1` declares `react ^19` among its peers, so there is no peer conflict with this project's React; it also declares `react-is`, which the install must carry. It is the **first third-party UI dependency this project has taken** — there is no TanStack Table, no React Hook Form, no chart library today — so the CI `build` job is what proves the bundle still closes.

Charts are client components taking serializable props from the server page. Colours come from CSS variables, so the dark theme is not a second palette to maintain.

### D8 — The vocal and nationality breakdowns carry every value, plus "not stated"

Master spec §4.2 describes the Music dashboard's last two indicators as "domestic/international" and "male/female". **`music_vocal` has five values** — `MALE`, `FEMALE`, `DUO`, `GROUP`, `INSTRUMENTAL` — and both `songs.vocal` and `songs.nationality` are nullable.

A two-slice chart would silently drop duets, groups, instrumentals and every song whose attribute was never filled in, and the slices would not add up to the total shown beside them. Both breakdowns therefore carry **all of their enum's values plus an explicit "not stated" bucket**, and the sum of the buckets equals the request total by construction.

### D9 — A new listener at a Station is a new *link*, not a new *member*

Members are Organization-scoped (`0031`); `member_company_links` is what attaches one to a Station. "New in the period" therefore counts `member_company_links.linked_at`, **not** `members.created_at`.

A listener who already existed at a sister Station and entered this one last week is new *here*, and `members.created_at` would place them years ago, in an Organization they were never counted for at this Station at all.

### D9b — A suspended Station is already refused, and nothing here re-implements that

`has_company_access` requires `status = 'active'`, so `has_permission` returns false for a suspended Station and the functions of §4 raise `42501` for one without a line of new code. `listCompanyAccess` already returns suspended Stations in a separate list that the selector renders with the reason and never lets anyone pick. Both behaviours are inherited; neither is restated.

### D10 — "Active in the period" means they did something, and the something is named

There is no activity status on a member. The only evidence of activity the data holds is a participation or a music request, so the figure counts **distinct members with at least one participation in the window**, and the screen labels it "took part in the period" rather than "active", so the number cannot be read as a claim the data does not support.

**Music requests are deliberately not part of it,** though they are equally good evidence. `music_requests` is gated by `music.view` and `participations` by `participations.view` (D13): a definition spanning both would mean something different for almost every caller, and the Music panel already reports requests to the callers who may see them.

### D11 — The promotion-situation rule gets a second copy, deliberately

A promotion has no status column: its situation is derived from `starts_at`, `ends_at` and `cancelled_at` by `situationOf()` (`src/lib/promotion-situation.ts:14`), which the promotions grid and the record dialog both use. An aggregate has to classify in SQL, which makes a second copy of a rule this project's own history says is exactly where defects hide.

It is accepted rather than avoided, with three conditions: the SQL states the same half-open window; each copy names the other in a comment; and **both are tested at the same boundary instants** — a pgTAP test on the SQL side and a Vitest test on the TypeScript side, over the instant a promotion starts, the instant it ends, and the instant after.

### D12 — A cancelled draw's winners are not counted

`cancel_draw` (`0079`) reverses the prize unit but deliberately leaves `winners.status` at `AWAITING_PICKUP` — 6a has no vocabulary for "un-awarded". `list_pickups` (`0095`) and `sweep_pickup_deadlines` (`0094`) both exclude these rows, each documenting why in its own header.

The Promotions dashboard is the third reader to treat `AWAITING_PICKUP` as live, so it carries the same exclusion: **a winner whose draw was cancelled counts toward nothing** — not prizes awarded, not the pickup cycle, not the overdue figure. Counting them would report prizes handed out that were taken back before anyone was told.

### D12b — Every Audience figure counts the same people

Deleted and anonymised members are excluded from **every** figure on the Audience panel, not only from the headline total.

Found while implementing Task 3, where the total excluded them and "took part" and "barred" did not, because those two read `participations` and `member_blocks` without joining `members`. Both readings are defensible in isolation — the erased person's participation did happen — but together they let the page print *1,234 listeners* above *1,300 took part*, and a reader has no way to learn that the two numbers count different populations. One panel, one population.

The cost is accepted and named: activity by someone since erased is undercounted. Anonymisation is rare, the undercount is small, and the alternative is a page that contradicts itself in public.

### D13 — A figure the caller's permissions cannot support is withheld, never zeroed

Because aggregation runs as the caller (D4), a figure drawn from a table gated by a permission **other than its panel's own** returns nothing for a caller who lacks it — and nothing would render as a zero indistinguishable from a true one. D4 refuses that confusion at the panel level; this is the same rule one level down, and it is the price of D4 rather than an argument against it.

Exactly one table crosses the line: **`participations`, gated by `participations.view`** (`0053`), which neither `members.view` nor `promotions.view` implies. It feeds the Audience panel's "took part" figure and the Promotions panel's whole entry side — the count, the refusal breakdown, the distinct listeners and the busiest-promotions list. The prize cycle does not cross it: `winners` is gated by `promotions.view` (`0075`), which is the Promotions panel's own gate.

Where the caller lacks `participations.view` **in any selected Station**, the function omits those figures and names them in a `withheld` array in the payload; the screen renders each as an em dash beside the permission that would fill it. A caller gets a smaller dashboard, never a wrong one.

---

## 3. The indicators

Every figure below comes from a column that exists today. No migration in this block adds a column to feed a chart.

**Every "top" list is the top ten**, ordered by count descending with the record's own name as the tie-break, so the same data never produces two different orderings.

### 3.1 Audience — `members.view`

| indicator | source | comparison |
|---|---|---|
| Listeners at this Station | `member_company_links` as of the end of the window, excluding members that are deleted or anonymized | yes (as of each window's end) |
| New in the period | `member_company_links.linked_at` in the window (D9) | yes |
| Took part in the period | distinct members with a participation in the window (D10), excluding deleted and anonymised (D12b) — **needs `participations.view`, withheld without it** (D13) | yes |
| Listeners barred in the period | distinct members, excluding deleted and anonymised (D12b), with a block starting in the window and **still in force on `is_member_blocked`'s own definition** — `lifted_at is null` **and** (`ends_at is null` or still ahead) — split by `kind` (`draw_ban`, `suspension`, every value of the enum whether used or not) | yes |
| Monthly arrivals | `linked_at` grouped by month, over the last twelve months ending at the window's end | — |
| How they were found | `members.discovery_source`, top ten with a "not stated" bucket | — |
| First contact | `members.first_contact_origin`, top ten with a "not stated" bucket | — |

**Two rules the bar figure needs, because `member_blocks` is not per-Station the way the other tables are.** `company_id` is nullable there, and `0032` states what null means: *the whole Organization — every Station this Member can reach, not one.*

- The card counts **distinct members**, not block rows. An Organization-wide block therefore counts in every single-Station panel the member can be reached from, and **once** in a consolidated panel covering several of them. The consolidated figure is consequently not always the sum of its parts, and the screen says so where it is shown.
- The split by `kind` also counts distinct members, so **a member barred both ways appears in both buckets** and the buckets can add up above the card. This is stated rather than hidden by making the card a sum, because "how many people are barred" and "how many bars of each kind" are different questions and only the first belongs on a card.

**Amended 2026-08-05, after the whole-branch review (Minor C9).** The first draft of the row above said "still in force (`lifted_at is null`)", and that is not what in force means. `member_blocks` carries a nullable `ends_at`, and `is_member_blocked` (`0032`, superseded by `0036`) derives in force at read time from all three columns — `lifted_at is null and starts_at <= now() and (ends_at is null or ends_at > now())`. `0032`'s own comment is explicit that **a dated suspension ends because the date passed**: nobody lifts it, so `lifted_at` stays null for ever. Reading `lifted_at` alone reported a listener as barred on this panel while every screen that asks `is_member_blocked` said they were free — the same disagreement between two readings of one table that D12b exists to refuse. `starts_at <= now()` is deliberately **not** restated in the aggregate: this card asks "barred *in the period*", and the window filter is what places the block in the period; a second, `now()`-relative start test would make a forward-dated block inside a forward-dated custom range vanish for a reason the card's label never mentions.

**Also amended:** the split by `kind` lists **every value of `member_block_kind`**, whether or not it occurred, matching the four other enum breakdowns in this block (Important B1). A `group by kind` dropped `suspension` entirely in any period nobody was suspended, and a reader cannot tell "nobody was suspended" from "this chart does not cover suspensions".

### 3.2 Music — `music.view`

| indicator | source | comparison |
|---|---|---|
| Songs in the catalogue | `songs` as of the end of the window | yes |
| Songs added in the period | `songs.created_at` in the window | yes |
| Requests in the period | `music_requests.requested_at` in the window | yes |
| Monthly requests | grouped by month over the last twelve months | — |
| Most requested songs | top ten by request count in the window | — |
| Most requested genres | top ten by request count in the window, joined through `songs.genre_id` | — |
| Domestic × international | requests in the window by `songs.nationality`, plus "not stated" (D8) | — |
| Vocal | requests in the window by `songs.vocal`, all five values plus "not stated" (D8) | — |

"Total" and "new in the period" are shown for **both** the catalogue and the requests, separately labelled: §4.2 does not say which it meant, and the two answer different questions.

### 3.3 Promotions — `promotions.view`

| indicator | source | comparison |
|---|---|---|
| On air now | promotions whose window contains `now()` at the Station's timezone, not cancelled (D11) | — |
| Ended in the period | `ends_at` in the window, not cancelled | yes |
| Participations | `participations.participated_at` in the window — **needs `participations.view`** (D13) | yes |
| Distinct listeners taking part | distinct `member_id` over the same rows — **needs `participations.view`** | yes |
| Prizes awarded | `winners` created in the window, excluding cancelled draws (D12) | yes |
| Overdue and uncollected | `AWAITING_PICKUP` with `deadline_at < now()`, excluding cancelled draws | — |
| Monthly participations | grouped by month over the last twelve months — **needs `participations.view`** | — |
| Why entries were refused | participations in the window by status: `VALID`, `DUPLICATE`, `TOO_SOON`, `OVER_LIMIT` — **needs `participations.view`** | — |
| The prize cycle | winners in the window by status: `AWAITING_PICKUP`, `DELIVERED`, `RETURNED`, `WRITTEN_OFF` | — |
| Busiest promotions | top ten by participation count in the window — **needs `participations.view`** | — |

The refusal breakdown is the number that shows a promotion whose per-person rule is turning real people away; it is why D1's alternative — a pickup-only panel — was rejected.

---

## 4. The three functions

```
public.get_audience_dashboard(p_company_ids uuid[], p_preset text, p_from date, p_to date) returns jsonb
public.get_music_dashboard    (p_company_ids uuid[], p_preset text, p_from date, p_to date) returns jsonb
public.get_promotions_dashboard(p_company_ids uuid[], p_preset text, p_from date, p_to date) returns jsonb
```

All three are `stable`, `security invoker`, `set search_path = pg_catalog, public`, `grant execute ... to authenticated`, and carry a `comment on function` stating what they count and what they exclude — the convention every RPC in this repository follows.

**Arguments.** `p_preset` is one of `current_month`, `previous_month`, `current_year`, or `custom`. With `custom`, `p_from` and `p_to` are required and `p_to` is exclusive; with any other preset they are ignored and the bounds are derived per Station (D5). An empty or null `p_company_ids` is an error, not "all Stations".

**First lines, in order:**

1. `p_company_ids` is deduplicated and must be non-empty.
2. `has_permission('<domain>.view', id)` for **every** id, or `42501`.
3. If more than one id, `has_permission('reports.consolidated', id)` for every id, or `42501` (D3).

**Return.** One `jsonb` per call, carrying both windows:

```jsonc
{
  "period": {
    "preset": "current_month",
    "from": "2026-08-01", "to": "2026-09-01",              // local dates, exclusive end
    "previous_from": "2026-07-01", "previous_to": "2026-08-01"
  },
  "stations": [ { "id": "…", "name": "…", "timezone": "America/Sao_Paulo",
                  "from": "2026-08-01", "to": "2026-09-01" } ],
  "cards":   { "<name>": { "current": 0, "previous": 0 } },
  "monthly": [ { "month": "2026-08", "count": 0 } ],
  "breakdowns": { "<name>": [ { "key": "…", "label": "…", "count": 0 } ] },
  "top":        { "<name>": [ { "id": "…", "label": "…", "count": 0 } ] },
  "withheld":   [ { "figure": "took_part", "needs": "participations.view" } ]
}
```

A card with no meaningful comparison (on air now, overdue) omits `previous` rather than reporting a zero that would read as a drop to nothing.

`stations` returns, for each Station in the selection, its **timezone and its own resolved `from`/`to`** (D5 as amended). The timezone is what lets the screen say a consolidated period spans more than one clock; the dates are what let it notice that a **preset** resolved two different calendar months and name the Stations that disagree. The top-level `period` keeps reporting the overall bounds and is not a claim about any single Station: *"the dates are the same everywhere, the instants are not"* is true of a custom range and false of a preset, and the screen must fire on the condition rather than assert it.

---

## 5. The screens

A new **Dashboards** section at the top of the sidebar (`src/lib/auth/shell.ts`), above Inventory, with three items: Audience, Music, Promotions. It follows the navigation rule every section already follows: **the link is visible to everyone and the page is what redirects** — "hiding a link is a courtesy; the boundary is in the database".

The section needs one new glyph in `ICONS`. The eleven that exist are objects or people; none of them means *a measure*.

Each page is a Server Component with `dynamic = 'force-dynamic'`, resolving its Station through `listCompanyAccess(supabase, '<domain>.view')` — the same helper `/inventory`, `/members` and `/music/*` use — and redirecting a caller who holds the permission in no Station at all.

Above the cards sit two controls: the Station selector and the period control — `current month`, `previous month`, `current year`, and a free range. Both live in the URL as search params, so a period is a link somebody can send to a colleague.

The consolidated option appears when the caller holds `reports.consolidated` **in at least two of the Stations they can reach with the panel's own permission** — below that the control would be dead, since D3 refuses a selection containing any Station the caller lacks the code in. That is a courtesy, not the boundary: the function re-checks every id in the array regardless of what the selector offered.

**Layering** (§3.2): `src/schemas/dashboards.ts` validates the payload coming back from the database with Zod — a `jsonb` return is `unknown` until something checks it, and no `any` enters the page; `src/services/dashboards.ts` is `server-only` and validates permission before calling; the four chart components live in `src/components/charts/` and are the only client components this block adds.

---

## 6. Migrations

| # | what |
|---|---|
| `0115` | `reports.consolidated` in `public.permissions` |
| `0116` | three indexes (below) |
| `0117` | `resolve_dashboard_period` — the preset and comparison arithmetic of D5/D6, in one place |
| `0118` | `get_audience_dashboard` |
| `0119` | `get_music_dashboard` |
| `0120` | `get_promotions_dashboard` |

`0117` exists because all three functions need the same window arithmetic per Station, and three copies of "what the previous month is" is three chances to disagree. It is the only unit in this block whose correctness is pure arithmetic, so it is also the only one that can be tested exhaustively without fixtures.

**The indexes are a measured gap, not a precaution.** Three of the four source tables have no index that supports "this Station, this date range":

- `participations` — its only listing index is `(promotion_id, participated_at desc, id desc)`. A Station-wide count over a period has no promotion to start from.
- `member_company_links` — has `(company_id)` alone; `linked_at` is not in it, and D9 makes `linked_at` the column every arrival figure filters on.
- `winners` — has `(draw_id, awarded_rank)` and a partial `(deadline_at)`; nothing keyed by Station and date.

`music_requests` already has `(company_id, requested_at) where deleted_at is null` from `0098` and needs nothing.

---

## 7. Verification

**pgTAP** — for each function: the permission gate raises `42501` rather than returning zeros; a consolidated call without `reports.consolidated` in one of the Stations is refused; the counts match a seeded fixture; **the timezone boundary holds** — a row written at 23:30 local on the last day of a month is counted in that month and not the next, for a Station whose timezone is not UTC; the comparison window is the correct preceding window; a cancelled draw's winner is counted nowhere (D12); the promotion-situation classification matches `situationOf()` at the start instant, the end instant and the instant after (D11); an Organization-wide `member_blocks` row counts once in a consolidated call and once in each single-Station call it applies to (§3.1); each breakdown's buckets sum to the total shown beside them, including the "not stated" bucket (D8).

**Isolation suite** (`npm run test:isolation`, real JWTs, never `service_role`) — a user of Station A gets no figure of Station B, including through a consolidated call naming B; a user holding `music.view` but not `members.view` is refused by `get_audience_dashboard` and served by `get_music_dashboard`; an archived promotion's participations do not reach a non-owner's totals; **a caller holding `members.view` without `participations.view` receives the Audience panel with the "took part" figure named in `withheld` and absent from `cards` — not present and zero** (D13), and the same caller's Promotions panel keeps its prize cycle and withholds its entry side.

**Vitest** — the Zod payload schemas reject a malformed `jsonb`; the situation boundary test that pairs with the pgTAP one (D11).

**Playwright** — one dashboard renders from seeded data with its charts present, and the period control changes the numbers.

**The gate is the usual one:** `lint`, `typecheck`, `test`, `db:test`, `test:isolation`, `build`, `test:e2e`.

---

## 8. Out of scope, and what the next block inherits

**Not in 8a, and deliberately:** Excel, CSV and PDF export; asynchronous generation of large reports; the `saved_reports` table; scheduled or emailed reports. All of that is **Block 8b**, which inherits from this block the three aggregate functions, the period contract of D5/D6 and the permission rule of D2/D3 — a report is the same query with a file at the end, and 8b should reuse these functions rather than write a fourth way to count the same rows.

**A trap 8b and the deploy both inherit,** and the runbook must open with it, because Block 7a paid for it once already: `has_permission` requires the permission code to exist in `public.permissions`. A frontend deployed ahead of `supabase db push` will offer the consolidated option and fail every call behind it with an error that does not look like a deploy problem.

**Also inherited:** `reports.consolidated` ships assignable and immediately meaningful. Unlike `music.request` in 7a — which shipped at zero capability and acquired a real one later — **the day this ships, any role granted the code can read the whole group's numbers in one screen.**
