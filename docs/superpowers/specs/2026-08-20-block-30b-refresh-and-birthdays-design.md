# Block 30b — a button that re-asks, and a birthday that is not a birth date

**Date:** 2026-08-20
**Depends on:** nothing.
**Base:** rebased onto `main` at `adc4400` — the merge of Block 30a (PR #90),
which is deploying to production. 30a holds migrations `0253`–`0256`; this block
therefore starts at `0257` for real rather than by reservation, and at pgTAP
`70`.
**Parent request:** the owner's 19-item list of 2026-08-19, items **6 (Refresh
half), 8, 9 (Refresh half)**.

---

## 1. What this delivers

A Refresh button on Participations, Members and Requests that re-runs the query
already on screen; and a Birthday mode on the Members filter bar that answers
"whose birthday falls in this window", including a window that crosses new year.

## 2. What this deliberately does not deliver

- **The View actions and the phone masking** on those same screens. Block 30a,
  already in review.
- **A Refresh on Pickups.** The owner's list does not ask for one. Adding it
  because the neighbouring screens have one would be inventing scope.
- **Anything that sends a birthday greeting.** This is a filter. Turning its
  result into a campaign is Block 29's machinery and the operator's decision.

---

## 3. The three items

| Item | Screen | What changes |
| --- | --- | --- |
| 6 (Refresh half) | Participations | a Refresh button in the filter bar |
| 8 | Members | a Birthday mode for the two date boxes, plus a Refresh button |
| 9 (Refresh half) | Requests | a Refresh button in the filter bar |

---

## 4. Decisions

### D1 — Refresh re-asks the same question, and changes nothing about it

`router.refresh()`, from a shared component in `src/components/ui/`. It re-runs
the current request: same filters, same sort, same cursor, same page. The URL is
not touched.

**Preserving the cursor is the decision, not an omission.** "Rerun and refresh
the current query" is what the owner asked for, and an operator who has paged
three screens into a list and presses Refresh to see whether a colleague has
attended something is asking about *this* page. A Refresh that silently returned
them to page one would lose their place to answer a question they did not ask.

**Why `router.refresh()` and not a re-navigation to the same URL.** Next treats
navigating to the identical URL as a no-op; `router.refresh()` is the API that
re-fetches the Server Components for the current route and re-renders them with
the client state intact. It is also what makes the grids correct here: each one
holds rows patched locally by its own actions (`applyRowPatch`), and each already
resets from `initialRows` in an effect when a navigation hands down a new page.
`router.refresh()` drives that same effect, so nothing new has to be taught about
when local state yields to server state.

**Pending state is required, not decoration.** A refresh that looks like nothing
happened gets pressed repeatedly. The button reports its own transition.

### D2 — A birthday is a day of the year, not a date

The owner's screen says *Birthdays from* / *Birthdays to*. That means **whose
birthday falls in this window**, ignoring the year — the question somebody asks
before a birthday greeting or a birthday promotion.

**It is not "born between two dates", and that matters because the screen already
answers that.** `MemberListState.ageMin` / `ageMax` convert an age band into a
`birth_date` range and lean on `members_birth_date_idx` (0036), with a comment in
`services/members.ts:521-527` explaining why the range and not a per-row age.
Reading item 8 literally would ship a second control answering the question the
first one already answers, in different units.

**The window crosses new year.** 20 December to 5 January is a real end-of-year
window and a filter that refused it would be wrong for the season it exists to
serve. So the predicate is:

```
from <= to :  md between from and to
from >  to :  md >= from  or  md <= to
```

### D3 — The comparison needs a column, because the list is not an RPC

`listMembersPage` is PostgREST (`asCaller(...).from('members').select(...)`), so
the filter has to name a column. An expression predicate is not expressible
there, and moving the whole listing to an RPC to gain one would be a far larger
change than the feature.

So: a generated stored column.

```sql
alter table public.members
  add column birth_md smallint
  generated always as (
    (extract(month from birth_date) * 100 + extract(day from birth_date))::smallint
  ) stored;
```

