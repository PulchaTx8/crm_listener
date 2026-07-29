# Block 3b — Listing at scale — Verification Report

Branch `block-3b`, twenty commits ahead of `main`: a keyset helper and a table
primitive, one new `SECURITY DEFINER` predicate, four screens rewritten, one
screen given two corrections it had been missing since Block 1b, and a proof
that paging loses nobody.

**What the block set out to do, and did:** the audience, inventory and admin
screens page by keyset with server-side filters and sorting, and the audience
list's per-row block-state N+1 is gone. One unsearched fifty-row `/members` page
went from **102 round trips to 5**, measured (§3).

**Migrations `0036`–`0039`, strictly additive.** One function
(`members_blocked_bulk`), one function body superseded in place
(`is_member_blocked`, unchanged in behaviour), five indexes. No table changed
shape, no policy was widened, nothing was dropped.

---

## 1. Verification

Every gate below was run at its real defaults on the final tree.

| Gate | Command | Result |
| --- | --- | --- |
| Lint | `npm run lint` | ✔ no ESLint warnings or errors |
| Types | `npm run typecheck` | clean |
| Unit | `npm test` | **188 passed**, 16 files |
| Database | `npx supabase db reset && npx supabase test db` | **244 passed**, 3 files, `Result: PASS` |
| Isolation | `npm run test:isolation` | **95 passed**, 10 files, under real JWTs |
| Build | `npm run build` | compiled successfully |
| End to end | `CI=1 npx playwright test --workers=2` | **9 passed** |

Unit tests went from 181 to 188: seven new cases for `keysetPage` (§2.3).
Isolation went from 90 to 95: the five in `tests/isolation/listing.test.ts`.
pgTAP went from 220 to 244 across Block 3's own additions and this block's grant
grid for the bulk predicate.

### 1.1 The e2e gate closes for the first time — and what it took

Block 3's report left this gate open: `npm run test:e2e` had never gone green
locally, failures varied between runs, and they were timeouts rather than false
assertions. That is still true of the **local dev-server** configuration, and it
is now understood rather than merely observed.

**Against a production build at two workers — CI's own shape — all nine journeys
pass.** Under `npm run test:e2e` (the dev server, six workers) three journeys
fail, and every failure is the same shape: a navigation that has not completed
within Playwright's 5-second `toHaveURL` budget — `/app` where `/inventory` was
expected, `/invite/…` where `/login` was expected. Nothing asserts wrong content.
`next dev` compiles each route on its first request, and six workers racing for
one dev server is enough to push that past five seconds.

**A second, separate cause was found while diagnosing this, and it is worth
knowing before anyone runs the suite locally.** `acceptInvitation`
(`services/invitations.ts`) rate-limits acceptances at **10 per hour per IP**.
Every journey that invites a delegate spends one. Four full runs inside an hour
therefore exhausts the budget, and from then on every invite-accepting journey
fails with `?error=failed` — which reads exactly like a regression in the code
under test and is not one. It is visible in `rate_limit_counters` as a
`invite-accept:…` key with `count` above 10 and a future `reset_at`. `npx
supabase db reset` clears it.

This cost about forty minutes of a false regression hunt in this block. Recorded
here so it costs nobody that again.

---

## 2. What was built, and where it departs from the plan

The plan is `docs/superpowers/plans/2026-07-28-block-3b-listing-at-scale.md`;
the spec is `docs/superpowers/specs/2026-07-28-block-3b-listing-at-scale-design.md`.
Tasks 1–3 (the cursor helper, the table primitive, the bulk predicate) had
already shipped before this session and are unchanged. Tasks 4–9 are below, with
every departure named.

**Task 8 was executed out of order, immediately after Task 4 rather than after
Task 7.** It is the proof that the audience list pages correctly, and running it
before building three more screens on top of that list is how a keyset defect
gets caught while it is still one screen's problem.

### 2.1 Block state stays "any reachable Station", not one Station

The plan's `MemberListParams` carried a single `companyId` — "the Station the
block state is asked about" — and one `members_blocked_bulk` call per page.

This screen lists the audience **across every Station the caller can reach** and
deliberately shows no Station column (spec §2, decision 4). A badge answering for
one Station while the rows came from several would read "not blocked" for
somebody who is blocked, on the screen whose entire job is showing that. So the
semantics the badge already had are kept: **blocked at any Station this listener
is linked to that the caller can reach.**

