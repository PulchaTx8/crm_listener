# Block 4c — Participations, import, and the per-person ceiling — Verification Report

Branch `block-4c`, cut from `block-4b`'s head at **`5adf2c2`** ("fix(isolation):
the guard was blind to skipped tests, and had no floor") while PR #16 was still
open, so it carries 4b's commits until that merges. `a7927b3`, which an earlier
version of this line named as the branch point, is 4c's own plan commit — the
fourth commit of this block's work, not its base. Block 4 was split into three
passes with the owner; this is the third and last. Spec in
`docs/superpowers/specs/2026-07-30-block-4c-participations-design.md`, plan in
`docs/superpowers/plans/2026-07-30-block-4c-participations.md`, execution ledger
in `.superpowers/sdd/2026-07-30-block-4c-participations/progress.md`.

**What the block set out to do, and did.** Three promises written into shipped
code came due here. 4a's D9 — a promotion's quiz, hashtag and start date freeze
once somebody has entered — had been carried as a comment in `0042` and `0043`
saying the guard was deliberately absent because it would have had to consult a
table that did not exist. The v1 design's N3 — the repetition rules checked
transactionally under a lock on `(promotion, member)` and reinforced by a
constraint — had no implementation. And "limit per person" was a rule with no
column. All three now exist, with the table that makes them decidable.

Five migrations (`0052`–`0056`), two tables, one column, two enums, one partial
unique index, four new RPCs, four of 4a's recreated (two of them dropped and
recreated, because their argument lists changed and `create or replace` cannot
do that), a service layer, one new screen, two writing surfaces and a fifth tab.

**26 commits, 45 files, +12,973 / −10** over `5adf2c2..d773f4d`, which is the
ten reviewed tasks. Recomputed with `git rev-list --count`, `git diff
--shortstat` and `git diff --name-only`; the figures previously here — 22
commits, 43 files, +9,842 — were measured against the wrong base and are
corrected rather than left, because this document is what the pull request
carries. The whole-branch review's fix wave adds commits after `d773f4d`; §10
below records what it changed.

---

## 1. Gates

Every gate at its real defaults, on the final tree, after all four mutations
were reverted and the tree proved clean. Two columns: the ten reviewed tasks as
they stood at `d773f4d`, and the same gates after the whole-branch review's fix
wave (§10), which is what the pull request carries.

| Gate | At `d773f4d` | After the fix wave |
| --- | --- | --- |
| `npm run lint` | No ESLint warnings or errors | No ESLint warnings or errors |
| `npm run typecheck` | clean | clean |
| `npm test` | **321 passed**, 23 files | **326 passed**, 23 files |
| `npm run db:test` | **391 PASS**, 6 files (`05` = 31) | **392 PASS**, 6 files (`05` = 32) |
| `npm run test:isolation` | **175 passed**, 14 files, nothing skipped | **182 passed**, 14 files, nothing skipped, each file above its own case floor |
| `npm run test:e2e` (`--workers=1`) | **18 passed** | **20 passed** |

What this block added to those totals: `supabase/tests/05_participations.test.sql`
(32 pgTAP assertions, new); 29 isolation cases in
`tests/isolation/participations.test.ts` (new); six e2e journeys in
`tests/e2e/participations-flow.spec.ts` (new); and unit files for the CSV reader
(`tests/unit/participation-import.test.ts`, 35) and the navigation guard
(`tests/unit/participations-filters.test.ts`, 15).

### 1.1 The isolation flake, and why no rate is quoted

The `Worker exited unexpectedly` crash that Block 4b documented is still open and
still uncaused. `scripts/verify-isolation-suite.mjs` catches it and refuses to
call the run green, which is what it exists for.

This task ran the full suite **seven** times. Two completed; five were caught by
the guard. Two distinct shapes appeared:

- four runs reported `Test Files 13 passed (14)` with `Tests 175 passed (175)` —
  every test ran and passed, and a worker then died before its file was
  reported;
- one run reported `Tests 167 passed (175)` — a worker died mid-file, so eight
  assertions genuinely did not run.

**The rate is not stable and this report deliberately does not quote one.** Block
4b's report documents 2 in 5. Task 5 of this block saw 3 of 4. This task saw 5
of 7. Three small samples spanning 2/5 to 5/7 support "it fires often enough to
need re-running, and often enough that a green run must be the one you read" and
they support nothing more precise. Anyone tempted to derive a figure should
re-measure rather than average these.

### 1.2 Two environment traps that cost real diagnosis time

**Never run `npm run build` while a `next dev` server is up.** The build clobbers
that server's `.next`; the page then renders and never hydrates, and every filter,
button and dialog silently does nothing while the terminal shows no error at
all. Found in Task 7.

**Clear `public.rate_limit_counters` before a full local `npm run test:e2e`**, and
run Playwright with `--workers=1`. The counters survive between runs and the sign-in
journeys start failing on the limiter rather than on anything they test.

---

## 2. What shipped

**`0052_participations.sql`** — `participation_status` (`VALID`, `DUPLICATE`,
`TOO_SOON`, `OVER_LIMIT`) and `participation_source` (`MANUAL`, `IMPORT`);
`promotions.max_entries_per_member` with `promotions_entry_ceiling_shape`;
`participations` and `participation_answers`; the partial unique index
`participations_one_per_member` (`0052:113-115`).

Three of that table's constraints are the design doing work rather than
decoration. `participations_member_link_fk` (`0052:90-92`) points at
`member_company_links`, which is keyed on exactly `(member_id, company_id)`, so
one constraint proves the listener exists *and* that this Station has them; a key
to `members (id, organization_id)` would have proved only the Organization, and
an Organization with two Stations could then name somebody this Station had never
heard of. `participations_allows_multiple_fk` (`0052:98-101`) denormalises the
promotion's repeat flag with `on update cascade`, which is what lets the partial
index exist at all — an index on `participations` cannot see `promotions` — and
what makes turning repeats off on a promotion where one listener already holds
two valid entries refuse the whole update instead of leaving a promotion whose
stated rule its own data breaks.

