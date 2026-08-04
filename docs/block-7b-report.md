# Block 7b — Requests and the First Merge — Verification Report

**Date:** 2026-08-04
**Branch:** `block-7b` (cut from `main` at `6117bc8`, PR #24 — the Station-switcher
search fix)
**Spec:** `docs/superpowers/specs/2026-08-03-block-7-music-design.md`
**Plan:** `docs/superpowers/plans/2026-08-04-block-7b-requests-and-merge.md`
**Migrations:** `0105`–`0108`
**Commits:** `dd1b11e..1a11308` (21 commits, Tasks 1–10; this report and the
runbook are Task 11, committed separately)

This block gives the catalogue Block 7a built two things it did not yet
have: a place to record what a listener asked for, and a way to collapse a
duplicate without losing its history. `music_merges` is the first merge this
codebase has ever had — one private `SECURITY INVOKER` core
(`apply_music_merge`) and five `SECURITY DEFINER` doors (`merge_songs`,
`merge_artists`, `merge_record_labels`, `merge_music_genres`, and
`merge_shows` — a fifth door the spec's D3 left as "the owner's call at 7b"
and the owner ruled for on 2026-08-04, so this block ships one more door than
the design spec names). `music_requests`, created and secured but unwritten
in 7a, now has three doors (`create_music_request`, `archive_music_request`,
`list_music_requests`) and a screen. A fourth read, `list_merge_candidates`,
feeds the Maintenance screen where an operator stages duplicates and merges
them. Eleven tasks; the database layer (Tasks 1–5) closed before any
TypeScript was written, on the plan's own reasoning that a merge is only
provable once there is something to merge.

---

## 1. Gates

Every gate below was re-run for this report, on a freshly reset local
database (`npx supabase db reset`, applying through `0108`), not carried
over from Task 10's numbers.

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | clean — `✔ No ESLint warnings or errors` |
| Typecheck | `npm run typecheck` | clean — `tsc --noEmit`, no output |
| Build | `npm run build` | clean; `/music/requests` 6.54 kB / 136 kB, `/music/maintenance` 5.77 kB / 132 kB first load |
| Unit (Vitest) | `npm test` | **706 passed (706)**, 49 files |
| pgTAP (`db:test`) | `npm run db:test` | **1084 tests**, 19 files, `Result: PASS` — `16_music_merge.test.sql` and `17_music_requests.test.sql` both `ok` |
| Isolation (`test:isolation`) | `npm run test:isolation` | **not uniformly green across repeated runs** — see §1.1 |
| E2E (`test:e2e`) | `npm run test:e2e` | **not green at default parallelism; 29/29 serially** — see §1.2 |

The numbers this report was asked to verify (706/49, 1084/19, a clean 22/22
isolation run, and 29/29 e2e serially with the identical 15-spec failure
list at default parallelism) all reproduced exactly as stated. Nothing below
is copied from an earlier task's report without having been observed again
here.

### 1.1 Isolation — reported truthfully, not as green

`npm run test:isolation` carries the same pre-existing, uncaused intermittent
crash documented since `docs/block-4b-report.md` §1.2/§1.3 and re-confirmed
in `docs/block-7a-report.md` §1.1: `Error: Worker exited unexpectedly` hits a
random file's worker after that file's own tests already passed, and the
guard script (`scripts/verify-isolation-suite.mjs`) correctly refuses to
call such a run green.

**Two runs for this report, on the freshly reset database, no reset between
them:**

| Run | Result | `music-merge.test.ts` |
|---|---|---|
| 1 | crashed — 20/22 files reported, 242/242 tests still passed, 2 unhandled `Worker exited unexpectedly` errors | not independently confirmed in the captured tail |
| 2 | clean — 22/22 files, 242/242 tests, `Isolation suite complete` | 11/11, confirmed |

