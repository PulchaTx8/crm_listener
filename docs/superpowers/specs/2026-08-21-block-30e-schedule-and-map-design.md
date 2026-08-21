# Block 30e — the week you can see, the band that bounds a draw, and where the entries come from

**Date:** 2026-08-21
**Base:** `main` at `dd8135c` — Block 30d (PR #93) merged, migrations `0260`–`0268`
applied to the hosted database.
**Depends on:** Block 18 (`shows`, `show_schedules`, `save_show`, `shows_on_air`),
Block 28 (`PlaceMap`, `GeographyPanel`, the two aggregates of `0215`) and Block 30c,
which added `promotions.show_id` and nothing that reads it.
**Blocks:** nothing. This is the last of the 30 series and closes the owner's list.
**Parent request:** the owner's 19-item list of 2026-08-19, items **12, 18, 19**.

---

## 1. What this delivers

1. The Programmes screen gains a second view: the **week, drawn** — seven dated
   columns, hours down the side, one block per band at exactly its hours. The
   same screen, the same filters, no pagination in either view.
2. When a promotion belongs to a Programme, the Participations screen stops
   asking for two instants and asks for **a day and a band**, and shows only the
   entries made inside that band. The draw run from that list inherits the same
   window.
3. The Promotions dashboard gains the map the Audience and Music dashboards
   have, counting the entries of the period where the listeners who made them
   are.

## 2. What this deliberately does not deliver

- **Editing a schedule by dragging.** The owner's reference is Google Calendar's
  week view, and this block copies its READING: no drag, no resize, no
  create-by-click, no dropping one programme onto another's hour. A schedule is
  written where it has been written since Block 18 — the record dialog's
  `ScheduleEditor`, which speaks bands because that is how a station describes
  its week.
- **A day view or a month view.** One view was asked for; two more would be two
  more things to keep in step with a schedule that is stored by weekday.
- **A Programmes permission of its own.** `shows` and `show_schedules` are gated
  on `music.view` (`0099`, `0175`), which is a mismatch this project has recorded
  twice and rejected fixing twice — `docs/PERMISSIONS.md`'s "Programmes are gated
  on music" section carries the reasoning, and it has not changed: a new
  permission is a migration, the roles screen, every seeded role, and above all
  every role a customer has already configured, none of which would grant it.
  This block opens ONE door around that gate, for the one read item 18 needs
  (D7), and leaves the screen where it is.
- **Refusing an entry made outside its Programme's hours.** Item 18 says
  "eligible", and on this screen eligibility is what the list and the draw hat
  contain (D10). `record_participation` keeps taking entries whenever the
  promotion is open; a station that wants the hours enforced at the door is
  asking for a different feature, and nobody has asked for it.
- **A second map style.** The promotions map is `PlaceMap` with different
  numbers, deliberately: a second map component is a second set of bugs about
  bounds, injected scripts and CSP, and Block 28's header explains why that
  component is built the way it is.

---

## 3. The three items, mapped

| Item | Where | What changes |
| --- | --- | --- |
| 12 | `/shows` | a **List / Week** toggle; the week grid; paging removed from both views |
| 18 | `/participations` | when the promotion has a Programme: a day, a band, and the window they name |
| 18 | the draw run from that list | the hat inherits that window, being built from the same filter state |
| 19 | `/dashboards/promotions` | a geography panel: ranked places, the coverage line, and the map |

---

## 4. Decisions

### D1 — The Programmes screen stops paging, in both views

The owner's ruling: the screen shows every registered programme. The list drops
its keyset cursor and its Previous/Next links; the week grid never had them.

A grid cannot page: a week is a week, and showing 25 of a Station's programmes
over it would draw a schedule with holes in it and no way to see that they are
holes. Paging the LIST while the grid shows everything would leave the two views
disagreeing about how many programmes exist, which is worse than either.

**There is still a ceiling, and it is not silent.** The read takes at most
`SHOW_LIST_MAX = 500` rows; if a Station ever holds more, the screen renders the
500 and says so in a line above the list. A cap nobody is told about is how a
screen comes to claim a completeness it does not have — the failure this project
has called "no silent caps" since the reporting blocks. 500 is chosen as a number
no radio station's programme list approaches (the seeded Stations carry four); it
exists so a runaway import cannot turn this screen into a full-table render.

What this removes: `parseShowCursor`, the `after`/`before` parameters,
`showHref`'s cursor argument, the `keysetFilter`/`keysetPage` apparatus in
`services/shows.ts`, and the two paging links in `ShowsGrid`. The total count
stays — it is what told the operator how many rows there are, and without paging
it is the only thing left that does.

### D2 — The grid is a **dated** week, drawn in the Station's timezone

Seven columns carrying real dates, `?week=YYYY-MM-DD` naming the Monday, arrows
for the week before and after, and a "This week" control. Today is marked, and a
line marks the current time.

**The week, today and now are all resolved in `companies.timezone`, never in the
browser's zone and never in the server's.** This is the trap `shows_on_air`
(0175) documents on itself: computed against a bare `now()` a schedule passes
every suite run in the afternoon and is wrong at 21:00. The page already reads
the selected Station's zone — `page.tsx` hands `selected.timezone` to the
participations filters today — and the grid uses the same value through the same
module, `src/app/(app)/promotions/zone.ts`.

The board is a client component, because a block has to open the SAME record
dialog the list opens and that dialog is driven by `useRecordDialog`. Nothing is
derived there: the geometry is computed on the server by a pure module, and the
board draws it. The now-line is the one moving part, and it ticks forward from
the minute the SERVER read in the Station's zone rather than from the browser's
own clock. It renders nothing when the week on screen is not the week containing
that Station's today — a red line across a week in March means nothing.

### D3 — One band, one block; the overnight tail is a second block

The owner's words: a programme with two bands in a day appears twice that day, at
exactly its hours. That is what the schema already holds. `save_show` expands a
band into one row per weekday, and splits any band crossing midnight into a head
that ends at 24:00 and a tail that starts at 00:00 on the next weekday, both
carrying the same `band` marker.

So the grid draws **one block per `show_schedules` row**, which gives the owner's
rule for free and the overnight case correctly: `23:00–02:00` on a Friday is a
block from 23:00 to the foot of Friday and a second from the head of Saturday to
02:00.

**Both blocks carry the band's whole time — `23:00–02:00` — not the segment's.**
The `24:00` end is this schema's own bookkeeping, and `src/lib/shows/bands.ts`
says in its header that it must never reach a screen. A block labelled
`00:00–02:00` on Saturday would read as a different programme from the one that
started the night before, which is the confusion `toBands` exists to undo. The
reconstruction is `toBands`' — already written, already pure, already tested —
reused rather than re-derived: the geometry module positions each row and takes
that row's band label from `toBands`' output.

### D4 — A past week shows what aired; the grid's own bounds replace the "ended" filter

A programme is drawn on a date only if that date is inside its run
(`starts_on <= date`, and `ends_on is null or ends_on >= date`) and its schedule
carries that weekday. That one rule answers everything the "ended" filter was
answering for the list:

- A programme that has not started does not clutter this week.
- A programme that ended last month is **absent from this week and present in
  the weeks it aired** — the owner's ruling. A past week drawn with holes where a
  programme ran would be a false picture of that week.

So **the "show ended programmes" filter does not narrow the grid.** It keeps
narrowing the list, where "ended" is a fact about a row rather than about a date.
The grid says so in one line, so an operator who ticked the box on the list and
switched views is not left wondering why nothing changed.

Archived programmes (`shows.deleted_at`) are absent from both views, unchanged.

### D5 — Colour is the programme's kind, and the legend is part of the panel

The reference image colours by category; the nearest thing this schema has is
`shows.kind` (`show_kind`). Each kind takes one colour from a fixed map, and a
legend under the grid names them — a colour with no legend is decoration.

Programmes with no kind — the four that predate Block 18, which
`listShows`' own comment already singles out — render neutral, and the
legend names that state too. Colours are assigned by enum value rather than by
position in the result, so two loads of the same week paint the same picture, and
they are declared as token pairs that survive dark mode (Block 25).

### D6 — The toggle is a URL parameter, and this is not Block 20b's mistake

`?view=schedule` on `/shows`, absent meaning the list. Every filter link — the
Station pills and the record link included — carries it through `showHref`, so
switching views keeps the filters and switching filters keeps the view, which is
item 12's own requirement ("keep the same filters for both views").

Block 20b's error was pointing three menu items at `/music/catalog?tab=…` when
the item asked for those tabs to STOP EXISTING; the parameter kept them alive
under another name. The shape is superficially the same and the situation is the
opposite: here the owner asks for two views of one screen under one set of
filters, and a second route would need this screen's whole filter contract
duplicated inside it. The distinction is written down because the shape alone
will look like the old mistake to the next reader.

An unrecognised `?view=` renders the list, the way `parseShowListState` already
treats an unrecognised `kind` as no filter at all: a URL is hostile input, and a
typo must not be an error page.

### D7 — Item 18's window comes from a door of its own, gated on `participations.view`

The Participations screen needs one thing it cannot read: the schedule of the
Programme its selected promotion belongs to. `shows_select_music_view` and
`show_schedules_select_music_view` gate both tables on `music.view`, which an
operator who administers Promotions need not hold — Block 30c found the identical
mismatch on the Programme combobox of a promotion's own record, where it reads as
an empty list rather than as a broken link.

Left alone, the band combo would be permanently empty for exactly those
operators, and an empty combo does not say "you may not see this": it says "this
Programme never airs". A filter that silently answers nothing is worse than one
that refuses.

So `0269` adds `promotion_show_schedule(p_promotion_id uuid)`: SECURITY DEFINER,
re-checking `has_permission('participations.view', <the promotion's company>)`
against `auth.uid()` before returning anything, and returning the raw schedule
rows of that promotion's Programme — `band, weekday, starts_at, ends_at` — plus
the Programme's id and name. No `show_id`, no rows.

**It returns rows, not a window.** Reconstructing bands and converting a
wall-clock to an instant are both already written and already tested — `toBands`
(`src/lib/shows/bands.ts`) and `fromZonedWallClock`
(`src/app/(app)/promotions/zone.ts`) — and a second implementation of either in
SQL would be a second thing to keep in step with the screen that draws the grid
from the first. This door's only job is to get past a gate that is about the
Music section rather than about this read.

It reads a promotion whose Programme has since been archived, deliberately:
`0258`'s own comment on `promotions.show_id` says the link survives archiving
"so that a promotion which ran inside a Programme still says so and Block 30e can
still read that Programme's schedule".

### D8 — The day and the band live in the URL; the instants are derived

Today the filter writes `from`/`to` as instants. With a Programme it writes
`day=YYYY-MM-DD` and `band=<marker>`, and the server derives the two instants
from the Programme's schedule. A pasted link therefore still means the same thing
tomorrow, which an instant pair would not: "Saturday's morning show" is what the
operator chose, not "10:00 on the 21st".

The window is **half-open** — from the band's start, up to but not including its
end — the rule `shows_on_air` states so that two consecutive bands never both
claim the same minute. `list_participations` (0090) compares
`participated_at <= p_to`, so the screen passes the band's end minus one
millisecond rather than changing the predicate of a function the list and the
draw hat both read through (`collectDrawHat` calls the same RPC); this is the
same move `fromZonedDay(day, tz, true)` already makes with `23:59:59.999`.

An overnight band's window ends on the following day, which is what the operator
reads beside the combo.

`from`/`to` are still what reaches the service, and that is what makes D10 true.
When the promotion has no Programme none of this applies and both date inputs
behave exactly as they do today.

### D9 — A day the Programme does not air shows nothing, and says so

With the owner's ruling that the operator picks one band, the combo lists the
bands that START on the chosen day. If there are none — a Monday-to-Friday
programme and a Sunday — the combo is empty, the list is empty, and a line above
it says the Programme does not air on that date.

The alternative considered and rejected was falling back to the whole day: it
would quietly widen a filter whose entire promise is the band, and — because of
D10 — it would put people who never heard the programme into the draw.

When the day carries exactly one band it comes selected; the combo still renders,
so the operator can see which window they are in.

### D10 — The window bounds the draw hat too, and that is the item's word "eligible"

`prepareDrawHatAction(state)` builds the hat from the same
`ParticipationListState` the list was rendered from, passing `from` and `to`
through to `collectDrawHat`. So a Programme window narrows the draw by
construction, and the item's "eligible participations are only those created
inside that Programme's time range" needs no separate mechanism.

**This changes who is in a draw**, and it is written down here because it is the
part of item 18 that is not visible on the screen it changes. The draw dialog
already describes its population as everyone matching these filters; the
Programme window is one of those filters, and the dialog states the count before
anything is drawn.

### D11 — The promotions map counts what the card beside it counts

Circles are **participations in the period**, and the population is exactly the
one `get_promotions_dashboard`'s `participations` card counts: every entry in the
window, of every status, not only the valid ones.

That is Block 8a's D12b — every figure on a panel counts the same people — and it
is what lets the coverage line say "412 of 1,208". Counting only `VALID` here
would put a number under the map that no card on the panel agrees with, while the
coverage line compared two different populations and looked like one.

The hover bubble carries two lines: how many entries came from that place, and
the promotion most played there with its own count — the shape of the Music
panel's "most requested here", which is the precedent for a per-place fact beside
a count.

The place of an entry is the place of the LISTENER who made it, resolved exactly
as `get_audience_geography` resolves it: `member_place_key` over the listener's
own country falling back to the Station's, joined to `geocoded_places` for a
coordinate and for the label. A listener has one place, so an entry is counted at
that listener's place as at read time.

### D12 — Without `participations.view` the panel is withheld, not hidden

`get_promotions_dashboard` (0120) already omits five figures for a caller lacking
`participations.view` and names them in `withheld` (Block 8a's D13); the screen
renders `WithheldFigure` in their place. The map counts that same population, so
it answers to the same permission and takes the same treatment: the panel renders
carrying the withheld notice rather than vanishing, because a panel that
disappears teaches the operator that the Station has no geography, and a zeroed
one lies outright.

`get_promotions_geography` therefore refuses on `promotions.view` (`42501`, the
panel's own gate), refuses on `reports.consolidated` when more than one Station
is named, and returns a withheld payload rather than counts when
`participations.view` is missing — the three-way shape copied from
`get_promotions_dashboard` rather than re-derived, down to the error sentences,
which the e2e suite matches on.

**`members.view` withholds too, and it has to.** The map plots the LISTENERS
behind the entries, and this function is SECURITY INVOKER: a caller who cannot
read `members` would get every place cut by their own RLS and an empty map under
a coverage line still naming a total. An empty map claims the Station has no
geography, which is a different and false claim. So the payload names whichever
of the two permissions is missing, and the panel says which.

Like Block 28's panel, and for its reason: **without
`NEXT_PUBLIC_GOOGLE_MAPS_KEY` the ranked tables render unchanged** and one muted
line says the map is not configured. That is not a degraded mode; it is the path
the whole e2e journey runs on, and it is what makes this item finishable before a
key exists.

---

## 5. Migrations

Two, both additive, neither touching a table.

### `0269_promotion_show_schedule.sql`

`public.promotion_show_schedule(p_promotion_id uuid)` returns
`table(show_id uuid, show_name text, band smallint, weekday smallint, starts_at time, ends_at time)`.

- `security definer`, `stable`, `set search_path = pg_catalog, public`.
- Resolves the promotion's `company_id` and `show_id` in one read; returns zero
  rows when the promotion does not exist, is archived, or carries no `show_id`.
- Raises `42501` when `has_permission('participations.view', company_id)` is
  false. Not a silent empty result: an empty result already means "this Programme
  does not air on that day", and the two must not look alike (D9).
- Reads `shows` even when `deleted_at is not null` (D7), and returns the
  Programme's name so the screen can say whose schedule this is.
- `revoke execute … from public; grant execute … to authenticated;`, and the
  grant restated in full — a function that loses its ACL is the Block 24 defect
  this project has now met twice.

### `0270_promotions_geography.sql`

`public.get_promotions_geography(p_company_ids uuid[], p_preset text, p_from date, p_to date)`
returns `jsonb`, mirroring `get_audience_geography` (0215):

- `security invoker`, so the caller's own RLS still cuts every row it reads — the
  property that makes the join safe, as 0215's header sets out.
- Permission loop copied from `get_promotions_dashboard`: `promotions.view` per
  Station, `reports.consolidated` for a consolidated read, and
  `participations.view` deciding withheld rather than refusing.
- `resolve_dashboard_period` for the window, per Station and in that Station's
  zone, as every dashboard aggregate since `0117` does.
- Counts `participations` in `[from_at, to_at)` — the card's own predicate —
  grouped by the listener's resolved place, with the top promotion per place
  computed in the same pass.
- Payload: `{ places: [...], with_place, total, withheld }`, where `total` is the
  participation count for the window (D11) and each place carries
  `top_promotion` / `top_promotion_count` beside the fields `0215` already
  returns.

Both payloads are read through `schema.parse` in `src/schemas/geography.ts`,
never an `as` cast, for the reason that file's header gives.

---

## 6. Testing

**pgTAP — `supabase/tests/75_promotion_show_schedule.test.sql`:** the door returns
a promotion's schedule for a caller holding `participations.view` and no
`music.view` anywhere; refuses with `42501` for a caller without it; returns zero
rows for a promotion with no Programme; still returns rows when the Programme is
archived; and cannot be reached across Stations.

**pgTAP — `supabase/tests/76_promotions_geography.test.sql`:** its `total` equals
`get_promotions_dashboard`'s `participations` card over the same window — the
assertion that fails the moment somebody "improves" one of the two counts, as
`tests/isolation/geography.test.ts` already does for the audience pair; the
withheld payload appears without `participations.view`; `42501` without
`promotions.view`; and a listener with no resolved place is in `total` but not in
`with_place`.

**Unit — `tests/unit/week-grid.test.ts`,** over the pure geometry module: a band
positioned at its own hours; two bands in one day producing two blocks; an
overnight band producing a block at the foot of one day and one at the head of
the next, both labelled with the whole band; a programme whose run starts
mid-week drawn only from that date; a programme that ended mid-week drawn only up
to it.

**Isolation:** the new door and the new aggregate refuse across tenants, added to
the suites that already carry their neighbours.

**e2e:** `shows.spec.ts` gains the toggle, the week arrows, and a block that opens
the record dialog; one journey asserts the filters survive both switches. A
participations journey selects a promotion with a Programme, sees the second date
input replaced by the band combo, picks a band, reads a narrowed list, then opens
the draw dialog and reads the same narrowed count. `dashboards-geography.spec.ts`
gains the promotions panel on the no-key path.

**Existing suites to re-run rather than assume:** `shows.spec.ts` (paging
removed), `participations-flow.spec.ts` and `filtered-draw.spec.ts` (the filter
bar changes shape), `dashboards.spec.ts` (a panel is added to a page it asserts
on).

---

## 7. What the owner has to do, and when

- **Nothing before the merge.**
- **After the merge:** `npx supabase db push --linked` for `0269` and `0270`.
  Three blocks in a row have shipped code whose migrations had not travelled with
  it (13a, 17b, 17c), and both functions here are read on the first render of a
  screen.
- **The map needs no new key.** It uses `NEXT_PUBLIC_GOOGLE_MAPS_KEY`, already
  configured for the Audience and Music maps. If it is ever rotated: the value is
  read at BUILD time by the browser bundle, so a change needs a rebuild, and the
  HTTP-referrer restriction needs its `/*` suffix — both already recorded.

## 8. Debt this records

- **Programmes remain gated on `music.view`.** This block routes one read around
  that gate (D7) and leaves the screen, the combobox and the two tables where
  they are. The mismatch now has three recorded surfaces; the fourth should be
  the one that decides it.
- **`toBands` acquires a third caller** (the record dialog, the week grid, the
  band combo). It is pure and tested, which is what makes that safe, and the unit
  suite is the guard on it.
- **The 500-programme ceiling** is a number chosen against today's data. If a
  Station ever reaches it, the line the screen renders is the notice that the
  decision needs revisiting — not a bug report.