**`0053_rls_participations.sql`** — `revoke all` from `anon` and `authenticated`,
`select` only, both `select` policies gated on `participations.view`
(`0053:25`, `0053:34`), and `truncate` revoked from `service_role` (`0053:15-16`)
at the same time as the grant rather than after somebody notices.

**`0054_participation_rpcs.sql`** — `resolve_or_create_member`,
`apply_participation`, `record_participation`, `import_participations`.

**`0055_promotion_freeze.sql`** — 4a's D9, across all three of its surfaces, plus
D1's ceiling reaching both promotion doors. `promotion_write_error` recreated
with a fourth defaulted argument so the constraint name can be consulted before
the sqlstate.

**`0056_import_skips_unlinked_listener.sql`** — a listener registered only at a
sister Station is skipped and reported rather than killing the file.

**Service layer** — `src/services/participations.ts`: `listParticipationsPage`
(:177), `countPromotionParticipations` (:323), `searchStationListeners` (:392),
`resolveOrCreateMember` (:490), `recordParticipation` (:558),
`importParticipations` (:672).

**Screens** — `/participations` (`src/app/(app)/participations/page.tsx`), keyset
paginated in Block 3b's shape, defaulting to `VALID` with the filter visible so
nobody concludes the refused ones were lost; the promotion record's fifth tab
(`src/app/(app)/promotions/participations-tab.tsx`); the manual entry form
(`src/app/(app)/participations/record-participation-form.tsx`); and the CSV
import (`src/app/(app)/participations/import-form.tsx`).

### 2.1 Three things the plan did not contain and the executing agents found

Recorded because each was a real gap rather than a preference, and each is the
sort of thing that would otherwise be invisible to a reader of the diff.

**The permission gate could not be delegated (Task 4).** The plan had
`import_participations` call `record_participation` per row.
`record_participation` is gated on `participations.create` and the import holds
`participations.import`, so every file would have died on row 1. The first fix
made the shared function pick its permission code from `p_source` — which works,
and lets a caller-supplied label choose which permission it faces. `0027:3-5` had
already settled that question for this codebase: the check stays out of the
shared helper and beside each operation. Resolved that way —
`apply_participation` is `SECURITY INVOKER` with `EXECUTE` granted to nobody
(`0054:252`), called from two `SECURITY DEFINER` doors that each check their own
code. `tests/isolation/participations.test.ts:531` is the detector for the
rejected design: the same delegate calls the manual door with `MANUAL` and with
`IMPORT` and must get the same refusal.

**The ceiling had no way onto the screen (Task 5).** D1 promised a per-person
ceiling as a field on the Promotion tab. The plan added the RPC argument and
nothing in the schema, the service or the form ever carried it — and
`update_promotion` replaces every field on every call, so the first UI edit would
have nulled any ceiling that existed. It was not damaging yet only because
nothing could set one. Closed by giving the argument to both doors (`0055:399`,
`0055:176`), the schema (`src/schemas/promotions.ts:89`), the shared RPC builder
(`src/services/promotions.ts:561`) and the form
(`src/app/(app)/promotions/promotion-fields.tsx:168`). **Mutation 4 below is
aimed at exactly this, and it survived** — see §4.4.

**D9 has three surfaces and the plan guarded two (Task 5).** 4a's D9 freezes the
questions, *their options*, the hashtag and the start date.
`save_promotion_question`'s replace branch was left open, so after somebody
entered, an operator could still move `is_correct` onto another option under
existing `participation_answers` rows — while `0052:171-172`, written by this
branch, asserted that exact freeze and staked Block 6's draw-time correctness on
it. The guard is now at `0055:575-580`, on the replace branch only; appending a
new question stays open, which is D9's own wording.

### 2.2 The search guard, and a defect that only a measurement found

`/participations` copied its debounced search from `promotions-filters.tsx`, and
copied a defect with it (§6.1). Task 7 fixed it in its own file with a ref and an
address comparison. Task 9 then measured the result and found the fix was a level
too shallow: the guard cancelled the pending debounce from an effect keyed on a
prop from the **server** render, so the cancel could not happen until the
destination render committed — an RSC round trip. Timed from the click on this
stack: a Station chip commits at 320–351 ms in production and 399–420 ms in dev; a
page turn at 484–527 ms. Against a 350 ms debounce that is chip 5/6 held in
production, 0/6 in dev, and **page turn 0/6 in production** — not a race on this
machine but a straight defect, in which the operator loses the page turn, lands
back on page 1, and gets the search they had abandoned.

The guard now cancels on a capture-phase `document` `click` plus `popstate` — at
the *start* of a navigation rather than at its commit — narrowed by
`startsAnotherNavigation` (`src/app/(app)/participations/participations-filters.tsx`,
15 unit tests). Re-measured on the same six-run production rig: chip 6/6, page
turn 6/6, browser Back 6/6.

Two disciplines from that task are worth carrying: the implementer refused to
commit a 5/6 spec (a flaky test teaches re-running), and it wrote a fifth
assertion, could not falsify it — this promotion's render is ~800 ms, so the
first navigation is superseded before the mutation can bite — and **removed it
rather than ship it green and unfalsifiable.**

---

## 3. Two corrections to the record

### 3.1 `require_correct_answer` is a draw rule, not an entry rule — and had been read wrong since 4a

This one is a correction to a decision, not to code, so it is worth being exact
about where the evidence is: it is in the two design documents, not in the
execution ledger, because it was settled with the owner before Task 1 began
rather than discovered during execution.

**What 4a said.** `docs/superpowers/specs/2026-07-29-block-4a-promotions-design.md:80-83`,
D4: *"Whether a wrong answer **disqualifies** is per promotion. Tab 1 gains
'Exigir acerto para concorrer'. The participation records the answer **and
whether it was right** either way; what changes is whether Block 6's draw may see
that participant."* `0040:59` shipped the column and nothing has ever read it.

**What 4c settled**
(`docs/superpowers/specs/2026-07-30-block-4c-participations-design.md:45-61`, D2
and D3), and it corrects that sentence in two places:

