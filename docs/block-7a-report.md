# Block 7a — The Music Catalogue — Verification Report

**Date:** 2026-08-04
**Branch:** `block-7a` (cut from `main`, merge base `3363f4b`)
**Spec:** `docs/superpowers/specs/2026-08-03-block-7-music-design.md`
**Plan:** `docs/superpowers/plans/2026-08-04-block-7a-music-catalogue.md`
**Migrations:** `0098`–`0102`
**Commits:** `322bc02..153f9d3` (17 commits, Tasks 1–11; this report and the
runbook are Task 12, committed separately)

A Station's music catalogue — genres, record labels, artists, shows and
songs — now exists as six per-Station tables, secured by RLS, written
through six audited RPCs behind four permissions, and built by hand through
three screens (Songs, Artists, Catalog) reached from a new sidebar section.
The `music_requests` table is created and secured but written by nothing
yet — 7b brings the door. Twelve tasks; five genuine defects in the plan
document itself were found and corrected during execution (§4), and one
Critical defect in the shipped code was found and closed inside the block,
before merge (§5).

---

## 1. Gates

Every fast gate below was re-run for this report, on a freshly reset local
database, immediately before writing it — not carried over from an earlier
task's report.

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | clean — `✔ No ESLint warnings or errors` |
| Typecheck | `npm run typecheck` | clean — `tsc --noEmit`, no output |
| Build | `npm run build` | clean; `/music/songs` 5.12 kB / 136 kB, `/music/artists` 5.62 kB / 122 kB, `/music/catalog` 4.14 kB / 117 kB first load |
| Unit (Vitest) | `npm test` | **619 passed (619)**, 42 files |
| pgTAP (`db:test`) | `npm run db:test` | **1026** cases, 17 files, `Result: PASS` — `14_music_catalogue.test.sql` 40/40, `15_music_rpcs.test.sql` 27/27 (each also confirmed with an isolated single-file run) |
| Isolation (`test:isolation`) | `npm run test:isolation` | **not green as a single command** — see §1.1 |
| E2E (`test:e2e`) | `npm run test:e2e` | **not green at default parallelism; 28/28 serially** — see §1.2 |

A first `db:test` pass on this machine, before the reset, hard-failed
`15_music_rpcs.test.sql` with `more than one row returned by a subquery`
(a fresh `Águas de Março` fixture collided with a row left behind by an
earlier manual `psql` session during this block's own debugging). This is
local, dirty database state, not a code defect: `supabase db reset` followed
by `npm run db:test` reproduced the clean 1026/1026 above. Anyone running
these gates next should reset first, on this stack in particular — this
block ran more manual `psql` sessions against it than any prior block.

### 1.1 Isolation — reported truthfully, not as green

**`npm run test:isolation` cannot be claimed green as a single command
run.** It carries a pre-existing, documented, uncaused intermittent crash
(`Error: Worker exited unexpectedly`, first written up in
`docs/block-4b-report.md` §1.2/§1.3) that hits a random file's worker after
that file's own tests have already passed — the guard script
(`scripts/verify-isolation-suite.mjs`) correctly refuses to call such a run
green, because a file whose worker died is a boundary that was not checked,
even though the arithmetic in the run balances.

**Task 11's own acceptance evidence** — three consecutive runs against one
database, no `supabase db reset` between any of them:

| Run | Result | `music.test.ts` |
|---|---|---|
| 1 | clean — 21/21 files, 231/231 tests | 8/8 |
| 2 | crashed — 20/21 files reported, 231/231 tests still passed | 8/8, unaffected |
| 3 | clean — 21/21 files, 231/231 tests | 8/8 |

Two of the three were fully clean; the one crash hit a file this block never
touches (Run 2's missing file was one of the suite's other 20), and the
crash's mechanism — a worker dying after its own tests already passed — is
identical to the pattern documented before this block existed.

**This report's own fresh re-verification**, run today for this document,
three more consecutive runs on a newly reset database, again with no reset
between any of the three:

| Run | Result | `music.test.ts` |
|---|---|---|
| 1 | crashed — 20/21 files reported, 231/231 tests still passed, 1 unhandled error | not independently confirmed in the captured tail |
| 2 | clean — 21/21 files, 231/231 tests, `Isolation suite complete` | 8/8, confirmed |
| 3 | crashed — 19/21 files reported, 231/231 tests still passed, 2 unhandled errors; the missing files, by elimination against the actual 21 files on disk (`ls tests/isolation/*.test.ts`), are `inventory.test.ts` and `tenant.test.ts` | 8/8, confirmed |

A worse ratio than Task 11's own three runs (one clean of three, against
two of three), but the same conclusion holds on every measure that matters:
**`music.test.ts` reported its full 8/8 in every run where it is confirmed
present in the captured output, and every crash this session hit a file
this block does not own** (`inventory`, `tenant`, and one unidentified file
in Run 1 — none of them `music.test.ts`). Counted directly from the two
tables above: six runs total across the two verification sessions, **three
clean and three crashed** (Task 11's run 2, and this report's runs 1 and
3). Those three crashed runs lost **four file-instances** between them —
one in Task 11's run 2, one in this report's run 1 (unidentified), and two
in this report's run 3 (`inventory.test.ts`, `tenant.test.ts`) — none of
them `music.test.ts`, and no single file crashing twice. That is the flake
this project has carried since Block 4b, not a regression this block
introduced.