**This is the pattern the table already uses, for the same reason.**
`phone_normalized` and `email_normalized` are generated columns so that a
normalisation cannot drift from the thing that filters on it (`0031`'s own
comment: *"a normalisation applied by whoever remembers is a normalisation that
drifts"*). A month-and-day derived in three places would drift the same way.

Probed against the local database before this spec was written:

| `birth_date` | `birth_md` |
| --- | --- |
| 1990-12-31 | 1231 |
| 1988-01-05 | 105 |
| 2000-02-29 | 229 |
| null | null |

and `where md >= 1220 or md <= 105` returned exactly the December and January
rows. **29 February needs no special case**: it is 229, and any window spanning
28 February to 1 March contains it.

An index to go with it, partial on the rows the screen can reach:

```sql
create index members_birth_md_idx on public.members (birth_md)
  where birth_md is not null and deleted_at is null;
```

**`smallint` is deliberate and sufficient**: the largest value is 1231.

### D4 — The two modes get their own URL parameters

`?from=` / `?to=` stay what they are — instants, the registration window. Birthday
gets `?bfrom=` / `?bto=`, carrying `MM-DD`.

**Not one pair of parameters reinterpreted by a mode flag.** A filtered list is a
link somebody sends to a colleague — `src/app/(app)/members/list-params.ts:13`
says exactly that, and it is why every filter on this screen already lives in the
URL. If the mode flag were lost or edited out of such a link, one pair of dates
would silently change meaning, and a saved link would answer a different question
than the one it was saved for. Separate parameters cannot be misread: a link
either carries a registration window or a birthday window.

`MM-DD` rather than a full date, because a year here would be a value the screen
invents and nothing reads — and a reader of the URL should not have to know that.

Both new parameters count toward `hasActiveFilters`.

### D5 — The mode selector switches the labels, and only one window applies

One `<select>` above the two date boxes: **Registered** (default) or
**Birthday**. It rewrites the two labels, and it decides which pair of parameters
the boxes write. Switching modes clears the other pair, so the two windows can
never both be live — the screen would otherwise show a filtered count nobody can
account for from what is on screen.

The age band, the gender filter and everything else are untouched and continue to
AND with whichever window is active. An age band and a birthday window together
are a coherent question ("who in their thirties has a birthday next week"), and
nothing needs to prevent it.

---

## 5. Migrations

One.

| # | File | What |
| --- | --- | --- |
| 0257 | `members_birth_md.sql` | the generated column, its partial index, and a `comment on column` saying why it exists |

**On the number.** This branch was cut before 30a merged, when the tree stopped
at `0252`, and the spec reserved `0257` rather than taking the `0253` an `ls`
would have suggested — numbers are **allocated**, not discovered, and
renumbering a migration during a rebase is how one gets applied twice or not at
all. 30a has since merged; `0257` is now simply the next free number, and the
reservation cost nothing. Same for pgTAP `70`.

`alter table … add column … generated always as … stored` rewrites the table.
`members` is the audience table and can be large in a real installation; the
migration is one statement and takes an ACCESS EXCLUSIVE lock for its duration.
That is acceptable here and is recorded rather than discovered: this project's
installations are single-Station or small groups, and the same rewrite already
happened for `phone_normalized` and `email_normalized` in 0031.

**No RLS change.** `birth_md` is a column of a table whose policies already
decide who may select it, and the screen never renders it.

---

## 6. Files

**New**

- `src/components/ui/refresh-button.tsx`
- `supabase/migrations/0257_members_birth_md.sql`
- `supabase/tests/70_birthday_window.test.sql`

**Changed**

- `src/app/(app)/members/list-params.ts` — `dateMode`, `birthdayFrom`, `birthdayTo`
- `src/app/(app)/members/members-filters.tsx` — the mode selector, the relabelled boxes, the Refresh button
- `src/services/members.ts` — the two branches of the window predicate
- `src/app/(app)/participations/participations-filters.tsx` — the Refresh button
- `src/app/(app)/music/requests/requests-filters.tsx` — the Refresh button
- `messages/{en,pt,es}.json`
- `src/lib/supabase/database.types.ts` — regenerated

---

## 7. Testing

- **Unit** — the pure conversion from `MM-DD` to the `smallint`, and the
  wrap/no-wrap branch selection. Both are functions with no database in them and
  they are where the off-by-one lives.
- **pgTAP** — the generated column against the four rows probed above, including
  29 February and a null `birth_date`; and that the partial index exists.
- **Isolation** — a birthday window that wraps new year returns exactly the
  listeners either side of it and no others, and a window that does not wrap
  excludes the ones outside. This is the assertion that fails if somebody
  "simplifies" the two branches into one `between`.
- **Playwright** — one journey: set Birthday mode, enter a window crossing new
  year, see the expected listener; press Refresh and see the same page, same
  filters, same position.

**Gate order** is `db:reset` → `db:test` → `test:isolation`, then `test:e2e`.
`db:reset` wipes the storage bucket, so `npm run seed:branding` before any e2e
run or `login.spec.ts` fails on a 400 that is not code.

---

## 8. Debt this records

- **`birth_md` is derived from `birth_date` and inherits its blind spot.** A
  listener with no birth date on file is invisible to this filter, exactly as
  they are to the age band. That is correct and worth stating, because "the
  birthday list is short" has a second possible cause: nobody asked.
- **The Refresh button does not tell the operator whether anything changed.** It
  re-runs and re-renders; if the page is identical, the only feedback is the
  pending state ending. A "3 new since you last looked" affordance is a different
  feature and is not smuggled in here.