1. **Nobody is refused for answering wrongly.** Everyone who participates is
   recorded. The flag is read at the draw (Block 6), where it decides who is in
   the pool: everyone, or only those who answered correctly. Correctness is
   therefore never a participation status.
2. **Correctness is derived, not stored.** 4a's D4 had the participation record
   "whether it was right". 4c stores one row per answered question naming the
   option chosen, and Block 6 works out who was right by joining
   `promotion_question_options.is_correct` (`0041:59`) at draw time. A
   denormalised "answered correctly" would be a second place telling the same
   truth, which is what the whole of 4b was spent reconciling.

**Where the correction is visible in shipped code**, so that a reader can check
it rather than take this paragraph's word:

- `participation_status` has four values and none of them is about correctness,
  and its type comment says so out loud (`0052:13-14`): *"Never says whether the
  quiz was answered correctly — that is a draw-time question (Block 6) read off
  the answers, and a wrong answer refuses nobody."*
- `participations` (`0052:53-102`) carries no correctness column.
- `apply_participation` (`0054:94-247`) contains no reference to `is_correct` at
  all — `grep -c is_correct supabase/migrations/0054_participation_rpcs.sql`
  returns 0 — and stores the answers whatever the status (`0054:206-236`),
  because what somebody said is a fact about the attempt and whether it counted
  is a different fact.
- 4a's D9 freeze is what makes deriving it safe: an option cannot be reworded
  after somebody chose it, so the join means the same thing tomorrow as it did at
  entry. That is why §2.1's third finding mattered.

**The first consumer the column has ever had also arrived in this block, and it
is consistent with D2 rather than with D4**: `import-form.tsx:528` *warns* before
writing that imported rows carry no answers and will be outside the draw. It
warns; it does not refuse.

### 3.2 The spec withdrew one of its own open items, because Block 3 had already settled it

`docs/superpowers/specs/2026-07-30-block-4c-participations-design.md:359-367`
carries a struck-through open item: *"What the import does about a row matching
two different people."* This spec had proposed skipping such a row as unreadable.
That would have been a second answer to a settled question.

`find_member_by_identifier` (`0033`) already handles the split-identifier case:
it collects every candidate any supplied identifier matches and picks
deterministically — the reachable one first, then the lowest id — and the
function's own comment records that resolving per-identifier, so the caller could
learn which field collided, was **deliberately rejected by the owner**. 4c
follows rather than re-decides. `resolve_or_create_member` (`0054:20-64`) is a
thin pass-through onto that function precisely so there is no second rule to keep
in step: it maps `visible` → `resolved`, `none` → register and proceed, and
`elsewhere` → no id, which the import reports as a skipped row (the one skip
reason that is not a defect in the file).

The other two items in §9 remain open and are listed in §7.

---

## 4. The mutation log

Four mutations. Each was reverted with `git checkout --` before the next was
applied, and `git status --porcelain` was read between them; the only entry it
ever showed is the untracked `Arte/` directory, which predates this task and is
not this block's. `git diff --stat HEAD` was empty at every boundary.

Mutations 2 and 3 were applied by editing the migration and running
`npm run db:reset`, which is the honest way to re-apply a migration and which
guarantees the database and the file agree. Mutation 1 was applied by editing the
migration and re-running the changed function through `psql` — `0054` is entirely
`create or replace` / `revoke` / `grant` / `comment`, so it re-applies cleanly —
followed by re-running `0056`, which replaces `import_participations` a second
time; the mutation was then confirmed against the live catalogue rather than
assumed.

### 4.1 Remove the advisory lock — RED, 9 runs of 9

`supabase/migrations/0054_participation_rpcs.sql:172-173`, deleted:

```sql
perform pg_advisory_xact_lock(
  hashtextextended(p_promotion_id::text || ':' || p_member_id::text, 0));
```

Confirmed live before running anything:
`select position('pg_advisory_xact_lock' in prosrc) from pg_proc where proname = 'apply_participation'`
returned `0`.

**Run it repeatedly, and here is why.** Task 3 measured this: with a *single*
race round the case catches a missing lock about one time in three — 7 red in 21
runs — and misses it two times in three. It is not that the two calls fail to
overlap; a probe with the lock removed and a `pg_sleep(2)` between the decision
and the insert failed every time and took one sleep's worth of wall time for two
calls, so they demonstrably do. The window a missing lock leaves open is
sub-millisecond, and two HTTP requests do not reliably interleave that finely. A
single green run against a removed lock would therefore have been enough to put
"the lock is unnecessary" into this document, and it would have been false.

The committed case answers that with `RACE_ROUNDS = 12`
(`tests/isolation/participations.test.ts:584`) — twelve races against twelve
fresh `(promotion, member)` pairs *inside* the one test, chosen because
`(2/3)^12 = 0.0077` is the first integer clearing 99 % (11 gives 98.8 %). The
number is derived from the measurement, never the other way round.

**Result: red on all nine runs**, which is nine runs of a twelve-round case —
108 independent rounds. Every one failed the same way:

```
AssertionError: expected { code: '23505', …(3) } to be null
  code:    "23505"
  message: duplicate key value violates unique constraint "participations_one_per_member"
  details: Key (promotion_id, member_id)=(…) already exists.
  at tests/isolation/participations.test.ts:638  →  expect(second.error).toBeNull()
```

**How it goes red is the finding.** It is not "two rows both said VALID". One of
the two calls raised `23505` from the partial unique index instead of returning
`DUPLICATE`. That is the index catching the loser the lock would have queued, and
it is the evidence that the two guards hold the same floor by different means —
the index is the second line of defence and it held. What the lock buys on top of
it is that the loser is **recorded as a duplicate rather than lost**: without it,
one of the two entrants gets a constraint error instead of a row saying what
happened to them, which is the fact Block 5 will have no choice about keeping.

That is also why the assertion is written on the two statuses
(`['DUPLICATE', 'VALID']`) rather than on a row count. A count of one is
satisfied by the index alone, so a count-based case would test the index and sign
off on the lock's absence.