### 1.2 E2E — reported truthfully, not as green

`npm run test:e2e` (the literal command, Playwright's default parallelism —
32 logical cores on this machine) fails **14 of the suite's 28 specs**, all
at the identical first step: signing in as a freshly created platform admin
times out waiting for `/app` and lands on `/login` instead. Verified fresh
for this report:

```
14 failed
2 did not run
12 passed (39.7s)
```

Thirteen of the fourteen failing specs are unrelated to this block and
pre-existing (`deadline.spec.ts`, `delivery-flow.spec.ts`, `draw-flow.spec.ts`,
`filtered-draw.spec.ts`, `inventory-flow.spec.ts`, `invitation-flow.spec.ts`,
`members-flow.spec.ts`, `participations-flow.spec.ts`,
`promotion-prizes.spec.ts`, `promotions-flow.spec.ts`,
`provisioning-flow.spec.ts`, `record-dialog.spec.ts`, `roles-flow.spec.ts`);
`music-catalogue.spec.ts` is the fourteenth, failing at the exact same
generic step as the other thirteen. This is shared-resource contention
between the dev server and the local Postgres instance under heavy
parallelism on a high-core machine, not a functional defect —
`playwright.config.ts`'s own comment already names this class of problem.

Run serially, fresh for this report:

```
28 passed (2.6m)
```

**28/28, including `music-catalogue.spec.ts`.** This is the form this
report's own conclusions rest on. `npm run test:e2e` as literally specified
does not exit 0 on this machine; `npx playwright test --workers=1` does,
completely, every time it has been tried in this block.

---

## 2. What shipped

| Migration | What |
|---|---|
| `0098_music_catalogue.sql` | three enums (`music_nationality`, `music_vocal`, `music_request_channel`); six tables (`music_genres`, `record_labels`, `artists`, `shows`, `songs`, `music_requests`); four permission rows |
| `0099_rls_music.sql` | RLS enabled on all six, `select`-only grants to `authenticated`/`service_role`, one policy per table gated on `music.view`, `service_role`'s TRUNCATE explicitly revoked |
| `0100_music_reference_rpcs.sql` | `music_reference_kind` enum (`GENRE \| LABEL \| ARTIST \| SHOW`); `create_music_reference`, `update_music_reference`, `archive_music_reference` — one kind-discriminated trio for the four short lists |
| `0101_music_song_rpcs.sql` | `create_song`, `update_song`, `archive_song`, and the private validator `assert_song_references_live` |
| `0102_music_legacy_id_is_not_editable.sql` | drops and recreates `update_song`/`update_music_reference` with `p_legacy_id` removed entirely — the Critical fix, §6 below |