The bulk predicate is per-Station by design — its caller guard is checked once
for the one Station a batch concerns — so the fan-out is over **Stations**, one
to three in this product's real shape, instead of over the fifty rows. The
`member_company_links` read that groups the batch is RLS-narrowed to reachable
links already, which is also what keeps the guard from refusing the whole page.

### 2.2 `previousCursor`, because Previous is a control that shipped in Task 2

`PageControls` renders Previous and Next. The plan's `MemberListPage` returned
only `nextCursor`, which cannot drive it. Walking back is the same query read in
the opposite direction with the rows turned around afterwards, so Previous costs
exactly what Next costs, and `keysetPage` (§2.3) owns that logic for all three
paged screens.

### 2.3 One extracted helper, not an engine

The plan and spec are both explicit that the answer to duplication here is "one
small specific function, not a generic data-table engine". The cursor
*bookkeeping* — over-fetch by one, slice, reverse when walking back, decide which
of the two controls exist — is twenty subtle lines that three screens need
identically, and the members service, the inventory service and the admin console
would each have had their own copy.

`keysetPage` in `src/lib/keyset.ts` is that one function: pure, no I/O, no
knowledge of any table, seven unit tests including the two cases most likely to
be got wrong (the over-fetched row must never be rendered; walking back onto the
first page must drop Previous). Nothing else was generalised: each service still
writes its own filters, its own sort columns and its own query.

`escapeLikePattern` moved from `services/members.ts` to `lib/postgrest.ts`,
beside `quoteForOrFilter`, once the inventory search needed it too — the
alternative was a service importing another service for a string helper, or a
second copy of an escaping rule.

### 2.4 The name sort orders by the raw column, and 0037 indexes it

The plan's global constraints required sorting by `lower(full_name)` to match
`members_name_idx` (0031). **That cannot be done through this stack**, and
finding out is what produced migration `0037`:

- PostgREST orders by columns, not expressions, so `order=full_name.asc` is the
  only ordering the query can ask for;
- a keyset cursor must **compare** the same expression it **orders by**, and
  PostgREST cannot express a `lower()` comparison either;
- ordering by `lower(full_name)` while comparing raw `full_name` would not merely
  miss the index — it would page wrongly wherever the two orderings disagree,
  which is any pair of names differing in case.

So `0037` adds `(organization_id, full_name, id) where deleted_at is null`,
matching the ordering exactly, including the tiebreak. No `NULLS` ordering is
specified anywhere: the query sends no `nullsfirst` either, so both fall to
Postgres' default — ASC puts nulls last, DESC puts them first — and the one index
serves a forward scan of the ascending sort and a backward scan of the descending
one. An earlier draft asked for `NULLS LAST` in both directions, which would have
left the descending sort with no usable index at all.

`0038` and `0039` do the same job for the two screens the plan gave no indexes
to: `prizes (company_id, name, id)` and `(company_id, created_at, id)`, and
`companies (created_at, id)` for the platform-wide admin console.

### 2.5 The inventory list has no archived filter, and cannot have one here

Spec §6 and the plan's Task 5 both list "archived state" as an inventory filter.
It cannot be built from the listing layer: `prizes_select_inventory_view` (0029)
is `deleted_at is null and has_permission('inventory.view', company_id)`, so an
archived prize is not *hidden by the query* — it is **unreadable through RLS
entirely, for every caller including the owner and the platform admin**.

Offering the filter means widening that policy, which is a visibility decision
rather than a listing one, and this block widens no policy. Left unbuilt and
recorded here. **If the owner wants archived prizes visible, that is a migration
and a decision, not a UI change.**

### 2.6 The 50-Station cap became a search, on both screens that hit it

`listCompanyAccess` returned the alphabetically-first fifty Stations with no
route to the fifty-first — for a platform admin, a dead end that the copy on both
screens described in as many words. It now takes an optional name search, the cap
stays as a bound on **one page**, and both screens render a plain GET form (no
client JavaScript: submitting it is a navigation, which is all it needs).

The Station search is carried by every link on both screens. Dropping it on a
sort or page click would put the Station list back to its capped first page, and
a Station reachable only *through* the search would fall out of it — silently
moving the caller to another Station's inventory.

---

## 3. The N+1 is gone: 102 → 5, measured

Not estimated. `tests/isolation/legacy-members-baseline.ts` was the pre-3b
service taken verbatim from `main` at `871e1a2`, run against the same fixture as
the new one with `globalThis.fetch` counting requests to `/rest/v1/`, then both
scaffolding files were deleted.