### 4.2 Remove the participation check from `update_promotion` — RED, and precisely one case

`supabase/migrations/0055_promotion_freeze.sql:271-283`, the whole freeze block
replaced with `v_frozen := false;`. Applied with `npm run db:reset`.

```
× Block 4a's freeze… > locks the hashtag and the start date once somebody has
  entered, and leaves the rest open
  → expected undefined to be '22023'
  at tests/isolation/participations.test.ts:980
```

Line 980 is the **hashtag** edit, which is what the plan predicted.

Its three neighbours in the same `describe` stayed green:

```
✓ refuses to remove a question once somebody has entered
✓ freezes a question's wording once somebody has entered, and still lets a new one be added
✓ refuses to turn repeat entries off while one listener holds two, and names that rather than the site code
```

That precision is the useful half of the result. D9's three surfaces are three
independent guards — `update_promotion` (`0055:271-283`),
`remove_promotion_question` (`0055:719`) and `save_promotion_question`'s replace
branch (`0055:575-580`) — plus the index cascade behind the fourth case. Removing
one does not take the others' proof down with it, so each is really being
checked rather than one of them standing in for all four.

### 4.3 Drop `status = 'VALID'` from the index predicate — RED, 1 of 391

`supabase/migrations/0052_participations.sql:113-115`:

```sql
-- before
where status = 'VALID' and not allows_multiple;
-- mutated
where not allows_multiple;
```

`npm run db:reset`, then `npm run db:test`:

```
/supabase/tests/05_participations.test.sql ....
# Failed test 16: "a DUPLICATE may sit beside the VALID one it was refused for"
#     died: 23505: duplicate key value violates unique constraint "participations_one_per_member"
#         DETAIL: Key (promotion_id, member_id)=(…4e1, …4d1) already exists.
# Looks like you failed 1 test of 31
Result: FAIL
```

Exactly one of 391 assertions red. Its immediate neighbour, test 15 —
`a second VALID entry is refused where the promotion forbids repeats` — stayed
green, along with the other 389. The pair is the point: the index has to refuse a
second *valid* entry and still let a *refused* one sit beside it, because D5's
whole design is that a refusal is written down rather than thrown away. One
predicate carries both obligations, and the two cases pin the two halves
separately.

### 4.4 Mutation 4, self-chosen: remove the ceiling from the shared RPC builder — **SURVIVED**

`src/services/promotions.ts:561`, deleted:

```ts
p_max_entries_per_member: input.maxEntriesPerMember,
```

**Why this one.** The brief asked for something this block claims and nothing yet
proves. The strongest candidate was the block's own most conspicuous
self-correction. Task 5's implementer found that D1's per-person ceiling — the
headline feature of this pass — had an RPC argument and no path to it: not in the
schema, not in the service, not in the form. Task 6 closed it by giving the
argument to both promotion doors and sending it from the one shared builder. The
question this mutation asks is not "is it closed" but "would anybody notice it
re-opening", and that question had never been put. Three greps said it had not:
no e2e names the field, no isolation case sets a ceiling through the service, and
the only live proof of the ceiling anywhere
(`tests/isolation/participations.test.ts:184`, the `OVER_LIMIT` case) sets it by
calling `update_promotion` **directly** with `p_max_entries_per_member: 2`,
bypassing the service entirely.

**Result: the mutant survived every gate.**