Confirmed against the live local database for this report: all six tables
exist with `relrowsecurity = t`; `update_song`'s and `update_music_reference`'s
current argument lists (`pg_get_function_arguments`) carry no `p_legacy_id`
parameter.

TypeScript: `src/schemas/music.ts`, `src/services/music.ts`; 22 files under
`src/app/(app)/music/` (three screens — `songs/`, `artists/`, `catalog/` —
plus the shared `errors.ts`/`format.ts`/`permissions.ts`); the `Music`
section in `src/lib/auth/shell.ts` and its icon in
`src/components/layout/app-shell.tsx`; `SONG_TABS`/`ARTIST_TABS` in
`src/lib/record-params.ts`; `src/lib/supabase/database.types.ts`
regenerated. Tests: `supabase/tests/14_music_catalogue.test.sql` (40
assertions), `supabase/tests/15_music_rpcs.test.sql` (27 assertions),
`supabase/tests/02_permissions.test.sql` extended by six RLS assertions,
`tests/isolation/music.test.ts` (8 cases), `tests/unit/music-schema.test.ts`
and `tests/unit/music-params.test.ts` (10 tests each), `tests/e2e/music-catalogue.spec.ts`
(1 journey).

Migrations `0098`–`0102` are this block's own; nothing in `0001`–`0097` was
edited in place.

---

## 3. What was built, against the spec's §7a scope

§7a's own prose says "the two catalogue screens (Songs, Artists, Catalog)"
— naming three screens while calling them two. The plan's own header
section ("Two readings of the spec this plan settles, and one it does not",
item 1) states this reading explicitly and flagged it as a slip in the
spec, not a scope reduction, and built all three: **Songs**
(the one entity with real fields — nationality, vocal, duration, label,
genre), **Artists** (with a two-tab record: the artist's own data, and the
songs that name them), and **Catalog** (one screen, three tabs, for
genres/labels/shows — the three short lists that are a name and nothing
else). `music_requests` — the sixth table §3 lists — is created, secured
and constrained here; nothing writes to it until 7b brings the door and the
Requests/Maintenance screens §5 assigns there.

### 3.1 The decisions this plan made that the spec did not

| Decision | Reasoning |
|---|---|
| One kind-discriminated trio (`create_music_reference`/`update_music_reference`/`archive_music_reference`) instead of twelve near-identical functions | All four short-list entities gate on the same single code, `music.manage` — 0027's reason for a separate RPC per operation (the permission check belongs beside the operation) does not apply when there is nothing to keep beside anything. Twelve near-identical bodies would be twelve places to apply one fix to eleven. It is also the shape §4 prescribes for 7b's merge (one private core, four public doors), so the block ends up with one idea rather than two. |
| `create_*` checks permission **before** resolving the Organization, departing from 0027's order | 0093 settled a rule 0027's `create_prize`/`create_prize_category` violate: resolving the Company and raising `P0002` before checking the permission tells an unauthorised caller whether an id exists before telling them they may not see it. `0100`/`0101` do not repeat that leak — traced through `has_company_access`, which itself requires the Company be active, so an unknown and an unreachable Company id are indistinguishable to an unauthorised caller either way. |
| Reads go through ordinary RLS and PostgREST keyset paging, never a `SECURITY DEFINER` list function | No listener identity sits on any of these six tables, so there is nothing here for D6's "who may see a listener's name" rule to protect — the reason 6d's `list_pickups`/`list_movements` needed their own `SECURITY DEFINER` doors does not apply. An ordinary `select` under 0099's policy is the whole boundary. |
| The Catalog screen calls `revalidatePath('/music/catalog')` on every write; Songs and Artists never do | Songs and Artists each hold state a fresh render would destroy — an open keyset cursor and, often, an open record dialog — so their actions patch one row of client-held state in place instead. Catalog has neither: its three lists are read whole (not paged) and there is no record dialog, the whole record is one field edited directly in its row. A fresh render is the cheapest correct answer where there is no state to lose, and the plan states this asymmetry explicitly at its own top so it is not mistaken for an inconsistency later. |
| `legacy_id` is not editable at all — no parameter, not just a disabled input | Originally planned as merely read-only in the UI. Execution found this insufficient (§6) and the fix went further than "read-only": the update RPCs no longer accept the value as an argument, for any caller, ever. |