**Fixture:** one Organization, two Stations, fifty listeners — one full page —
each linked to both Stations, read by a non-owner delegate holding `members.view`
at both. No search, no filters.

```
ROUND TRIPS before=102 after=5
```

- **Before, 102:** one read for the rows, one for the links, then one
  `is_member_blocked` RPC per listener per reachable Station — fifty listeners ×
  two Stations = 100. Each of those re-ran the same permission subtree (a
  `permissions` lookup, `has_company_access`, and a
  `company_memberships ⋈ roles ⋈ role_permissions` join) because the function is
  `SECURITY DEFINER` and re-checks its caller every time.
- **After, 5:** the rows, the exact total, the links, and one
  `members_blocked_bulk` call per **Station** — two, not one hundred.

The plan's estimate was "roughly 107"; the measured figure on this fixture is
102. The remaining five do not grow with the page size, and the block-state cost
now grows with the number of Stations a caller can reach, not with the number of
listeners on screen.

---

## 4. Proof that the new tests bite

`tests/isolation/listing.test.ts` carries five cases. Each was shown to fail
under a mutation, and each mutation was reverted with `;` rather than `&&` — the
runner exits non-zero on exactly the failure being caused, so `run && git
checkout` silently skips the restore — with `git diff` verified clean between
mutations.

| Mutation | Case that went red | Output |
| --- | --- | --- |
| `query.order('id', …)` removed from `listOrganizationMembers` | listeners sharing one name | `expected [ …(74) ] to have a length of 55` |
| `if (nullsLast) arms.push(col.is.null)` removed from `keysetFilter` | the null-name region | `expected Set{ …(50) } to deeply equal Set{ …(101) }` |
| `if (!nullsLast) arms.push(col.not.is.null)` removed | the null-name region | `expected Set{ …(51) } to deeply equal Set{ …(101) }` |
| the active-window bound removed from the blocked-only join | blocked-only counting | `expected [ …(2) ] to deeply equal [ Array(1) ]` |
| walking back stops reversing its rows | Previous reproduces page one | `expected [ …(50) ] to deeply equal [ …(50) ]` |
| `members_blocked_bulk`'s caller guard removed (migration + `db reset`) | the bulk predicate's boundary | `expected [ { …(2) } ] to be null` |

### 4.1 One of them could not fail, and that is the finding worth keeping

The null-region case was written first with **four** named listeners and
fifty-one erased ones. It passed. It also passed with the crossing arm **deleted**
— a test that cannot fail, the second of the two defect classes the plan named on
its front page, and the fifth to ship in this project.

The reason is worth stating exactly. With four named rows, page one ends deep
inside the null region, so page two resumes from a cursor whose value **is** null
— and the arm being deleted is the one used when the cursor's value is **not**
null. The mutation removed code the test never reached.

The counts are now **fifty** named and **fifty-one** erased, and neither is
arbitrary: fifty fills page one exactly, so the ascending traversal resumes from
the last named row and needs `full_name.is.null` to see any erased listener at
all; fifty-one overfills page one the other way, so the descending traversal —
where Postgres puts nulls first — resumes from a null and needs
`full_name.not.is.null` to see any named one. Both arms are now load-bearing, and
both mutations above are red.

A related discovery: **a nameless listener cannot be registered** —
`create_member` (0034) refuses one with `22023` — so the null-name region exists
for exactly one reason, erasure nulling `full_name`. The test seeds it the way
production produces it.

---

## 5. Things the screens now do that nobody should have to discover

### 5.1 The city column shows data the geography block will discard

Spec §13.1, stated plainly as it requires. The audience table has a **City**
column, and it renders `members.city` — **free text**, typed by whoever
registered the listener. `Campinas`, `campinas`, `Campinas/SP` and `Campinas - SP`
are four different values there today.

The geography block replaces that column with a link to a real place, or with
nothing. Until it lands, **the City column is for reading, not for counting**, and
**nothing on the screen says so**. It is deliberately not a filter and not
counted — that is the whole of §7's reasoning — but a person looking at the column
cannot tell. If that is not acceptable in the meantime, the cheap fix is a line of
copy under the table; it was not added here because the spec chose to record the
risk rather than annotate the screen.

### 5.2 The rules-consent filter is applied after the page is read