| Gate | Under mutation 4 |
| --- | --- |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm test` | 321 passed |
| `npm run db:test` | 391 PASS |
| `npm run test:isolation` | 175 passed, 14 files |
| `npm run test:e2e` | 18 passed |

Two of those deserve a sentence each, because "it passed" understates them.
`typecheck` is clean because `p_max_entries_per_member` is optional in
`database.types.ts:1750` and `:2086` — an omitted optional key is not a type
error, so TypeScript is structurally unable to see this. And
`tests/isolation/promotions.test.ts` drives `createPromotion` and
`updatePromotion` through this very builder, twenty cases of it, and every one
passes with the ceiling gone, because not one of them ever sets a ceiling.
pgTAP's 391 are blind by construction: they run SQL and never load the service.

**What the surviving mutant would do in production.** `update_promotion` assigns
`max_entries_per_member = p_max_entries_per_member` with no `coalesce`
(`0055:299`), and `promotionRpcArgs`'s own comment records that an absent key is
omitted by PostgREST so the function's `default null` applies. So with that one
line gone: a ceiling typed into the form appears to save and is silently written
null, **and** — worse, because it needs no one to be looking — an edit to any
other field on a promotion that already has a ceiling removes it. That is
precisely the defect Task 5 found and Task 6 closed, and nothing in this
repository would notice it coming back.

**Not fixed by Task 10, deliberately.** Task 10's remit is mutation and this
report; it adds no features and no assertions, and inventing one at the end of a
block is how a task's scope becomes unreviewable. The closure was written out
here instead:

> In `tests/isolation/promotions.test.ts`, create a promotion through
> `createPromotion` with `allowMultipleEntries: true` and
> `maxEntriesPerMember: 3`, read it back through `getPromotionRecord`, and assert
> `maxEntriesPerMember === 3`; then `updatePromotion` changing only the name and
> assert it is still 3. Two assertions. The second is the one that matters — it
> is the wholesale replace, and it is the half that would have shipped broken.

**CLOSED in the fix wave**, as written above: `tests/isolation/promotions.test.ts`
now carries *"carries the per-person ceiling to both doors, and an unrelated edit
does not remove it"*. Re-run against the mutation, deleting the same line, the
case goes red — `expected null to be 3`. The surviving mutant survives no
longer.

### 4.5 Revert proof

After each mutation the file was restored with `git checkout -- <path>` and the
tree read:

| After | `git status --porcelain` | `git diff --stat HEAD` | Re-verified |
| --- | --- | --- | --- |
| Mutation 1 | `?? Arte/` only | empty | `pg_proc` reports `LOCK PRESENT` |
| Mutation 2 | `?? Arte/` only | empty | all four freeze cases green |
| Mutation 3 | `?? Arte/` only | empty | `db:test` 391 PASS |
| Mutation 4 | `?? Arte/` only | empty | full gate suite, §1 |

`Arte/` is untracked, predates this task and is not this block's work. The final
`npm run db:reset` was followed by re-running the owner's account seeding script,
so `admin@pulchatx.test` and `dono@pulchatx.test` (password `PulchaTx-4b-2026`)
sign in again against the local stack.

---

## 5. What Block 5 inherits

Block 5 is the WhatsApp bot. This block was built so that it adds a source, not a
column and a second write path.

- **`participation_source` needs one value added** — `0052:19`. Its comment
  already names `WHATSAPP` as Block 5's.
- **`apply_participation` (`0054:94`) is the body a third door calls.** It is
  `SECURITY INVOKER`, holds `EXECUTE` for nobody (`0054:252`), and takes the
  source as a note of how the row arrived. The gate does **not** live in it, on
  purpose (`0054:80-92`): a webhook door adds its own permission check beside its
  own operation, the way `record_participation` (`0054:288`) and
  `import_participations` do. Do not move the check inside; `0027:3-5` settled
  that and `tests/isolation/participations.test.ts:531` will go red if it is
  reinstated.
- **A refused attempt is already a row, not an error** — `0052:104-105`. A
  message arrived and what happened to it is on the record. `DUPLICATE`,
  `TOO_SOON` and `OVER_LIMIT` are statuses, not refusals (`0054:175-196`); a
  cancelled promotion, one outside its window, an unlinked listener and an answer
  from another promotion **are** refusals.
- **N3's lock is already taken over `(promotion, member)`** — `0054:172`. It is
  an advisory transaction lock rather than a row lock precisely because Block 5's
  load is what makes the alternatives wrong: `FOR UPDATE` on the promotion would
  serialise every entry against every other, and locking the participation rows
  for a pair locks nothing the first time somebody enters.
- **The audit action name is `record_participation` for imported rows too**
  (`0054:241`); `detail.source` is what distinguishes them. Block 5 may want that
  renamed rather than parsed — see §6.2.
- **First job:** the ceiling assertion in §4.4.

## 6. What Block 6 inherits

Block 6 is the draw.

- **`require_correct_answer` (`0040:59`) is read here and nowhere else.** §3.1 is
  the whole context. It decides who is in the pool, not who was allowed to enter.
- **Filter on `status = 'VALID'`** (`0052:9-11`). The four statuses are complete
  for "how often did this person enter"; anything not on that list was refused
  and has no row.
- **Correctness is a join, not a column.** `participation_answers` (`0052:131`)
  carries `option_id` (:138) and `answer_text` (:139) with a shape check that an
  essay has text and no option and a quiz or poll an option and no text
  (`0052:160-165`). Join `promotion_question_options.is_correct` (`0041:59`).
- **The join is safe because of the freeze, and the freeze is only as good as
  `0055:575-580`.** Once any participation exists, `save_promotion_question`'s
  replace branch refuses, so an option cannot be reworded — or have `is_correct`
  moved onto it — under an answer already given. `0052:171-172` states that
  guarantee in a table comment; that guard is what makes the comment true. If a
  future block relaxes it, the draw becomes wrong retroactively and silently.
- **`remove_promotion_question` (`0055:719`) refuses once any participation
  exists**, including refused ones, so no question the audience was shown can
  vanish from under the draw.
- **Withdrawing a participation does not exist** and was excluded deliberately
  (spec §8). There is no delete and no soft delete. If an operator enters the
  wrong listener, the consequence shows at the draw, and the fix belongs with
  whatever decides that.

## 7. Open, and deliberately not done

- **Whether `participations.*` should be its own module** (spec §9), or three
  more `promotions.*` codes. The owner's call at review, exactly as with 4a's
  five and 4b's one. Shipped as its own module —
  `participations.view`, `participations.create`, `participations.import` — with
  `members.create` and `members.view` additionally required for import (D10).
- **The audience screen still cannot answer "which promotions has this listener
  entered"** (spec §9). A fair question, and not this block's.
- **No bot, no draw, no withdrawal** (spec §8).

---

## 8. Pre-existing defects found on this branch and NOT fixed here

These are live on screens outside this block. Each was found while building 4c,
each is out of this block's scope, and each is recorded here so that the decision
to fix or defer is the owner's rather than an omission. Block 4b hit the same
shape twice (`parseRecordParam`, the `close()` race) and the owner chose to fix
that class immediately both times.

### 8.1 The debounced search on two shipped screens navigates one keystroke behind

`src/app/(app)/promotions/promotions-filters.tsx:39-50` and
`src/app/(app)/members/members-filters.tsx:33-73`.

The debounced callback closes over the `search` value from the render in which
the timer was scheduled, not the one current when it fires. Typing sends the
previous keystroke's term; **from a single input event it never searches at
all**, because the closed-over value is still the empty string. No e2e drives a
search input on either screen, so nothing catches it.

`members-filters.tsx` carries a worse version of the same defect on its age
filters (`:111-116` and `:127-132`, with `parseAgeInput` at `:238`): typing
`25` navigates with `ageMin = 2`. An operator asking for listeners aged 25 and
over is shown listeners aged 2 and over, and the screen looks like it worked.

### 8.2 Neither of those screens has any navigation-cancel guard

Task 9 established (§2.2) that a pending debounce beats a navigation that starts
inside its window, and that on this stack a **page turn loses 0 of 6 times in a
production build**. `/participations` now cancels on a capture-phase click and on
`popstate`. `promotions-filters.tsx` and `members-filters.tsx` have no guard at
all. `participations-filters.tsx` is the worked example for whoever takes this;
`startsAnotherNavigation` is exported and unit-tested precisely so it can be
reused rather than re-derived.

### 8.3 `save_promotion_question` deleted options with no tenancy filter at all — **fixed in the fix wave**

**This section was wrong as first written, and the correction matters more than
the original claim.** It said a question id from another promotion "loses real
option rows before the refusal fires". It does not. `save_promotion_question`
has no enclosing `EXCEPTION` block, so the `raise` that follows the failed
`update` aborts the transaction and the `DELETE` rolls back with it. Nothing was
ever destroyed, and the report should not have said it was.

The real defect was latent and worse-shaped. The delete read

```sql
delete from public.promotion_question_options where question_id = v_id;
```

— **no tenancy filter of any kind**. `v_id` is a caller-supplied uuid, so a
question belonging to another Station, or another Organization, matched it and
its option rows were deleted. What held that back was not a check but an
accident of control flow: the ownership test lives in the `update` BELOW the
delete, and the rollback undoes both. It becomes a real cross-Station delete the
day anybody wraps this call in a `begin/exception` — which is a thing
`import_participations`' own history in this block says gets tried, twice.

Fixed in the fix wave by joining the delete to its parent, so the statement
carries its own ownership test:

```sql
delete from public.promotion_question_options o
 using public.promotion_questions q
 where o.question_id = q.id and q.id = v_id and q.promotion_id = p_promotion_id;