---

## 4. The five defects execution found in the plan

Each of these is a mistake in the **plan document itself**, found by running
what the plan specified and observing a result the plan did not predict. All
five are now corrected in `docs/superpowers/plans/2026-08-04-block-7a-music-catalogue.md`
with an amendment note at the top of the affected task (precedent: commit
`9cc6e42`, "docs: three plan amendments execution forced").

1. **Task 2 — the RLS-failure headcount.** The plan predicted "sixteen
   assertions ... report false" before `0099` existed. The real number was
   **nine**. The other seven (assertions 32–35, 37, 40: `authenticated`
   cannot insert/update/delete, `service_role` cannot insert, `anon` cannot
   select) were already true under Postgres's own default ACL — a freshly
   created table on `public` grants `anon`/`authenticated`/`service_role`
   only `Dxtm` (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN), never
   SELECT/INSERT/UPDATE/DELETE — so there was nothing yet for those seven to
   catch. They are legitimate regression pins (each would catch a *future*
   migration that granted write access by mistake), not proof `0099` did
   anything; their own names never attribute the denial to `0099`. No
   assertion was weakened to reach this number — the diagnosis was checked
   against six other migrations' documented use of the same convention.

2. **Task 3 — the missing pgTAP actor fixture, and a wrong comment about
   why it wasn't needed.** The plan's `15_music_rpcs.test.sql`, as drafted,
   calls every `SECURITY DEFINER` RPC with no actor identity — no
   `set local request.jwt.claims`, no `role_permissions`/`company_memberships`
   fixture — and its own comment claimed this worked "because pgTAP runs as
   superuser." That conflates two different mechanisms: a superuser session
   bypasses table/function ACL (`GRANT`/`REVOKE EXECUTE`), which is genuinely
   why pgTAP can call these functions at all past `revoke execute ... from
   public` — but `has_permission` is not an ACL check, it is a business-rule
   query reading `auth.uid()`, and `auth.uid()` is NULL for a superuser
   session with no JWT claims set. Ten of fourteen assertions failed with
   `42501` as drafted; two more (13, 14) passed for the wrong reason — every
   call was refused by the same unconditional gate failure, not by the
   archived-row or unknown-id branch their comments claimed to exercise.
   This blocked Task 4 too, which appends nine more assertions to the same
   file. The fix: the house pattern already used six times in
   `02_permissions.test.sql` and in `11_filtered_hat.test.sql:351-366` — a
   role holding **both** `music.view` and `music.manage`, an `auth.users`
   row, a `company_memberships` row, and every RPC call bracketed with
   `set local role authenticated` / `set local request.jwt.claims` /
   `reset role`, with two verification reads (`audit_logs`, and any
   just-archived row's `deleted_at`) kept outside any such bracket because
   both are unreadable to the narrower actor. No assertion's text, error
   code or plan count changed.

3. **Task 6 — `optionalUuid` chains `.uuid()` before `.transform()`, so its
   own empty-string branch is unreachable.** Zod validates a `ZodString`'s
   own checks (`.uuid()` included) before running `.transform()`; the
   transform only ever receives a value that already survived the inner
   type's validation. `.nullable()`/`.optional()` only short-circuit the
   literal `null`/`undefined` — an empty string `''` is neither, so it
   reaches `.uuid()`, is refused as a malformed uuid, and the whole parse
   aborts before the transform's `v === ''` branch — which reads as
   load-bearing — ever runs. `optionalText` escaped this only because it
   carries no format check at all, and `nationality`/`vocal`
   (`z.enum(...).nullable().optional()`, no transform) carried the identical
   shape, not caught by the plan's own pinned test. The fix: resolve
   emptiness **before** validation with `z.preprocess`, not after it in a
   `.transform()` the validator never lets the value reach. Confirmed by an
   isolated repro (`optionalUuid.safeParse('')` failing pre-fix, passing
   post-fix) and confirmed the fix does not widen the inferred output type
   to `unknown` — checked with a compile-time type-equality assertion that
   was itself proven capable of failing before being trusted.

4. **Task 11 — the e2e spec's archive-refusal assertion asserts a string
   the UI never renders.** The plan's spec checks
   `/still has songs registered/i`. `archive_music_reference`'s `23503`
   refusal is mapped by the shared `mapMusicError`/`describeMusicWriteError`
   pair to one fixed sentence reused across all four reference kinds
   (genres, labels, artists, shows) — the RPC's own message carries a row
   count, not an entity kind, so the UI cannot say "songs" without
   threading a kind through every existing caller of a shared error mapper.
   Task 9's review ruled the generic wording ("You cannot archive this
   artist yet — it still has other records registered against it. Move or
   archive them first.") functionally acceptable rather than requiring that
   change. The spec now asserts the real sentence.

5. **Task 5/11 — the isolation suite's own fixture cannot survive a second
   run.** `tests/isolation/music.test.ts` calls `provisionCustomer('music7a')`
   with a bare literal, and its five `grantRoleWith` labels are bare
   literals too — the only file in the whole isolation suite that does this
   (every other file stamps its label, e.g. `inventory.test.ts`'s
   `` `inv-floor-${Date.now()}` ``). `cleanupUsers` failing to delete a user
   an audited RPC has referenced is documented, expected behaviour, not a
   bug — but because this file's labels never change, the two fixed
   e-mails they produce can survive one run and collide with the next run's
   `createUser` call. This surfaced as `Task 11: createUser failed: A user
   with this email address has already been registered`, initially
   misdiagnosed by the implementer as a pre-existing harness limitation
   (corrected by the controller with a direct comparison against
   `inventory.test.ts` and `conversation.test.ts`'s own stamping). The fix
   — one module-level `const STAMP = Date.now();`, applied to all six
   label sites — was verified the only way it could be: three consecutive
   runs with no reset between them (§1.1's Task-11 table), the exact
   condition that broke it deterministically every time before the fix.

---

## 5. The `legacy_id` Critical, in full

**The most serious defect this block found.** Every ordinary edit-and-save
of an imported song or reference record silently erased the ETL's
idempotency handle.

**The mechanism.** `legacy_id` was rendered as a read-only `<input>` in the
edit form, with no `name` attribute — a deliberate choice, and the correct
one for keeping the field out of `FormData`. But `updateSongAction`
unconditionally called `formData.get('legacyId')`, which is `null` for any
field that was never in the form; that `null` passed through
`songUpdateSchema`'s `optionalText(120)` transform as `undefined`, and
`services/music.ts`'s `updateSong` sent the RPC call with the key omitted
entirely. `update_song`'s parameter declared `p_legacy_id text default
null` — so the omitted key took that default — and the function's `UPDATE
... SET ... legacy_id = v_legacy ...` applied that default **unconditionally**,
on every call, with no branch skipping it when the caller never supplied
one. `update_music_reference` carried the byte-for-byte identical shape.

Net effect: **any song or reference record with a real `legacy_id` had it
erased on the very first edit-and-save**, silently — no error, no warning,
the record simply looked fine and worked fine, forever, with its import
handle gone.

**Why it mattered.** D7's `legacy_id` uniqueness (a partial unique index per
Station) is the *only* thing standing between Block 9's ETL and duplicating
an entire catalogue on a second import run — D2 deliberately removed every
other uniqueness (name, title+artist), on the reasoning that a duplicate
song is a real-world fact an operator can fix, not an error to prevent. Once
`legacy_id` is gone from a row, that row is invisible to the one check that
would have refused a re-import, and the next ETL run inserts it again as if
it had never been seen — silently doubling that record and every song,
request or count that references it.

**Why the fix removed the parameter rather than adding a hidden field.** A
hidden field carrying the current value forward would have stopped the
accidental erasure, but the column would still be writable by a
hand-crafted POST — a "read-only" guarantee that holds only in the browser
is not a guarantee. The chosen fix (migration `0102`, a `DROP FUNCTION` /
`CREATE FUNCTION` pair, since a parameter-list change cannot use `CREATE OR
REPLACE`) removes `p_legacy_id` from both update RPCs' signatures entirely
— there is no longer any argument, for this UI or any other future caller,
that could write to the column on an update. `create_song`/
`create_music_reference` are untouched: creation is where the ETL sets the
handle, and that path was never broken.

The pgTAP proof added for this (`15_music_rpcs.test.sql`, `plan(23)` →
`plan(27)`) deliberately checks the value **survives** an update, looked up
by a different column (`internal_code`) than the one being proven — an
assertion that looked up by `legacy_id` itself would have gone from
"checking the vocal" to silently vacuous had the bug still been present,
finding no row rather than failing loudly on the actual claim.

Confirmed against the live database for this report:
`pg_get_function_arguments` on both `update_song` and `update_music_reference`
shows no `p_legacy_id` parameter in either signature.

---

## 6. What is knowingly missing

- **`shows` has no cure for a duplicate.** D2 allows duplicates everywhere
  and D3 gives songs, artists, labels and genres a merge door in 7b; `shows`
  gets neither a unique index nor a merge door. This is a deliberate gap
  recorded in the migration's own table comment, not an oversight — adding
  `merge_shows` in 7b is one more `when` branch in the core and one more
  `update`, and whether it is wanted is the owner's call at 7b.
- **Song search does not reach the artist's name.** PostgREST's `.or()`
  cannot cross into an embedded resource (`artists(name)`), and running a
  second query to widen the search would make the "exact count" keyset
  paging depends on wrong. The search box covers `title`/`internal_code`
  only; the Artists screen is deliberately where an artist is found by
  name.
- **`music.request` and `music.merge` are granted from this block and guard
  nothing until 7b.** Both permission codes exist and can be assigned in
  the role editor today, at zero present capability — the same shape
  `allows_return_to_stock` (0025, consumed by Block 6) already established
  in this codebase. The cost, stated rather than discovered: a role granted
  either code today acquires a real capability silently the day 7b ships.
- **No "show archived" filter exists, and none can be built client-side.**
  0099's select policies filter `deleted_at is null` **inside the policy
  itself**, so an archived row is not merely hidden from a list — it is
  unreadable through RLS for every caller, including the owner. This is the
  same finding `services/inventory.ts` records for prizes; 7b's merge reads
  its own archived rows from inside a `SECURITY DEFINER` body, where this
  policy never applies.

---

## 7. The Station-switcher defect — fixed in this block's own three screens, not fixed in five others

Eight screens in this codebase build the Company-switcher link the same
way: a `<Link>` whose query carries `companyId` alone, dropping the active
Station search. `songs/page.tsx`, `artists/page.tsx` and `catalog/page.tsx`
all resolve their Station with `viewable.find((c) => c.id ===
params.companyId) ?? first`, where `viewable` is the **capped, unfiltered**
top-fifty-Station alphabetical list from `listCompanyAccess` — a Station
reachable only through the Station-name search box is not in that list. So
an operator who searched to reach such a Station, then clicked the
Company-switcher badge, would silently fall through to `?? first` and land
on a **different** Station's catalogue, with nothing on screen indicating
the Station had changed.

**This block fixed its own three** (`music/songs`, `music/artists`,
`music/catalog`) — the switcher's `href` now spreads `station` into the
query only when a search is active, the identical shape in all three files,
verified independently in each rather than accepted as "identical in
three files."

**It deliberately left the five it does not own, carrying the identical
defect, unpatched:** `inventory`, `inventory/movements`, `participations`,
`pickups`, `promotions`. Shipping a known defect in new code because old
code already has it would have been the wrong trade; touching the other
five would have been a cross-cutting change across screens this block never
opened, for a defect this block did not introduce. Grepped fresh for this
report — all five still build the switcher link the old way. **Named here
for the owner to decide**, not fixed here.

---

## 8. Deferred minors

Listed from the execution ledger for the final review and the owner to
triage — none blocking, none load-bearing:

- The composite FK `(company_id, organization_id) references companies (id,
  organization_id)` reads positionally, not name-aligned — house pattern
  from 0025, a grep trap rather than a defect.
- The four short-list tables carry `created_by`; the house precedent
  `prize_categories` (0025) omits it. A defensible deviation, but
  unannounced in the plan.
- pgTAP assertion 24 in `14_music_catalogue` (`isnt music.merge`) overlaps
  assertion 23 (`count = 4`) — both fail together, limited independent
  signal.
- `14_music_catalogue.test.sql` asserts `service_role` INSERT- and
  TRUNCATE-denial but not UPDATE/DELETE-denial, asymmetric with the
  `authenticated` block — a pre-existing house-style gap, matches the
  brief.
- Assertions 3, 4 and 10 in `15_music_rpcs.test.sql` read as superuser
  though the actor holds `music.view` and could read them as
  `authenticated` — harmless as shipped.
- `15_music_rpcs.test.sql:192-194`'s comment explaining the `e1b1`/`e1b2`
  artist-id naming choice buries the more load-bearing fact (that `e1a1`/
  `e1a2` are already taken by the role and its `auth.users` row) under
  stylistic framing — not a defect, just could be terser.
- `optionalText` (`src/schemas/music.ts`) hand-rolls the same blank-check
  `blankToUndefined` now names explicitly — harmless, but two spellings of
  one idea in one module.
- `tests/isolation/music.test.ts` case 7's `create_song` fixture call is
  left without its own error assertion — self-defending (a silent failure
  there would leave nothing for the subsequent archive call to refuse, so
  the case's own assertion would already fail loudly), consistent with the
  review's stated minor scope.
- `SONG_SEARCH_MAX_LENGTH` is reused to bound the artist-name search
  (`services/music.ts`) rather than declaring a constant of its own.
- Task 7's own report overstates the significance of
  `archiveMusicReference`'s argument order — supabase-js RPC arguments are
  named, not positional, so the order carries no real risk.
- Task 9's own review flagged the generic wording of
  `describeMusicWriteError`'s archive-refusal sentence as a candidate
  polish item; the reviewer's verdict was functionally acceptable, not a
  defect. (This is the same shared-mapper mechanism §4 item 4 explains in
  full, as the reason Task 11's plan amendment was needed — recorded once
  there, cross-referenced here rather than re-explained.)
- The Catalog screen's `archiveReferenceAction` kind-validator originally
  admitted `'ARTIST'`, which is not one of that screen's three tabs —
  narrowed to the screen's own three kinds in fix round 1.
- Station-switch and tab-switch on the Catalog screen do not cross-preserve
  `tab=` — a minor UX gap, not a boundary issue.
- The final review of Task 11 did not independently re-run the isolation
  and e2e gates; it accepted the implementer's argued status. Both are
  environment findings this report's own fresh re-verification (§1) now
  covers independently.

---

## 9. Not done

**The PR is not open.** The owner decides when it opens.

**Nothing in 7b was started here**, per the plan's own scope line: the
merge core, the four merge doors, the Requests screen and door, and the
Maintenance screen are all 7b's. `music_reference_kind`'s own comment
warns explicitly that its four kinds (`GENRE | LABEL | ARTIST | SHOW`) are
not 7b's merge kinds (songs, artists, labels, genres — shows is not among
them and songs is), so 7b must declare its own enum rather than reuse this
one.