`member_consents` is append-only: a withdrawal is a new row, so "has rules
consent" means **the latest rules row is a grant**, not "a granted row exists". A
listener who consented and then withdrew has both rows, and no condition
PostgREST can put in the paginated query answers the first question.

So that one filter is applied to the page after it is fetched. Two consequences,
both on screen and both stated in the copy the screen renders:

- **a page can show fewer than 50 listeners** — the ones dropped are dropped after
  the page boundary was already chosen;
- **no total is shown while it is on.** Every other filter is a query condition, so
  the total stays exact; this one is not, and a count of what the query returned
  would not describe what is on the screen. Spec §2's rule is that a wrong number
  presented as a right one is worse than a slower query, so the screen shows no
  number and says why.

Traversal is unaffected: Previous and Next still walk the whole audience, because
the cursors come from the page **as fetched**, before anything is dropped.

A second, quieter limit: `member_consents` is visible only at the Station that
recorded it (0035), so this filter answers "the latest rules consent **you** can
see", exactly as the listener's own detail screen does.

### 5.3 Ages and date ranges, and which clock decides

The age filter is converted to a `birth_date` range — an age computed per row in
the `WHERE` clause would defeat `members_birth_date_idx` and scan the whole
Organization. The band's edges are computed from the **server's** calendar day, in
UTC, and so is the Age column, so the two always agree with each other. They can
disagree with the operator's own calendar for a few hours a day. That moves who
appears in a demographic count by at most one day at the boundary; it never
changes whether anyone is barred from anything.

The **registration date range** is treated more carefully, because Block 3's
whole-branch Critical was exactly this: a date input's value is a wall-clock day
with no zone, and interpreting it on a UTC server for a Brazilian operator shifts
it three hours. The filter form converts the chosen days to instants **in the
browser** — start of day and end of day, locally — and the URL carries instants.
`companies.timezone` (0003) still exists and is still read by nothing.

---

## 6. Definition of done

| Spec item | Where |
| --- | --- |
| §4 filters/sort/cursor in the URL, service builds the query | `members/list-params.ts`, `inventory/list-params.ts`, both services |
| §5 keyset cursor helper | `src/lib/keyset.ts` (+ `keysetPage`), 24 unit tests |
| §5 table primitive | `src/components/ui/table.tsx` |
| §5 bulk block predicate | `0036`, guard proved live and by mutation |
| §5 indexes | `0036` (created_at, birth_date), `0037`, `0038`, `0039` |
| §6 audience: columns, filters, sort, total | `members/page.tsx` — consent filter's total excepted (§5.2) |
| §6 inventory: server-side filter, paging, total | `inventory/page.tsx` — archived filter not built (§2.5) |
| §6 prize lookup by id | `getPrizeById`, scan and its `capped` caveat both deleted |
| §6 Team: no paging, two corrections | `team/page.tsx`, `deleted_at` confirmed to exist on the table first |
| §6 admin customers: paging and search, no total | `admin/customers/page.tsx` |
| §6 the 50-Station cap becomes search | `station-access.ts`, both consumers |
| §7 city is a column, never a filter | `members/page.tsx`; risk restated in §5.1 |
| §8 CSV export cut | nothing built, correctly |
| §9 errors: unreadable cursor starts over | `decodeCursor`, both screens |
| §10 testing | `tests/isolation/listing.test.ts`, §4 |
| §12 out of scope | nothing built |

---

## 7. Open items

1. **The archived-prizes filter needs an RLS decision, not a UI change** (§2.5).
2. **The city column's caveat is not on screen** (§5.1) — one line of copy would
   close it, if the owner wants it closed before the geography block.
3. **The rules-consent filter costs the total** (§5.2). The alternative is a
   schema change — a "current consent" projection maintained alongside the
   append-only log — which belongs to whichever block revisits consent, not here.
4. **`npm run test:e2e` still fails locally on the dev server**; the same nine
   journeys pass against a production build at two workers (§1.1). The dev-server
   profile is a five-second navigation budget against on-demand compilation, not
   a defect in the journeys.
5. **The e2e suite is not repeatable more than three times an hour on one
   machine** (§1.1), because invitation acceptance is rate-limited per IP. This is
   the production behaviour working correctly; it just reads like a regression.
6. **Nothing automated covers the two admin screens.** The customers console's
   paging and the Station search were verified by build, by the journeys that
   still traverse those screens, and by reading; neither has a test that would
   catch a keyset defect there the way `listing.test.ts` would on the audience.