```

Filtered rather than reordered, and the reason is in the migration: the delete
CANNOT move below the `update`, because
`promotion_question_options_question_fk` cascades `kind` on update (`0041`) and
an option still marked correct would make a QUIZ-to-poll edit fail on
`promotion_question_options_correct_only_on_quiz`. Reordering would therefore
mean hoisting a second ownership read above the delete and leaving the
`update`'s own `if not found` beneath it as a guard that could no longer fire.
The join asks the same question in the same statement, keeps the ordering the
cascade requires, and leaves the `P0002` as the single live refusal for a
mismatched pair. The ordering predates this block (`0043:103-115`); `0055`
recreated the function and carried it forward unchanged.

### 8.4 A hand-edited `?after=` reaches the operator as a 500 — on `/participations` too

`decodeCursor` (`src/lib/keyset.ts:26`) returns null only for a value that is not
base64-encoded JSON. It does not validate the `id` it decodes, so a well-formed
`{"value":null,"id":"abc"}` parses perfectly, reaches Postgres as `id.lt."abc"`,
and comes back `22P02`.

**And `/participations` is not exempt, which this section originally claimed it
was.** `mapParticipationError` routes `22P02` to `ValidationError` and
`describeParticipationsReadError` renders that message VERBATIM, so the screen
shows raw database text rather than starting from the beginning. The two
comments in that directory disagreed about it and `errors.ts:25-29` had it
right; the comment at `src/app/(app)/participations/page.tsx` was corrected in
the fix wave to say what `decodeCursor` actually does and to name this.

The fix itself — validating the id as a uuid inside `decodeCursor` — is
deliberately **not** made. That function is shared by every keyset screen in the
application, so it is one change with four callers and a scope call for the
owner rather than a local workaround on one screen.

---

## 9. Deferred minors, grouped

Everything the execution ledger marked `minor (deferred)`, with file and line, so
that deferring them was a decision and not a loss. Two have already been resolved
by later tasks in the same block and are marked as such.

### 9.1 Coverage the block shipped without

- **The promotion window's closing edge has no case.** `0054:144` refuses
  `v_when < v_starts or v_when >= v_ends`; only the opening edge is exercised
  (`tests/isolation/participations.test.ts:387`). Changing `>=` to `>` would not
  be caught.
- **The repeat-flag drift case is one-directional.**
  `supabase/tests/05_participations.test.sql:140-149` proves a participation
  claiming `allows_multiple = false` against a repeatable promotion is refused;
  the symmetric direction is unexercised. The foreign key is symmetric, so this
  is unexercised coverage rather than a gap.
- **`apply_participation` has no pre-check for
  `participation_answers_option_fk`.** An option belonging to another question
  reaches the caller as a mapped `23503` with a constraint name rather than as
  the sentence the sibling question check produces (`0054:220-230`).
- **The "ceiling on a promotion being registered" unit case exercises the same
  path as its neighbour.** `tests/unit/promotions-schema.test.ts:98`.
  `promotionFormSchema` has no create/update split, so the case is framed in its
  own comment as a tripwire for a future split rather than as a claim about
  today. It is weaker than its name implies.
- **The ceiling never round-trips through the service in any test.** §4.4. This
  is the one on this list that a mutation proved rather than reasoned about, and
  it is the most valuable of them.

### 9.2 Assertions and fixtures that could fail for the wrong reason

- **`PARTICIPATION_PAGE_SIZE` is re-declared as a literal in the e2e spec.**
  `tests/e2e/participations-flow.spec.ts:103` duplicates
  `src/services/participations.ts:52`. If the app's page size grows, the
  26-entry fixture stops spanning two pages and the page-turn journey fails as an
  actionability timeout instead of as "the fixture no longer paginates".
- **A unit test's title undercounts its own cases.**
  `tests/unit/participations-filters.test.ts:99`, titled *"accepts the three
  targets that DO navigate this document"*, iterates four values — the empty
  string plus `_self`, `_top` and `_parent`.

### 9.3 Comments and labels that have drifted from their code

- **`0053:6-8`'s no-write-grant comment omits the closing consequence clause its
  two siblings carry** ("…what makes X the single write path rather than merely
  the intended one"). Brief-mandated verbatim text.
- **`tests/e2e/participations-flow.spec.ts:912` still carries retired,
  machine-specific phrasing** — "0 of 6, where the chip managed 5" — that Task 9
  removed from the component for being a measurement of one machine.
- **`countListRenders` is duplicated across four e2e specs with independently
  drifting comments**: `participations-flow.spec.ts:461`,
  `promotion-prizes.spec.ts:86`, `promotions-flow.spec.ts:71`,
  `record-dialog.spec.ts:87`. Pre-existing; this block added the fourth.
- **RESOLVED — `0052:34` names migration `0054` before it existed.** Landed as
  `0054_participation_rpcs.sql` exactly as the plan said, so the reference is
  correct. Recorded because it was a live risk for three tasks.
- **RESOLVED — Task 7 did not create
  `src/app/(app)/participations/actions.ts`** although the plan's file list named
  it, correctly: that task added no write and a `'use server'` file with no
  exports is worse than its absence. Task 8 created it with the two writes.

### 9.4 Server-layer redundancies, reasoned about and left

- **The promotion's configuration is read outside the lock.** `0054:121-128`
  reads the rules; `0054:172` takes the lock. A concurrent `update_promotion`
  could change the rules between the read and the decision. Narrow, and the
  partial unique index still holds the floor. Reasoned, not measured.
- **The manual path reads the promotion twice.** Once in
  `record_participation` (`0054:280-282`) with a `deleted_at` filter, once inside
  `apply_participation` (`0054:121-128`) without it. Failure ordering is
  preserved; it is one extra primary-key lookup, and the price of the permission
  check sitting beside its own operation.
- **The audit entry says `record_participation` for imported rows too**
  (`0054:241`); `detail.source` distinguishes them. Pre-existing across both
  designs of that function. Block 5 may want it renamed rather than parsed.
- **A mismatched question/promotion pair now answers `22023` rather than
  `P0002`** on a promotion that has participations, because the new freeze
  (`0055:575-580`) runs before the ownership check. No forbidden write either
  way, and the UI cannot produce the combination.

### 9.5 Screen defects

- **The promotion form renders start dates at minute precision**
  (`src/app/(app)/promotions/promotion-fields.tsx:78`, `type="datetime-local"`),
  so a frozen promotion whose `starts_at` carries seconds could not be edited at
  all: the round-tripped value would differ from the stored one and D9's start-date
  freeze would refuse every save. Unreachable today, because anything created
  through the form has `:00`.
- **`SKIP_REASONS` renders an empty string for an unmapped reason.**
  `src/app/(app)/participations/import-form.tsx:639` — `(row.reason &&
  SKIP_REASONS[row.reason]) ?? fallback` yields `''` when `row.reason` is the
  empty string, and `??` does not catch it, so the fallback never runs.
- **The `unreadable` list was discarded when every row is unreadable** —
  **fixed in the fix wave**, and the file named here was wrong: it is
  `src/app/(app)/participations/actions.ts`, in the `rows.length === 0` branch,
  not the report component. That branch returned a bare sentence and threw the
  per-line list away, so a file where EVERY line failed named not one line while
  a file where all but one failed listed every one of them — the worse the file,
  the less the screen said about it. It now returns the same `done` shape with
  all-zero counts and the full `unreadable` list, so the report component the
  operator already knows renders the reasons it already knows how to render.
- **"Participations" and "Entries" are used for the same thing** across the
  fifth tab and the list screen. A label decision, not a bug, and it should be
  made once.
- **The fifth tab's two figures stop being exact above 1,000 rows.**
  `src/services/participations.ts:336` uses `count: 'estimated'`, so above
  `config.toml`'s `max_rows` the tab shows a planner estimate to an operator as a
  tally, with nothing on screen saying so. **Ruled not a defect to fix in this
  block**: D8 demands the fixed cost outright, exactness holds for the ordinary
  case below 1,000, and `:293-298` reasons the tradeoff through and records why
  `'planned'` was rejected. Recorded so the ruling is visible rather than
  implicit. **The architecture stands; the qualification was added in the fix
  wave** — the tab now says the two figures become estimates above about a
  thousand entries and that the list one click away counts exactly, because the
  defect was never the estimate, it was an operator finding two different
  answers to one question with nothing on either screen saying why.

### 9.6 One gap that cannot be recovered from the artifacts

Task 8's review raised **seven** minors for the final triage. The execution
ledger records three of them by name — the `SKIP_REASONS` empty string, the
discarded `unreadable` list, and the label split, all in §9.5 — and the review
itself was not saved to a file. **The other four are not recoverable from
anything in the repository.** They are stated here as missing rather than
silently dropped, and the process lesson is the one the ledger already teaches
elsewhere: a finding that exists only in an agent's output is a finding with a
session-length lifetime.

---

## 10. The whole-branch review's fix wave

One agent, one pass, after the ten tasks were complete and before the pull
request. What follows is the durable half — what changed in shipped code and
what now holds it down. The per-finding record, with commands and output, is in
`.superpowers/sdd/2026-07-30-block-4c-participations/final-fix-report.md`.

### 10.1 The one that was silently wrong

**The minimum interval was a floor, not a window.** `apply_participation` asked
"is there a VALID entry LATER than N hours before this one" and nothing else, so
an entry arbitrarily far in the FUTURE of the row being written fired the
branch. Proved against the running stack at N = 6: an entry at 20:00Z, then one
at 08:00Z the same day — twelve hours EARLIER — came back `TOO_SOON`, while the
control twelve hours later came back `VALID`.

The rule is symmetric (`|existing − this| < N`) and the code was not. It is
silent and it costs somebody a prize: the row is not `VALID`, so Block 6's draw
leaves out a listener who was entitled to be in it, and the import reports N
people as having come back too soon. It is reachable through this block's
headline path — `import_participations` walks a file in row order, D7 exists
because files carry historical timestamps, and a spreadsheet exported
newest-first marked every row after the first `TOO_SOON`.

It survived all six gates because **every interval case in the block walks
forward in time**. The new case walks backwards and asserts a window rather than
a sign flip: an hour earlier is still `TOO_SOON`, twelve hours earlier is
`VALID`.

### 10.2 The import could still be destroyed by one row

`0056` exists because one bad row rolled a three-hundred-row file back, and it
closed **one of the two ways that happens**. `apply_participation` also raises —
`22023` — for a row outside the promotion's window, out of the same loop, with
the same absence of a `begin/exception`, to the same effect. `importRowSchema`
validates only that the instant parses and the form is never given the
promotion's `starts_at`/`ends_at`, so nothing in front of the operator could
warn them.

Closed in `0056`'s own shape: the window is read alongside `company_id` in the
statement already being made, and a row outside it is **skipped before the call**
with a fourth reason, `'outside the promotion window'`. Detected rather than
caught, for `0056`'s own argument — a cancelled promotion raises `22023` too, so
catching per row would report a whole cancelled file as six hundred bad dates.
The check sits BEFORE `resolve_or_create_member`, unlike the link check beside
it, so a line that can never be recorded does not leave a registered listener
behind it.

### 10.3 Read gates that had no denial anywhere

- **`participation_answers` had none at all.** pgTAP asserted a policy exists —
  which `using (true)` satisfies — the fail-closed stranger view covered
  `public.participations` only, and the single live read was by a delegate who
  HOLDS the permission. On the table that stores listeners' free-text answers.
  `05_participations.test.sql` now carries a second stranger view (plan 31 → 32)
  and the isolation suite the tenancy half.
- **The archived-promotion sub-clause of both policies was untested.** `0053`
  argues at length that it is not redundant and names the leak; deleting both
  sub-clauses left every suite green. The new case archives a promotion that
  already has an entry and an answer, and asserts zero rows **and** `total: 0`
  for it while a sibling live promotion's row still comes back — so the zero is
  a denial rather than the empty-set trap.

### 10.4 Two writes that could half-succeed, and a Station taken on trust

`recordParticipationAction` read `companyId` off the form: never parsed as a
uuid, never established as the Station owning the promotion, and handed to a
path that reaches `create_member`. Bounded by the database, so nothing escalated
and nothing leaked — but a caller could register a listener into Station A's
audience while naming Station B's promotion and only then be refused, leaving a
person registered that nobody asked for. The Station is now derived server-side
from the promotion.

And the action's two writes are two transactions. A single `try` over both
answered "Could not save" for a failure that had already registered somebody.
They are held apart now: a resolution failure names the listener, a record
failure says the listener WAS registered and to pick them from the search rather
than type them again — and re-reads the promotion's counts either way, because a
thrown error does not prove nothing was written.

### 10.5 A guard for mojibake that could not fire

`import-form.tsx` called `File.text()` — a **non-fatal** UTF-8 decode, where a
malformed byte becomes U+FFFD and nothing throws — under a `catch` whose message
said "It has to be a UTF-8 text file". Excel on a Windows machine set to
Portuguese writes Windows-1252, the same machine the semicolon-delimiter branch
two functions away already reasons about; the ASCII headers still matched, so
the file imported and registered listeners under permanently mojibake names,
**which then become the deduplication anchors every later import is matched
against**.

Replaced with `arrayBuffer()` and an explicit decode: UTF-8 `fatal: true` first,
Windows-1252 second, and the panel names the second beside the delimiter it
already names, with the first row's own name underneath as the operator's check.
Accepted-and-named rather than refused, on this file's own established reasoning
about the delimiter.

Two things had to be measured rather than assumed, and both are why the refusal
is now a guard that can fire: **Windows-1252's decoder cannot fail** — the
Encoding Standard maps its five unassigned bytes to the matching C1 code points,
so `fatal: true` on it is a no-op — and **UTF-8's decoder cannot fail on
UTF-16LE ASCII**, which is a run of legal one-byte sequences that
`normalizeHeader` would then match happily, NULs and all. So "is this text at
all" is asked of the RESULT, on both branches.

### 10.6 The record dialog rendered against whichever Station was selected

`getPromotionRecord` reads by id with no company filter, so
`?companyId=<A>&record=<promotion at B>` returned the record and the dialog
rendered it against Station A's `timeZone`, Station A's `powers`, and Station
A's list — the last through `onLoaded`, which patches the grid.

The timezone is the one that writes data: both writing surfaces on the fifth tab
convert the operator's wall clock to an instant with it, Brazil spans three
zones, and the value shifted is the one D7 measures the interval against. The
import's mapping panel would have confirmed the wrong instant back to the
operator rather than exposing it.

**Refused rather than papered over.** Carrying the record's own zone would have
fixed one of the three and left the other two, and this dialog's contract is
"the selected Station's promotion" — there is no half-true version of it. The
refusal is one click from being fixed, so the pasted link still works; it just
goes through the Station that owns the promotion.

### 10.7 Coverage that did not exist

- **Backward paging** was never driven: nothing passed `cursorSide: 'before'`
  and the e2e clicks `page-next` only. Three lines on the existing case read
  page one back through `previousCursor` and assert the **order**.
- **`countPromotionParticipations`** — what the fifth tab shows, and what the
  e2e's compensating assertion counts — had nothing at any layer. Two
  promotions, because one cannot hold all three refusal statuses: `DUPLICATE`
  needs repeats forbidden, `OVER_LIMIT` needs a ceiling, and
  `promotions_entry_ceiling_shape` permits a ceiling only where repeats are
  allowed. Plus a delegate without `participations.view` getting `0/0`.
- **`searchStationListeners`**' two claims existed only in prose. The delegate
  driving it holds `members.view` at both Stations, so an Organization-wide
  query would legitimately return the neighbour — that is what makes the
  assertion about the query's scope rather than about the role.
- **The fifth tab's permission-conditional UI** was only ever driven by an
  owner, who holds everything. Two delegates now drive it, one permission apart:
  a reader (counts yes, both writing surfaces no) and a promotions.view-only
  delegate (even the counts refused, and the tab says it is a count they may not
  read rather than rendering "0").

### 10.8 The guard's own floor

`scripts/verify-isolation-suite.mjs` held a floor on **files** and nothing else.
Delete eight `it()` blocks — or wrap them in a condition that has quietly become
false — and the collected total IS the reduced number: every arithmetic check
balances, no file is missing, and the script prints "every one accounted for,
nothing skipped". An ordinary code edit walked straight through the guard whose
purpose is that a boundary cannot go unchecked silently.

`REQUIRED_TEST_FILES` now carries a per-file `minTests` floor, counted over
cases that actually ran. And `--self-test` gained the three fixtures it was
missing, each for a check that was load-bearing and unexercised: the JSON
report's `counted !== accounted` branch, the summary's Tests line failing to
balance (the existing fixture feeds a line that BALANCES and trips a different
branch), and the `Test Files 12 passed (13)` shape quoted at the top of that
very file — the original crash, which had no fixture at all. Nine fixtures now,
from five.