The crash in Run 1 is the same shape every prior block records: the tests
that *did* run all passed (242/242 both times — the arithmetic never
disagrees), and nothing about which two files went unreported points at this
block's own file. This matches Task 9's fix-round-2 observation (one clean
run of `test:isolation` after the `music.view` gate change, no reset
needed — `progress.md`'s own entry for that round) and Task 10's own clean
run — three of the four most recent observations of this suite, across two
sessions, are clean; one crashed. The conclusion this report draws is the
same one 7a's §1.1 drew: this is the inherited flake, not a regression.

### 1.2 E2E — reported truthfully, not as green

`npm run test:e2e` (default parallelism, 32 logical cores on this machine)
fails **15 of the suite's 31 specs**, all at the identical first step: a
freshly created platform admin's sign-in times out waiting for `/app` and
lands on `/login` instead. Verified fresh for this report:

```
15 failed
2 did not run
12 passed (38.5s)
```

Fourteen of the fifteen are the exact specs `docs/block-7a-report.md` §1.2
names as pre-existing (`deadline.spec.ts`, `delivery-flow.spec.ts`,
`draw-flow.spec.ts`, `filtered-draw.spec.ts`, `inventory-flow.spec.ts`,
`invitation-flow.spec.ts`, `members-flow.spec.ts`, `music-catalogue.spec.ts`,
`participations-flow.spec.ts`, `promotion-prizes.spec.ts`,
`promotions-flow.spec.ts`, `provisioning-flow.spec.ts`,
`record-dialog.spec.ts`, `roles-flow.spec.ts`). The fifteenth is
`music-requests.spec.ts` — this block's own new spec, failing at the
identical generic sign-in-timeout step as the other fourteen, the same shape
§1.2 already records for `music-catalogue.spec.ts` when *it* was new. This
is shared dev-server/Postgres contention under this machine's parallelism,
not a functional defect in anything this block built.

Run serially, fresh for this report:

```
29 passed (2.7m)
```

**29/29, including `music-requests.spec.ts`** (12.9s on its own line), and
`music-catalogue.spec.ts` (9.8s). This is the form this report's own
conclusions rest on, exactly as §1.2 established for 7a: `npm run test:e2e`
as literally specified does not exit 0 on this machine;
`npx playwright test --workers=1` does, completely, every time it has been
tried across both blocks.

---

## 2. What shipped

| Migration | What |
|---|---|
| `0105_music_merges.sql` | `music_merge_kind` enum (`SONG, ARTIST, LABEL, GENRE, SHOW`); the private `music_merge_table(kind)` lookup (`IMMUTABLE`, revoked from `public`, no grant); `music_merges` — the history table (winner, loser, kind, reason, `children_moved`, actor, timestamp), RLS gated on `music.view`, no write grant to anyone but the doors; the three comments 0098/0100 needed re-issued (not edited — those files are already merged) once the owner ruled `shows` gets a fifth door |
| `0106_music_merge_doors.sql` | `apply_music_merge` — the private `SECURITY INVOKER` core, revoked from `public`, granted to nobody; five `SECURITY DEFINER` doors (`merge_songs`, `merge_artists`, `merge_record_labels`, `merge_music_genres`, `merge_shows`), each gated on `music.merge` before existence is revealed; five non-partial indexes added in fix round 1 so the repoint is not a full scan (0098's four child indexes are partial on `deleted_at is null`, which the repoint deliberately does not filter by) |
| `0107_music_requests_rpcs.sql` | `create_music_request` (gated `music.request`), `archive_music_request` (gated `music.request`, soft delete only), `list_music_requests` (gated `music.view`, restating D6's three identity rules by hand since it is `SECURITY DEFINER` and inherits no RLS) |
| `0108_list_merge_candidates.sql` | the Maintenance screen's one read — shipped gated on `music.merge`, regated to `music.view` during Task 9 (§6 below) |

Confirmed live for this report (`docker exec` into the local Postgres
container):

```
select code, module, label from public.permissions where module = 'music' order by display_order;
```

returns the same four rows 7a's runbook records — `music.view`,
`music.manage`, `music.request`, `music.merge` — unchanged; this block adds
no new permission row, only doors behind the two that shipped inert in 7a.
And, querying `pg_proc`/`pg_get_function_identity_arguments` directly: all
eleven new functions exist with the security mode and grants above —
`apply_music_merge` and `music_merge_table` are `prosecdef = f` (INVOKER)
with `authenticated` holding no `EXECUTE`; the other nine are `prosecdef = t`
(DEFINER) with `authenticated` holding `EXECUTE` on exactly those nine.

TypeScript: `src/schemas/music.ts` and `src/services/music.ts` extended (not
replaced); `src/app/(app)/music/requests/` (`page.tsx`, `list-params.ts`,
`requests-filters.tsx`, `requests-grid.tsx`, `record-request-form.tsx`,
`actions.ts`) and `src/app/(app)/music/maintenance/` (`page.tsx`,
`merge-panel.tsx`, `actions.ts`, `list-params.ts`) — two full screens;
`src/app/(app)/music/errors.ts` extended with `describeMergeError`;
`src/lib/auth/shell.ts`'s Music section extended with Requests and
Maintenance (in that order, after Songs/Artists/Catalog); `database.types.ts`
regenerated (purely additive, 147 insertions). Tests:
`supabase/tests/16_music_merge.test.sql` (40 assertions, up from 7a's
baseline of 9 at Task 1; §12 below records the last 4, added in the final
whole-branch review),
`supabase/tests/17_music_requests.test.sql` (18 assertions, new file),
`tests/isolation/music-merge.test.ts` (11 cases, new file),
`tests/unit/music-merge-schema.test.ts`,
`tests/unit/music-request-params.test.ts`,
`tests/unit/music-request-service.test.ts`,
`tests/unit/music-maintenance-params.test.ts`,
`tests/unit/music-merge-staging.test.ts` (all new),
`tests/unit/music-schema.test.ts` (extended),
`tests/e2e/music-requests.spec.ts` (1 new journey — the round trip described
in §5 below).

Migrations `0105`–`0108` are this block's own; nothing in `0001`–`0104` was
edited in place. (`0098`'s and `0100`'s comments naming `shows` as having "no
cure for a duplicate" are corrected by **re-issuing** `comment on …`, in
`0105`, not by editing the already-shipped files — the append-only rule
applies across the 7a/7b boundary the same as within it.)

---

## 3. What was built, against the spec's §7b scope, and the decisions the plan made that the spec did not

§7b's own scope line: "`music_merges`, the four doors, the requests screen
with manual entry, and the maintenance screen." This block ships **five**
doors, not four — the owner's 2026-08-04 ruling, recorded in the plan's own
"Two amendments to the spec this plan carries" section, that `merge_shows`
should exist: D2 removed every unique index a show could have used to
prevent a duplicate in the first place, and archiving one leaves the
requests that name it pointing at an archived row exactly as D2's own
reasoning describes for a song. Three places in the already-shipped 7a code
predicted the opposite (`0098`'s `comment on table public.shows`, `0100`'s
`NOTE FOR 7b` header, and `src/schemas/music.ts`'s doc line on
`MUSIC_REFERENCE_KINDS`) and are corrected — the first two by re-issued
comments in `0105`, since `0098`/`0100` are already merged, the third by a
direct edit since it was never merged.

The plan itself made three decisions the spec left unstated, all confirmed
in the shipped code:

| Decision | Reasoning |
|---|---|
| The core takes the Station as an argument (`apply_music_merge(p_kind, p_company_id, p_winner_id, p_loser_ids, p_reason)`) and scopes its lock to it | Makes "refuses records belonging to a different Station" true **by construction**. A comparison after the fact would be an oracle — a caller could tell "wrong Station" from "does not exist" by which error came back. Scoped this way, a loser in another Station is simply not found, and answers the identical `P0002` as an unknown uuid. Task 2's fix round proved this directly: an added cross-Station assertion (29) answers `P0002`, not a distinguishable code. |
| Winner and losers are locked in **one** pass, ordered by id — not winner-first | Two operators merging overlapping sets in opposite directions (A: "W wins, L loses"; B: "L wins, W loses") would deadlock under winner-first ordering; one `order by id … for update` pass makes them queue instead. Task 2's review independently confirmed the `LockRows` node really does sit above the `Sort`, so the rows lock in sorted order, not source order. |
| The repoint moves withdrawn (soft-deleted) children too, and `children_moved` counts them | D3's whole failure mode is a merge that forgets its `update`; the column asks in production, months later, the same question §6 of the spec asks a test to ask once. Leaving a withdrawn request pointing at a row the merge just archived would mean the same uuid means two different things depending on which side of `deleted_at` is read. |

---

## 4. What Block 9 inherits: a merged loser keeps its `legacy_id`, and the unique index does not filter `deleted_at`

**This is the single most load-bearing fact this report hands forward, and
nothing written before this report says it anywhere.**

`songs_legacy_unique` — unchanged since 7a, confirmed again against
`0098_music_catalogue.sql:242` for this report — is:

```sql
create unique index songs_legacy_unique on public.songs (company_id, legacy_id) where legacy_id is not null;
```

`apply_music_merge` soft-deletes a loser (`deleted_at = now()`); it never
issues a `delete`, and it never clears `legacy_id`. The index has no
`deleted_at is null` predicate. So **an archived loser still occupies its
`(company_id, legacy_id)` slot** after being merged away.

**This is correct, not an oversight.** D7 exists so a second ETL run does
not duplicate a record it already imported. If merging a loser freed its
`legacy_id`, the next import run would see that handle as available, insert
a fresh row carrying it, and silently resurrect exactly the duplicate the
merge had just collapsed — undoing the merge one import cycle later, with no
error anywhere.

**The consequence for Block 9:** any lookup the ETL does against `legacy_id`
— "have I already imported this row?" — must include archived rows
(`deleted_at is not null`), not only live ones. 0099's ordinary RLS `select`
policies filter `deleted_at is null` *inside the policy itself*, so a
service-role or ordinary-caller read through the normal path cannot see an
archived row at all; a lookup written against the public API the way the
catalogue screens read it will never find the occupied handle. If Block 9's
importer does a plain `select … where legacy_id = $1` through the anon/
authenticated path and gets nothing back, it will `insert` a second row,
collide with the still-live unique index on the winner's own row if the
titles matched by chance, or — far more likely, since the winner's
`legacy_id` is a different value — simply succeed and duplicate a song this
block's own merge tool had already fixed. Reading `23505` (a genuine
collision, because the *loser's* handle is still taken) and treating it as a
fault, rather than as "this row was already imported and later merged away,"
is the specific misreading this report exists to prevent. Neither `0098`
nor this block's own migrations state this anywhere else; it lives only
here and in the `0105`/`0106` code comments a future reader would have to
reconstruct by hand.

---

## 5. `children_moved = 0` is a legitimate outcome, not a failure

Two duplicates that nobody had used yet — no request ever pointed at
either — merge cleanly and move zero children. `music_merges`'
`children_moved` column (`0105_music_merges.sql:64`) carries this in its own
comment: *"Zero is a legitimate value — a duplicate nobody had used yet."*
The check constraint (`music_merges_children_not_negative`) only forbids a
negative count; zero passes freely.

Both places that report the number to a human say so plainly:

- The history row itself carries `children_moved = 0` with no separate flag
  distinguishing "verified zero" from "verified two" — the number is the
  fact, six months later, that answers "did this merge actually do
  anything to the catalogue beyond archiving a row."
- The Maintenance screen's confirmation dialog renders a genuinely different
  state on success (`state.ok === true`) than on the confirmation prompt or
  a failure: the title becomes "Merge complete" (not "Merge these
  records?"), the text is styled `text-emerald-700` and carries
  `data-testid="maintenance-merge-result"` (not
  `maintenance-merge-confirmation-text`), and `childCountLabel(kind, 0)`
  renders as `"0 songs"` / `"0 requests"` — a real, correctly-pluralised
  count, not a blank or an error string. Task 9's review confirmed directly
  that "0 records moved" is distinguishable from a failure by title, colour
  and `testid` all three, not merely by the number reading zero.

---

## 6. The permission the plan got wrong, and the ruling that fixed it

`list_merge_candidates` (`0108`) shipped gated on `music.merge`, following
the plan literally — the door that actually destroys data is `music.merge`,
so the read that feeds it seemed to belong beside it. Task 9's review caught
the consequence: the brief separately required the Maintenance screen to
render a **read-only mode** for a caller holding `music.view` but not
`music.merge` (search and see duplicates, no staging, no merge button). Both
requirements cannot hold together — `page.tsx` reads the candidate list and
`getMusicPermissions` in the same `Promise.all`, so a caller without
`music.merge` had the read itself throw `42501` before the read-only render
could ever happen. The screen returned a bare error card instead — the
redirect the brief explicitly forbade, wearing a different hat.

**The ruling (Task 9, fix round 1):** regate `0108` to `music.view`, leave
destruction on `music.merge` in all five doors. D8 defines `music.view` as
"see the catalogue **and the requests**" — a list of duplicate candidates,
with a `child_count` aggregating rows the caller can already read one at a
time, is exactly that kind of seeing. Every column `list_merge_candidates`
returns is already reachable through 0099's ordinary policies to a
`music.view` holder; the `music.merge` gate protected nothing that was not
already visible, and cost the screen its required read-only mode instead.

This closed in two steps because the first one missed a consumer: fix round
1 corrected the migration and `page.tsx`; fix round 2 found that
`tests/isolation/music-merge.test.ts` still asserted `42501` for a caller
holding `['music.view', 'music.manage']` — a case written for the old gate,
now failing because that caller legitimately succeeds. The case was rewritten
to prove the *new* contract directly with a live Postgres role: a caller
holding `music.manage` **alone** is refused (`42501`, unchanged conclusion,
different reason), and a new case proves a caller holding `music.view`
**alone** succeeds — the one property the whole ruling rests on, which pgTAP
cannot prove (it runs as superuser with a null `auth.uid()`, so
`has_permission` never actually gates anything there). Recorded as a defect
execution found in the plan's own reasoning, not a design choice the plan
made on purpose — nothing in the design spec or the plan document argues for
gating a read on the destructive permission; it was simply the literal,
untested first draft.

---

## 7. The mutation proof: what breaks if a merge forgets to move its children

Per the design spec's §6 ("the merge actually moves the children ... a test
that checks only the soft delete passes over a function that forgot its
`update`") and the plan's own required Step 5, Task 2 deliberately broke
`apply_music_merge`'s `SONG` branch — replacing the real repoint

```sql
update public.music_requests
   set song_id = p_winner_id, updated_at = now()
 where song_id = v_loser;
```

with a faithful no-op (`update public.music_requests set song_id = song_id
where false` — chosen over a bare `null;` specifically because a PL/pgSQL
no-op would have left `GET DIAGNOSTICS ROW_COUNT` reading a stale count from
the prior locking query rather than a true zero) — and re-ran the pgTAP
suite.

**Result, reproduced exactly as Task 2 recorded it:**

```
Failed test 17: "merge_songs repoints both requests and says so"     have: 0  want: 2
Failed test 18: "both requests now point at the surviving song"      have: 0  want: 2
Failed test 19: "nothing is left pointing at the absorbed song"      have: 2  want: 0
Failed test 24: "the history row records how many children moved"   have: 0  want: 2
Failed 4/28 subtests
Failed tests:  17-19, 24
```

**Assertions 17, 18, 19 and 24 failed, and nothing else did** — 24 of the
then-28 assertions in the file stayed green, confirming the failure is
localized to the child-repoint proof rather than a side effect of fixture
drift or test ordering. This is the concrete evidence that the suite catches
the one defect the design spec's §6 names by name: a merge that soft-deletes
its loser correctly but forgets to move what pointed at it. The real
repoint was restored and the full suite re-verified green (28/28 at the
time; 36/36 after later tasks extended the file) before the commit that
introduced the mutation was made.

---

## 8. The defects the plan introduced, and the reviews caught

Each of these is a mistake in the plan itself or in a first-draft
implementation of it, found by running what was specified rather than
trusting it. None reached `main`; all are fixed in the commits recorded in
`progress.md`.

1. **The plan's `create_music_request`, as originally drafted, used bare
   `exists` reads for the song and the show it names — 0103's race one
   level down.** `0103_music_reference_locks.sql` closed a race where a song
   naming an artist could be read unlocked while a merge or archive ran
   concurrently; the plan's first draft of a *request* naming a song
   repeated the identical mistake at a different join. Task 2's review
   hand-off caught it before Task 3 was even dispatched: an unlocked
   `exists` check is never blocked by the merge core's `for update` lock on
   the song it is about to archive, so a request could commit naming a song
   the merge had just repointed away from under it. The plan was amended
   (commit `67bdf21`, before implementation) to `perform … for key share`
   — `perform`, deliberately, not `exists`, because `exists` discards
   whatever lock the query would have taken.
2. **The listener itself was still read unlocked.** Even after the song/show
   fix above, Task 3's first implementation checked the *member* with a bare
   `if not exists (...)`. `anonymize_member` (0034) takes `for update` on
   the member row; an unlocked read here is the same race, one join further
   out — an erasure could commit between the check and the `insert`,
   attaching a fresh request to a listener who no longer legally exists,
   which is the exact outcome the function's own comment says the check
   exists to prevent. Task 3's review (Important 1) caught it; the fix
   converted the check to `perform 1 … for share of m` then `if not found`,
   matching `record_member_consent`/`add_member_note`/`block_member`
   (0034), which all take `FOR SHARE` in the identical shape.
3. **The cursor guard was copied from `0095` without `0095`'s reason to use
   that form.** `0090` and `0096` guard a NOT-NULL sort key with
   `p_cursor_at is null or p_cursor_id is null` (both conditions); only
   `0095` uses the single-condition form, and its own comment explains why
   it must — `deadline_at` is nullable there. `requested_at` is NOT NULL, so
   copying `0095`'s single-condition guard let a caller pass a
   `p_cursor_id` with a null `p_cursor_at` and get `requested_at < null` —
   `NULL`, zero rows, no `total_count` row — a silent empty page from the
   one list whose Rule 1 exists specifically so empty pages are never
   silent. Task 3's review (Important 2) caught the mismatch; the guard was
   widened to the two-condition form used everywhere else this shape
   applies.
4. **The pgTAP assertion for `create_music_request`'s argument shape caught
   only replacement, never addition, of the wrong overload.** The original
   assertion counted overloads of `create_music_request` excluding any
   whose argument list contained `'channel'` and asserted the count was `1`
   — which stays `1`, and passes, if a six-argument overload were added
   *beside* the original five-argument one rather than replacing it. That
   is the exact failure mode the assertion's own comment warned against: "a
   silent way this rule dies." Task 3's review (Important 3) caught it; the
   assertion was split into two — the name resolves to exactly one
   overload, full stop, and that one overload carries no channel argument —
   which a spurious second overload would fail on the first half.
5. **A staged merge basket survived a Company switch on the Maintenance
   screen.** `<MergePanel key={state.kind}>` remounted the panel on a
   kind-tab change but not on the Company-switcher `<Link>`, which is a
   soft navigation to the same route. An operator who staged duplicates,
   then switched Station via the badge, kept their staged rows, named
   survivor and typed reason while the candidate list silently became the
   new Station's — and because nothing server-side re-derives the Station
   from the operator's screen state (every door resolves it from the
   *winner* row itself), a group with duplicate titles across Stations (the
   normal case) could merge the wrong Station's pair, irreversibly. Task
   9's review flagged this as CRITICAL 2; the fix keys the panel on
   `` `${state.companyId}:${state.kind}` `` instead of `state.kind` alone.

A sixth item belongs beside these even though it is not a bare defect in the
same sense: the `music.merge` gate on `list_merge_candidates` (§6 above) —
recorded there in full because the brief that commissioned this report
singles it out as its own finding, not folded into this numbered list.

---

## 9. What is knowingly missing

- **`WHATSAPP` is not a `music_requests.channel` value yet.** The design
  spec (§8) names this explicitly as its own future block, adding the value
  "the way Block 6d added two enum values in `0091` — in a file that does
  nothing else." Nothing in this block adds it; `create_music_request`
  writes `'MANUAL'` unconditionally and takes no channel parameter, on the
  plan's own second amendment (§3.2 of this plan document — a channel
  parameter here "looks like it decides something while deciding nothing,"
  since a hand-typed request cannot honestly be `IMPORT` and never needs to
  claim `WHATSAPP` before that block exists).
- **The listener merge ruled for on 2026-08-01 is still unbuilt.** The
  design spec records explicitly that it should reuse this block's core
  (D3) — `apply_music_merge`'s locking-order, atomicity and
  permission-before-existence shape — when it is built. Nothing in this
  block builds it; it is recorded here only so the next block that does
  inherits the pointer.
- **The Music dashboard (Block 8) reads none of this yet.** `music_requests`
  and `music_merges` both now hold real data by the end of this block, but
  no aggregate query, chart or period filter exists anywhere in this
  codebase that reads either table.
- **No "show archived" filter exists on Requests or Maintenance**, the same
  limit 7a's report records for the catalogue screens: 0099's `select`
  policies filter `deleted_at is null` inside the policy itself, so a
  withdrawn request or an absorbed loser is not merely hidden from a list —
  it is unreadable through ordinary RLS for any caller, including the
  merge's own history. `list_music_requests` and `list_merge_candidates`
  read past this only because both are `SECURITY DEFINER` bodies applying
  their own filters, and neither offers an "include archived" toggle.
- **A cross-kind deadlock between overlapping merges is possible and
  survivable, but not prevented.** An `ARTIST` merge and a `GENRE` merge
  whose `songs` sets overlap can deadlock on their bulk `update`s; Postgres
  detects it and aborts one transaction whole, so nothing is ever
  half-merged, but the migration's own deadlock-freedom claim is scoped to
  the winner/loser lock only, not to this cross-kind case. Deferred by the
  coordinator during Task 2's fix round as a residual, not fixed.

---

## 10. Deferred minors

Collected from the execution ledger, listed for the final review and the
owner to triage — none blocking, none load-bearing.

**Task 2 (the merge core and doors):**
- A `NULL` element inside `p_loser_ids` is silently dropped rather than
  refused with `22023`, in a function whose own stated creed is "half a
  merge is worse than none."

**Task 3 (the request doors):**
- The `P0002` messages let a `music.request` holder without `members.view`
  confirm a guessed listener uuid exists, at their own Station, by which
  error comes back.
- The keyset paging on `list_music_requests` cannot use
  `music_requests_company_requested_idx`: the `ORDER BY` is over `CASE`
  expressions with no id tiebreak in the index, so every page sorts the
  whole filtered set. House-wide — `0090` has the identical shape.
- The `channel` and `show` filters, and the cursor in either paging
  direction, are untested in `17_music_requests.test.sql`.

**Task 4 (`list_merge_candidates`):**
- The `ilike` search does not escape `%`/`_`, so an operator typing either
  literal gets a wildcard instead. Identical in `0090`, `0095` and `0107`;
  `escapeLikePattern` (`src/lib/postgrest.ts`) has no plpgsql equivalent.
- `p_limit` is not clamped. Same as `0090`/`0095`/`0096`/`0107`.

**Task 6 (the schemas):**
- The mirror test (`memberId: ''` + `fullName: ''` → throws) does not by
  itself discriminate a correct schema composition from a broken one — both
  throw, for different reasons. The primary test alongside it does prove
  the composition.
- No test exercises a non-UUID string `songId`, only its omission.

**Task 8 (the Requests screen):**
- The disabled `q` filter still renders an applied-looking search term to an
  operator without `members.view`, rather than hiding the box entirely.
- `CHANNEL_LABELS` is duplicated verbatim across two components rather than
  shared.

**Task 9 (the Maintenance screen):**
- The debounced search fires one keystroke behind, because `navigate`
  closes over the render-scoped search value rather than the event's own
  value — copied verbatim from `songs-filters.tsx`, a house-wide
  pre-existing defect across all four filter components in this codebase,
  not introduced by this task.

**Task 10 (the round trip):**
- `Date.now()` gives millisecond-resolution stamps, so two e2e runs
  launched in the same millisecond could in principle collide on a seeded
  identity. Pre-existing pattern shared with `music-catalogue.spec.ts`, not
  introduced here.

**Cross-task:**
- pgTAP assertion 24 in `14_music_catalogue` (`isnt music.merge`) overlaps
  assertion 23 — a 7a-era note, unrelated to this block, restated here only
  because §6 of this report discusses the same permission by name and a
  reader might otherwise look for it in the wrong file.

---

## 11. Not done

**The PR is not open.** The owner decides when it opens, per house
convention carried from every earlier block.

**Nothing beyond this plan's own scope was started.** Per the design spec's
§7/§8: the Music dashboard is Block 8's, the legacy ETL is Block 9's (with
§4 above the specific note it inherits), the WhatsApp music-request channel
is its own future block, and the listener merge ruled for on 2026-08-01
remains unbuilt, recorded only as a pointer at what it should reuse.

---

## 12. Final whole-branch review, before merge

Seven findings surfaced in the review that followed Task 11. None is a live
defect in the sense §8 above uses the word — each is a test that would not
catch a regression, a comment claiming more than it proves, or a document
that would mislead the next reader. Four are corrected without changing
anything else this report claims: the Requests grid's title for a null
listener name now reads on `canFindListeners` rather than always blaming a
missing permission (a caller who holds `members.view` and is looking at a
listener who has since exercised LGPD erasure was being told they lacked a
permission they hold); the plan document's `list_merge_candidates` gate is
corrected from `music.merge` to `music.view` in the three places it still
disagreed with §6 above; `merge-panel.tsx`'s own comment now says it is keyed
on `` `${state.companyId}:${state.kind}` ``, matching `page.tsx` (§8's defect
5) instead of restating the pre-fix `kind`-alone claim; and
`requestFormSchema.fullName`'s bound was raised from 160 to 200 to match its
form's own `maxLength` and the pattern `participationFormSchema.fullName`
already sets — a name between 161 and 200 characters previously passed the
browser and was refused only at the RPC.

Three findings change what this report states above:

- **Coverage.** Assertion 30 in `16_music_merge.test.sql` proved only
  `merge_songs` refuses a `music.view`-only caller with `42501`; the
  identical `has_permission('music.merge', …)` clause in `merge_artists`,
  `merge_record_labels`, `merge_music_genres` and `merge_shows` had no
  assertion of its own anywhere in this suite — deleting any of those four
  clauses today would have left every gate in this repository green, on the
  one operation in this domain that destroys data. Four `throws_ok`
  assertions were added (37–40), reusing the `e2a4` actor fixture and adding
  one live fixture row apiece for `record_labels`/`music_genres`/`shows`,
  which this file had none of before. The plan count in §2 above (40, was
  36) reflects this.
- **The atomicity claim.** Assertion 14 was commented `THE ATOMICITY PROOF`
  and named two losers, the second bogus. `apply_music_merge` in fact raises
  `P0002` from its pre-flight lock-and-count check, before the repoint loop
  ever runs — so no work was ever applied, and assertions 15–16 (nothing
  moved, the loser still alive) pass identically against a hypothetical
  non-transactional implementation. The comment is reworded to state what
  the test actually proves — the pre-flight refusal is whole and prior to
  any write — without weakening the assertions themselves, which are correct
  and simply were misnamed. Atomicity itself remains structurally true (a
  `plpgsql` function body is one transaction, the same fact §7 above rests
  its mutation proof on); no genuine post-repoint failure case was added,
  since forcing one cheaply would need an artificial fault injected after
  the loop starts, which none of the five kinds currently offers.
- **A matching gap in the isolation suite.** `tests/isolation/music-merge.test.ts`
  proved `member_phone` comes back null for a caller without `members.view`,
  never that it comes back populated for one who holds it — the same class
  of gap as the coverage finding above, on `list_music_requests` rather than
  the merge doors. The existing "merges, and the requests really move" case
  already runs as the tenant owner (who holds `members.view` through
  `has_permission`'s owner bypass, 0024) and seeds its own request with a
  real phone number; it now also asserts the returned row's `member_phone`
  is truthy. Case count is unchanged at 11 — this is a new assertion inside
  an existing case, not a new case, so `scripts/verify-isolation-suite.mjs`'s
  `minTests: 11` floor did not move.
