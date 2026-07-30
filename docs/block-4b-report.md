# Block 4b — Prize linking, and the surgery on the ledger — Verification Report

Branch `block-4b`, taken from `main` at `ae3d92e` after PR #15 merged. Block 4
was split into three passes with the owner; this is the second. Spec in
`docs/superpowers/specs/2026-07-30-block-4b-promotion-prizes-design.md`, plan in
`docs/superpowers/plans/2026-07-30-block-4b-promotion-prizes.md`, execution
ledger in `.superpowers/sdd/2026-07-30-block-4b-promotion-prizes/progress.md`.

**What the block set out to do, and did:** `PROMOTION_LINK` and
`PROMOTION_UNLINK` have been legal transitions in the ledger since `0026` and
unreachable ever since, because `inventory_movements` carried no promotion
reference at all. They are now reachable through two RPCs, the per-promotion
projection the design document calls H1 exists and is reconciled from the
ledger, cancelling and archiving hand the undrawn units back, and the promotion
record dialog has its fourth tab. Seven migrations, two tables, one ledger
column, one function dropped and recreated, five RPCs, one screen.

---

## 1. Verification

Every gate run at its real defaults on the final tree — after all four mutations
below were reverted, after the assertion §4.4 adds, and after the whole-branch
review's fix wave (§1.3, §8).

| Gate | Command | Result |
| --- | --- | --- |
| Lint | `npm run lint` | ✔ no ESLint warnings or errors |
| Types | `npm run typecheck` | clean |
| Unit | `npm test` | **258 passed**, 19 files (from 237) |
| Database | `npm run db:reset` then `npm run db:test` | **344 passed**, 5 files, `Result: PASS` (from 281) |
| Isolation | `npm run test:isolation` | **13 files, 152 passed** under real JWTs (from 121) — on the runs that completed. **A pre-existing worker crash aborts roughly one run in three on this machine and the gate now fails every one of them: §1.3, §1.4.** |
| End to end | `npm run test:e2e -- --workers=1` | **14 passed**, 9 spec files (from 12) |

Every row is a run on the final tree, from a clean `db:reset`. The isolation row
is written as a run's own output rather than as a composite: the previous version
of this table read "151 passed, 13 files", **a pair of numbers no single run ever
produced** — §1.2 explains why, and a reader scanning the table would have taken
it for a result. It also no longer implies that every run of that suite finishes,
because on this machine they do not (§1.3), and pretending otherwise in a summary
table is the same failure in a smaller font.

Unit went from 237 to 258: twenty-one cases — fourteen for `parseRecordParam` and
the client-module guard (§5.1), five for the link and unlink schemas, and two the
branch review added for the quantity ceiling (§8.5). pgTAP from 281 to 344:
sixty-three, one per constraint in the spec's §6 list plus the grant grid, the
recreated signature and the projection writes, and twelve the branch review added
for this block's own five functions (§8.2). Isolation from 121 to 152:
thirty-one, twenty-nine of them in one new file driven by a non-owner delegate.

### 1.1 Two facts about running the gates that cost real time to rediscover

Neither is a code defect. Both were found the expensive way.

**`public.rate_limit_counters` must be cleared before a full local e2e run.**
The invite-accept limiter is 10 attempts per 3600 seconds keyed on a hash of the
IP (`src/services/invitations.ts:14-15`), and every local spec arrives from the
same IP. Past ten accepts the limiter starts refusing, and **four unrelated
specs** fail in ways that read exactly like regressions in whatever you last
touched. Clear it first:

```
npx supabase db query --local "delete from public.rate_limit_counters;"
```

**Playwright must be run `--workers=1` locally.** `playwright.config.ts` sets no
worker count, so the default applies: half the machine's logical cores. Every
worker shares one dev server and one Supabase stack, and the specs provision
Stations and accept invitations against the same database — including through
the limiter above, which is per IP and therefore per machine, not per worker.
The result is failures that do not reproduce when the spec is run on its own,
which is the most expensive kind to chase.

### 1.2 The tinypool flake is worse than the ledger recorded — and what the branch review did about it

**Read §1.3 with this section.** What follows is Task 10's account, corrected
where it was wrong. What was actually done about it — the fix, its verification,
and the gate that now fails closed regardless — is §1.3, and one of the things
it corrects is the mechanism this section proposed.


The ledger escalated a `Worker exited unexpectedly` flake seen in Tasks 3, 4, 5
and 6, noting that "every run that hit it still reported every test passing, and
every re-run was clean". **Neither half of that is true.** On this task's
**three** full-suite isolation runs it hit **all three times, on the same
file** — so on this machine it is not intermittent at all — and it does not
merely add noise: **it silently drops a whole test file**:

```
 Test Files  12 passed (13)
      Tests  144 passed (151)
     Errors  1 error
```

Twelve files are named as passed, 151 tests are counted, 144 are reported, and
the missing seven are never mentioned again. The dropped file was
`tests/isolation/promotion-prizes.test.ts` — this block's own — every time, and
the count of cases that got through before the worker died varied between runs
(144, 142, 142), which is what a crash mid-file looks like rather than a skip.
**The first run exited 0** with that summary; the second exited 1. So the exit
code does not reliably distinguish the two, and a green isolation gate can be
missing a file.

> **Corrected by §1.3.** "The same file every time" held for three runs and does
> not hold: across ten further runs it dropped `inventory.test.ts` once and
> `invitations.test.ts` once. It is not this block's file, and it is not this
> block's defect.

There is a mechanism to point at rather than a shrug, and **this report stated
it wrongly**. It said the dropped file "is the only one that calls
`execFileSync` to spawn the Supabase CLI from inside a vitest worker thread".
**It is not the only one.** `tests/isolation/inventory.test.ts:425` and `:452`
call `corruptBalanceDirectly`, which spawns the same CLI through the same
`execFileSync` in the same helper file, and has done since Block 2 — the two
helpers sat eight lines apart. Two files shared the mechanism, not one. The
correlation was therefore never "exact in both directions"; what it was is a
mechanism present in both files that hit the crash and absent from the eleven
that did not, which is weaker and is what should have been written.

Two further corrections to what was written above it. The pool was already
`forks`, not threads: vitest 2 changed that default, and this suite runs 2.1.9,
so "inside a vitest worker thread" named the wrong thing. And under Mutation 4
(§4.4) every case in the dropped file failed before reaching either helper and
the run accounted for all 151 tests — which is evidence, but of a run that
finished in a fifth of the time and never called the helper at all, so it cannot
distinguish "the spawn is the trigger" from "a short file does not trip it".

**The revert was therefore proved in two parts** rather than trusted: the full
suite green on twelve files, plus `promotion-prizes.test.ts` run scoped, 28 of
28, four separate times across this task. **Scoped, that file has never once
triggered it** — which is the other half of the correlation, and the reason the
two-part proof is a proof rather than a workaround.

**This is the most important sentence in the report, because it is about
whether the rest of the report can be trusted.** The intermittent worker crash
that four tasks re-ran past can drop an entire file's results **and still exit
0**. Every "isolation green" claim in this block's history — in task reports, in
the ledger, in review sign-offs — came from a run whose summary nobody checked
against the expected file count, because until now the flake was believed to be
cosmetic. **Any of them may have come from a run that silently dropped a file.**
Nothing here says one did; what it says is that the evidence does not
distinguish. The claims in §1's table are the exception: they were checked file
by file, and the thirteenth was run scoped precisely because it could not be.

The standing defence Task 10 proposed — read `Test Files N passed (13)` on every
run and treat a shortfall as a failure regardless of the exit code — was the
right instinct and the wrong instrument, because it is a human reading a summary
line. It is now a step in the runner. See §1.3.

**Ruled on by the branch review**, because four tasks re-ran past it and Task 10
declined to be the fifth: this was a gate that could report success while a file
did not run, and it was the branch's most serious problem. §1.3 is what was done.

### 1.3 What the branch review did about it

Three things, in the order they matter.

**1. The suspected trigger was removed from both files rather than from one —
and it turned out not to be the trigger.** Say that first, because the rest of
this item reads like a fix and only item 3 is one. The two harness helpers no
longer spawn anything. `corruptBalanceDirectly` and
`setPromotionPrizeDrawnDirectly` each existed to run a single `UPDATE` against a
table no role holds a write grant on, and each did it by spawning
`node node_modules/supabase/dist/supabase.js db query --local <sql>` — which
itself spawns the CLI binary. Three processes deep, from inside a vitest worker,
with the worker's event loop blocked solid for the duration (measured at 6.1 s
for one call during Task 5, and there are four per run in the dropped file
alone). They now open one `pg` connection to `127.0.0.1:54322`, the port the
test config already pins, and run a **parameterised** statement —
`superuserStatement` in `tests/isolation/harness.ts`. `pg` is a new
devDependency and that is the cost. Both helpers became `async`; the six call
sites across two files take an `await`.

The side effects are worth stating because, the crash having survived, they are
now the *whole* argument for the change: the raw SQL string built by
interpolation is gone, both statements bind their values, the affected-row check
is a `rowCount` rather than a regex over CLI stdout, and the helpers refuse
outright if the suite has been pointed at a remote stack they cannot follow. The
change is worth keeping on those grounds and it is not worth crediting with
anything else — see the end of this section.

**Including speed, which is worth stating because the obvious claim is not true.**
The full suite took **124.98 s** before the change and **117–126 s** across the
fifteen runs after it: no measurable difference. The 6.1 s that Task 5 measured
for one helper call was an outlier rather than the going rate, so removing four
of them a run was never going to be worth tens of seconds, and saying it was
would be exactly the kind of unmeasured claim this branch review exists to
retract.

**2. `pool: 'forks'` was NOT the fix, and the first thing to check was whether
it would have been.** It would not: `configDefaults.pool` in vitest 2.1.9 is
already `'forks'`, so setting it changes nothing at all. It is now written into
`vitest.isolation.config.ts` anyway, as an explicit pin so that a vitest upgrade
cannot move it silently, with a comment saying in as many words that it is a pin
and not the answer. Anyone who "fixes" this flake by adding that line has done
nothing and will believe otherwise.

**3. The gate now fails closed whatever the cause — and this is the part that
actually holds.** `npm run test:isolation` runs
`scripts/verify-isolation-suite.mjs`, which asks **two independent questions**
about every full run, because neither can see what the other sees:

- **The JSON report**, against the `*.test.ts` files on disk. It is the only
  thing that knows which files were supposed to run. A file that reported nothing
  is named in the banner.
- **Vitest's own summary line**, echoed through as it arrives and then parsed.
  It is the only thing that saw a worker die *after* its file's tests had all
  passed — `Test Files 12 passed (13)` beside `Tests 152 passed (152)`, a state
  in which the JSON report has nothing whatever to complain about. An `Errors N
  error` line fails the run too, on its own.

The exit code is checked **last and never alone**, because this crash exited 0
once and 1 once from the same broken state. A run narrowed to particular files
skips the file-count check and **says so on stdout**, so a scoped run cannot be
mistaken for a whole one. `.github/workflows/ci.yml` carries a comment forbidding
its "simplification" back to `vitest run`.

**Both halves were proved against real output rather than reasoned about**, which
is how the second half came to exist at all. `--verify-report` validates a saved
JSON report and `--verify-summary` a saved run log; run against the branch
review's own logs, the four clean runs pass and the crashed one fails on both
counts:

```
$ node scripts/verify-isolation-suite.mjs --verify-summary iso-4.log
==============================================================================
ISOLATION SUITE INCOMPLETE — this run proves nothing.
==============================================================================
  * vitest collected 13 test file(s) and reported on only 12: "Test Files 12
    passed (13)". A file's worker died without the file being reported.
  * vitest reported 1 unhandled error(s) during the run.
EXIT=1
```

**The crash reproduced after the change, repeatedly, and it killed the diagnosis
outright. Say that first and plainly.** Across **fifteen** full runs on the final
tree it hit **six times** — `Worker exited unexpectedly`, from
`tinypool/dist/index.js:118`, `Test Files 12 passed (13)` every time. So the
spawn was **not** the cause, and item 1 is a tidying-up rather than a repair.
Four things are worth having:

- **It drops a different file every time.** Six crashes, six files, no repeats:
  `inventory`, `invitations`, `roles`, `tenant`, `listing`, and — once, at the
  end — `promotion-prizes`. **Four of the six call neither harness helper**: no
  `execFileSync`, no `pg`, no direct write to Postgres at all, and nothing Block
  4b added. The correlation this report built its whole diagnosis on, which had
  already been overstated (see above), is **dead**. This is a general flake in how
  the runner tears a worker down on this machine. Everything the block said about
  "this block's own file, every time" was true of three runs and is not true.
- **The damage varies run to run.** Five times every case in all thirteen files
  ran and passed and only the file-level line went missing (`Tests 152 passed
  (152)`); once results were genuinely lost (`145 passed (152)`), which is the
  pre-change signature. So a crashed run may or may not have lost coverage, and
  from the summary alone you cannot tell which — another reason the run has to
  fail rather than be interpreted.
- **An accumulated-stack explanation was tested and does not hold either.** The
  rate looked like it rose with the age of the local stack — none of the first
  three runs after a `db:reset` crashed, four of the next seven did, and by then
  `auth.users` held **4128 rows**, because `cleanupUsers` cannot delete every user
  it creates (a pre-existing ⚑ in §8.6: non-cascading foreign keys and the "at
  least one owner" trigger). So batch 3 in §1.4 was run from a clean `db:reset` —
  and it crashed on the **second** run, with the stack barely used. A fourth
  explanation crossed off. The leak is real, it is now measured at about 450 rows
  a run, and it is still worth fixing; it is not this.
- **The first version of the guard nearly missed the first crash.** Its JSON
  report was clean — every assertion it knew of had passed — so the
  file-completeness check said nothing and the run failed only on the exit code,
  which is the one signal this crash is known to fake. That is why the summary
  check above exists; it was written *because* of that run rather than in
  anticipation of it. All six crashes were then caught loudly, on three or four
  independent signals each.

**What is therefore still open:** the crash is real, it is about two full runs in
five on this machine, its mechanism is unknown, it is **not** Block 4b's, and four
explanations have now been tested and killed — the CLI spawn; an inherited
`NODE_CHANNEL_FD` corrupting the parent's IPC channel (probed directly with a
`fork()` and an `execFileSync`: Node deletes the variable, both child and
grandchild read `undefined`); the idea that it is confined to the files that
write Postgres directly; and an accumulated local stack. **What is closed:** it
can no longer be mistaken for a
pass. **The lead that remains** is `poolOptions.forks.singleFork`, which would run
every file in one reused child and so remove the per-file worker teardown this
crash lands in. Untried here: telling it from noise at this rate needs far more
runs than a fix wave can afford, and shipping an unverified pool option to chase
a flake is exactly how the `pool: 'forks'` non-fix would have happened.

**Every observation of this crash, across five tasks and eleven full runs, has
been local and on Windows.** CI runs `ubuntu-latest` and there is no evidence of
it there. If it does appear there, the answer is to fix the flake, **never** to
weaken the guard or add a retry — a gate that is re-run past is the exact failure
this block spent eleven tasks on.

### 1.4 The isolation runs

Full `npm run test:isolation` on the final tree, on the same machine that
produced the three dropped-file runs. **Fifteen of them**, in three batches of
five. Batches 1 and 2 ran back to back on one stack and are §1.3's evidence — the
first found that the crash survives the change, the second that it drops a
different file every time. Batch 3 is the verification batch, **from a clean
`db:reset`**, which is the condition CI's `db` job always runs under and the
condition §1.3's last lead says matters.

| Batch | Stack | Runs | Crashed | Files dropped |
| --- | --- | --- | --- | --- |
| 1 | 5 runs old | 5 | 1 | `inventory` |
| 2 | 10 runs old, 4128 rows in `auth.users` | 5 | 3 | `invitations`, `roles`, `tenant` |
| 3 | fresh `db:reset`, 0 rows | 5 | 2 | `listing`, `promotion-prizes` |

Batch 3, run by run — this is the row the gate table in §1 is quoting:

| Run | `Test Files` | `Tests` | Exit | Guard |
| --- | --- | --- | --- | --- |
| 1 | 13 passed (13) | 152 passed (152) | 0 | complete |
| **2** | **12 passed (13)** | 152 passed (152) | 1 | **INCOMPLETE** — `listing` |
| 3 | 13 passed (13) | 152 passed (152) | 0 | complete |
| **4** | **12 passed (13)** | 152 passed (152) | 1 | **INCOMPLETE** — `promotion-prizes` |
| 5 | 13 passed (13) | 152 passed (152) | 0 | complete |

**Six crashes in fifteen runs, on six different files, no repeats:**
`inventory`, `invitations`, `roles`, `tenant`, `listing`, `promotion-prizes`.
Every file that reported, reported 13/13 and 152/152 — the suite itself is not in
question. What is in question is the runner, and §1.3 has what is known about it.
Note batch 3 crashing on its second run: the fresh stack does not help either,
which is the fourth explanation crossed off.

**A leak worth writing down while it is measured**, because it is the ⚑ in §8.6
and nobody had put a number on it: five runs from a clean `db:reset` left
**2245 rows in `auth.users`** — about 450 a run that `cleanupUsers` cannot
delete.

---

## 2. What shipped

Seven migrations, `0045`–`0051`, in the order they must apply.

- **`0045_promotion_prizes.sql`** — `promotion_prizes` (the link: N units of a
  prize committed to one promotion, one live row per pair behind a partial
  unique index, composite foreign keys to both parents proving the Station
  structurally) and `promotion_prize_balances` (the H1 projection: `linked`,
  `drawn`, non-negative each, `drawn <= linked` as a table check). Adds
  `inventory_movements.promotion_prize_id` and the
  `inventory_movements_promotion_reference` check that requires it on exactly
  the two promotion movement types and forbids it everywhere else. Registers the
  `promotions.prizes` permission.
- **`0046_rls_promotion_prizes.sql`** — RLS on both new tables, inheriting two
  levels down (balances → links → promotions) so a delegate who cannot see the
  promotion cannot see its links or their figures. Earlier in the block than
  `0029` and `0044` sat in theirs, deliberately: every task after it asserts
  state by reading these tables.
- **`0047_promotion_prize_ledger.sql`** — `ensure_promotion_prize_balance_row`,
  the schema's only INSERT against the projection; and
  `apply_inventory_movement` **dropped and recreated** with a ninth argument, so
  the ledger's single writer feeds both projections inside the transaction that
  appends the movement. Carries the lock-order argument and its three load-
  bearing properties, and a tripwire that raises `XX000` for any movement type
  it cannot project.
- **`0048_reconcile_promotion_prizes.sql`** — `reconcile_inventory` dropped and
  recreated (its OUT list changes) to recompute the per-promotion projection
  from the ledger too and report a divergence per link, naming the promotion. It
  reports; it does not repair.
- **`0049_promotion_prize_rpcs.sql`** — `link_prize_to_promotion` and
  `unlink_prize_from_promotion`. Both take `for update` on the promotion row
  before reading the figure they decide on. Both gate on `promotions.prizes`,
  resolved from the promotion row and never from a parameter.
- **`0050_promotion_lifecycle_returns_prizes.sql`** — `return_promotion_prizes`,
  shared by `cancel_promotion` and `archive_promotion`, both recreated. The
  decision behind it is §3.1. Also completes the grant sweep across all six of
  4a's write RPCs.
- **`0051_promotion_prize_reads.sql`** — `list_promotion_prizes` and
  `list_linkable_prizes`, both `SECURITY DEFINER`. The reason is §3.2.

**The screen:** the promotion record dialog gains its fourth tab, **Prêmios**
(`src/app/(app)/promotions/prizes-tab.tsx`), read as part of `getPromotionRecord`
so it costs no extra round trip on open. One row per linked prize with
Vinculados / Sorteados / Resto, a prize picker with a search box that reads one
past the fifty it shows so a cut list can say it was cut, and a per-row unlink
bounded by Resto. Every write in it re-reads this one record, never the list.

---

## 3. Two decisions taken during planning that the spec did not contain

Both were settled during execution, neither is in the spec as written, and both
change what the code does rather than how it is arranged. The first is now
corrected in the spec itself (§2 D1); the second is recorded here.

### 3.1 The archive hole, and the owner's answer to it

The spec's D1 said cancelling a promotion returns its undrawn prizes, and then
argued the rule was sufficient on its own:

> Archiving still refuses while the promotion is accepting entries (4a), so by
> the time a promotion can be archived it has been cancelled and nothing is held.

**That premise is not what 4a shipped.** Read `0042` and the two refusals do not
compose the way the sentence assumes:

- `archive_promotion` refuses only **inside** the window — while the promotion
  is accepting entries.
- `cancel_promotion` refuses a promotion that has already **ended**.

So an ended, never-cancelled promotion is archivable, and cancelling it first is
not merely unnecessary — it is **refused**. There was no order of operations
that returned the units. A promotion reaching the end of its window with prizes
linked and then being filed away stranded them: out of `available`, counted in
the balance, inside a record nobody will open again. That is the exact stranding
D1 exists to prevent, and it was reachable by doing nothing at all.

Two answers were possible. Grow a new refusal — archiving refuses while anything
is linked, and the operator unlinks by hand first. Or make archiving hand the
units back itself.

**The owner chose the second.** The cost is stated rather than buried:
**archiving now moves stock.** It is the only operation in the project whose
name suggests filing a record away and which also touches a balance, and a
reader who assumes archiving is a pure record operation will be wrong here. The
argument for it is that the first option puts a manual step between an operator
and a filing action they will perform in bulk, and an operator who is refused
will unlink to zero and archive anyway — so the refusal buys a click, not a
decision. Both paths share one helper, `return_promotion_prizes` (`0050`), so
the rule has one implementation and one set of tests.

The spec's D1 has been corrected in place, in the decision itself rather than in
a report nobody reads next to it. `0050`'s header carries the same correction,
so it is also in the code.

### 3.2 Two SECURITY DEFINER reads, because a prize's name is gated on `inventory.view`

The spec's §5 says the Prêmios tab "is part of the record read". It does not say
how, and the obvious how does not work.

A prize's **name** lives in `public.prizes`, whose policy (`0029`) gates every
read on `inventory.view`. The tab is gated on `promotions.view`. An operator
holding `promotions.view` and `promotions.prizes` and nothing at all from the
inventory module — which is a perfectly ordinary way to configure a promotions
delegate — would have got a tab of blank names: a screen that half-works for its
own permission, which is worse than one that refuses.

The alternatives were both rejected. Widening `0029` to admit `promotions.view`
would let anybody who may read a promotion enumerate the Station's entire prize
catalogue, which is the opposite of what that policy is for. Requiring
`inventory.view` alongside `promotions.prizes` would make the tab's permission a
compound nobody would guess from the permission screen.

So `list_promotion_prizes` and `list_linkable_prizes` (`0051`) are **SECURITY
DEFINER** and run past RLS entirely. That is a debt, not a free move, and the
file's header says so: **each has to restate in its own body every rule the
policies would have applied.** Three are restated explicitly and each is
argued in place — the `promotions.view` gate resolved from the promotion row;
the archived-promotion rule that `0044` applies to the record (Mutation 3 in
§4.3 is what proves that one is load-bearing); and `deleted_at is null` on the
link, which `0046`'s policy bakes in. Two are deliberately **not** restated,
with the reasoning written down rather than left as omissions: no company
predicate on the join to `prizes`, because the composite foreign key makes a
cross-Station link unrepresentable; and no `deleted_at` filter on the prize
itself, because `archive_prize` refuses while a unit sits in any physical bucket
— `linked` included — so the filter could never fire today, and if a later block
makes that state reachable, hiding the link would take units belonging to a
winner off the one screen that must account for them.

The two also differ in what they gate on, and that is deliberate:
`list_promotion_prizes` on `promotions.view`, `list_linkable_prizes` on
`promotions.prizes`. Showing somebody the Station's stock is not something
reading a promotion should carry with it.

---

## 4. The mutation log

Four mutations. Three were planned before the code was written (spec §6 and the
task brief); the fourth is this task's own, chosen against a claim the block
makes prominently and nothing in the repository tests. Each was applied alone,
run, and reverted with `git checkout --` before the next — never by hand.

### 4.1 Remove `drawn` from the unlink floor

`supabase/migrations/0049_promotion_prize_rpcs.sql:169`,
`v_free := v_linked - v_drawn;` → `v_free := v_linked;`.

`npm run db:reset && npm run test:isolation -- tests/isolation/promotion-prizes.test.ts`
→ **1 failed | 27 passed (28)**.

Red: `unlinking > refuses to go below what has been drawn, naming both figures`.

**Which assertion died is the entire point of this mutation, and it is not the
one the plan expected.** The case links 5 and sets `drawn` to 2, then asks for
4 back. The brief predicted the fourth unit would be *accepted*. It is not:

```
promotion-prizes.test.ts:380  expect(denied.error?.code).toBe('23514');      ← SURVIVED
promotion-prizes.test.ts:381  expect(denied.error?.message).toContain('2');  ← RED

Expected: "2"
Received: "new row for relation "promotion_prize_balances" violates check
           constraint "promotion_prize_balances_drawn_within_linked""
```

With the RPC's floor gone, the write is still refused — by the table check
`promotion_prize_balances_drawn_within_linked` (`0045:86`), which is what "makes
D4's floor structural" in the spec's own words. It raises the **same SQLSTATE**,
`23514`. **A case that asserted only on the error code would have stayed green
with the RPC's guard deleted.** What dies is the message, and that is why the
assertion checks the message: the table check refuses the write, but it refuses
it with a constraint name, and "only 3 of the 5 unit(s) linked can be returned;
2 have already been drawn" is a sentence an operator can act on.

Two guards, one SQLSTATE, one sentence — and only the sentence is provable. That
is the single most useful thing this block's mutation round established.

One caveat, already flagged by the implementer as a deferred minor and now
sharpened by having been run: `toContain('2')` is a weak substring match. It
happened to go red here because the constraint's message contains no digit at
all. Had the constraint been named with a numeral, the assertion would have
survived a mutation it is supposed to catch. See §7.

### 4.2 Drop the per-promotion write from the ledger

`supabase/migrations/0047_promotion_prize_ledger.sql:239-261` — the whole
`if p_promotion_prize_id is not null then` block that does the arithmetic —
commented out, leaving the bootstrap and the lock (`:159-166`) in place.

`npm run db:reset && npm run test:isolation -- tests/isolation/promotion-prizes.test.ts`
→ **14 failed | 14 passed (28)**.

`npm run db:reset && npm run db:test` → `04_promotion_prizes.test.sql`,
**Failed 3/34**:

```
# Failed test 23: "the per-promotion projection was written inside the same transaction"
#         have: 0     want: 4
# Failed test 26: "and takes the per-promotion figure back down"
#         have: 0     want: 3
# Failed test 27: "a movement type this function cannot project onto a promotion is refused, not ignored"
#       caught: no exception     wanted: XX000
```

**The plan's claim about this mutation was wrong, and the correction matters
more than the mutation.** The plan said the assertion that goes red is
`reports no divergence after a link and unlink round trip`, and that it is "the
one that matters: it is the assertion that proves reconciliation would have
*caught* this in production". It is neither. Measured:

- `reports no divergence after a link and unlink round trip` dies at
  **line 515**, `expect(undo.error).toBeNull()` — **47 lines above** its
  reconciliation assertion at line 562, which is never reached. With the
  projection write gone, `ensure_promotion_prize_balance_row` still bootstraps
  the all-zero row, so `linked` stays 0 and the unlink of 2 hits the RPC's own
  floor: `23514: only 0 of the 0 unit(s) linked can be returned; 0 have already
  been drawn`.
- `reports a drawn figure the ledger cannot account for` — the case that does
  pin the reconciler emitting a row — **also never reaches its reconciliation
  assertion**. It dies earlier still, at **line 467**, inside
  `setPromotionPrizeDrawnDirectly`: with `linked` stuck at 0, writing `drawn = 1`
  violates `promotion_prize_balances_drawn_within_linked`.

So **Mutation 2 proves the projection write happens. It does not, and cannot,
prove that reconciliation catches its absence** — every path to a reconciliation
assertion is blocked by an earlier guard doing its job. The two claims need two
different mutations, and the second one was run during Task 5: delete `0048`'s
per-promotion half outright, and exactly one case goes red — `reports a drawn
figure the ledger cannot account for` — while `reports no divergence` stays
green, because `[]` is what an absent half returns too. That asymmetry is what
the hard gate on Task 5 was widened to require.

The test file already documents this correctly at
`tests/isolation/promotion-prizes.test.ts:545-559`, written after the same
mutation was run during Task 5. It has now been measured twice, from a clean
`db:reset`, and both runs agree.

The `XX000` tripwire (test 27) going red is worth its own line: it is the guard
Block 6 will trip if it widens the ledger check without teaching the dispatch
about the new type, and this is the run that shows it is reachable.

### 4.3 Remove the archived-promotion rule from the DEFINER read

`supabase/migrations/0051_promotion_prize_reads.sql:62-64`, the
`if v_deleted is not null and not public.is_owner_of_company(v_company)` block,
deleted.

`npm run db:reset && npm run test:isolation -- tests/isolation/promotion-prizes.test.ts`
→ **1 failed | 27 passed (28)**.

Red: `reading the Prizes tab > hides an archived promotion's prizes from a
delegate and shows them to the owner`, at line 1008, on the delegate half:

```
- Array []
+ Array [
+   Object {
+     "drawn": 2, "linked": 2,
+     "prize_id": "8d16bfeb-…", "prize_name": "Filed read-archived-1785437081033",
+     "promotion_prize_id": "9cc3d6d1-…",
+   },
+ ]
```

Exactly the leak a DEFINER read opens by default, and the received value shows
what leaks: the prize's name and both figures on a promotion that has left every
one of that delegate's other reads. `0044` closed this for the record; a DEFINER
body never consults `0044`, and this is the one line that closes it for the tab.
The owner half of the same case stayed green throughout — the delegate half runs
first, which is the correct order, since the delegate is where the leak is.

### 4.4 The fourth mutation: leave the eight-argument overload in place

**Why this one.** The block's own reviewer instruction leads with it — "the two
things a reviewer should look at first", item one — and it asserts a test guards
it: *"`02_permissions.test.sql` pins the signature literally so that mistake
fails the suite."* `0047`'s header makes the matching claim about what the
mistake would do. Nothing in `supabase/tests/` counts overloads. It is the one
claim in this block that is both load-bearing and, as far as any grep could
tell, entirely untested — and it names a specific, mechanically reproducible
mistake, which is what makes it mutable at all.

`supabase/migrations/0047_promotion_prize_ledger.sql:95-97`, the
`drop function public.apply_inventory_movement(…8 args…)` statement, commented
out. The nine-argument `create function` below it then succeeds as an overload:

```
apply_inventory_movement(uuid,uuid,inventory_movement_type,integer,inventory_bucket,inventory_bucket,text,text)
apply_inventory_movement(uuid,uuid,inventory_movement_type,integer,inventory_bucket,inventory_bucket,text,text,uuid)
```

**`npm run db:test` → 331 passed, 5 files, `Result: PASS`. Nothing red.**

**`npm run test:isolation` → 38 failed | 113 passed (151), 2 files**, every
failure the same:

```
record_stock_entry failed: function public.apply_inventory_movement(uuid, uuid,
inventory_movement_type, integer, unknown, unknown, text, text) is not unique
```

Three findings, in order of how much they should change what a reviewer reads:

1. **The claim about `02_permissions.test.sql` was false as written.** Its three
   assertions name the nine-argument signature through `::regprocedure`.
   `::regprocedure` resolves a signature and proves that *that* function exists;
   it says nothing about what else shares the name. The whole database gate
   passed with both overloads live. **Closed below** — the file now counts
   `pg_proc` entries by name as well.

2. **`0047`'s own header was wrong about the mechanism.** It said, at what were
   then lines 36-40, that the five existing callers "would keep resolving to the old body and
   would silently never write the new projection". They do not resolve to it at
   all. Every eight-argument call is **ambiguous** between the surviving
   eight-argument function and the nine-argument one whose last parameter
   defaults, and raises `42725` at the first call — the more so because the
   callers pass the bucket names as untyped literals, which is why the error
   reports `unknown, unknown`. The real failure is **loud, not silent** — and
   loud on the five oldest write paths in the schema rather than on the new one.
   That is better than the comment claimed, but a reviewer who trusted it would
   have gone looking for a silence that does not occur. The drop itself was
   always correct and necessary; only its stated rationale was not. **Corrected
   in place** (`0047:42-58`), along with the same sentence in the shipped
   `comment on function`.

3. **The mistake was already caught — by the isolation suite, not the database
   one.** 38 cases across `promotion-prizes.test.ts` and `inventory.test.ts`. So
   the net was real, just never the one the block named. CI runs pgTAP first, so
   a reviewer reading only the database gate saw green.

**Closed, in this task, and the closing is the point.**

`supabase/tests/02_permissions.test.sql` now counts `pg_proc` entries by name —
the same `count(*)::int from pg_proc join pg_namespace` shape the file already
used for `members_blocked_bulk` — beside the three signature lookups, with a
comment saying why they are not enough. Plan 212 → 213; the suite total is
**332**.

**And it was proved by re-running the mutation against it**, because an
assertion added to catch a specific mistake and never observed catching it is
the exact shape this block spent ten tasks removing:

```
# Failed test 73: "exactly one apply_inventory_movement exists — 0047 dropped
#                  the eight-argument form rather than leaving a twin"
#         have: 2     want: 1
# Looks like you failed 1 test of 213
Result: FAIL
```

One assertion red, and only that one, where the whole 331 had been green. The
mutation was then reverted and the suite is back to 332 `PASS`, with
`promotion-prizes.test.ts` re-run at 28/28 to confirm nothing else moved.

`0047`'s header and its `comment on function` were corrected too, in place.
Migrations are append-only **across** merges, not within an unmerged branch, and
this branch already does exactly this: `6228a8b` amended `0050` after `f06cfd5`
committed it, and `f64cadf` amended `0051`. A comment-only correction is the
mildest form of it, and the diff on `0047` is comment-only — 23 lines in, 7 out,
no statement touched. The draft PR body in the plan's Task 10 is corrected as
well, since the owner is about to use it.

**Say it plainly, because it is worth more than a quietly corrected sentence:
this block asserted, in a commit message, in a migration header, in a shipped
`comment on function` and in the PR body a reviewer was about to read, that a
test caught this mistake. It did not. The claim stood for seven tasks and
through every review in them, and it was a mutation — not a reading — that
found it. The assertion exists now because of that mutation.** The three
`::regprocedure` lookups were never wrong about what they assert; they were
wrong about what they were being credited with, and no amount of re-reading them
would have shown it. This is the single clearest argument in the block for
running the mutation rather than reasoning about it.

### 4.5 Revert proof

After each mutation, `git checkout -- <file>`, never a hand-undo. After all
four:

```
$ git status --short
?? Arte/

$ git diff ae3d92e..HEAD --stat   # byte-identical to the pre-task capture
$ git rev-parse HEAD
948bcacc1ac89a6a384239dc08b6ac274d57b71d
```

`HEAD` unmoved, no tracked file modified, the untracked `Arte/` the only entry —
which is what it was before this task started. The gates the mutations touched
were then re-run from a clean `db:reset`: pgTAP 332 `PASS`, isolation green
(§1.2 for how that was proved in two parts), plus lint, typecheck and 256 unit.
Those three totals are **Task 10's**, recorded as they stood when the mutations
were reverted; the branch review's fix wave later took them to 344, 152 and 258.
§1 has the current table.

---

## 5. Two pre-existing defects found and fixed on this branch, outside the block's plan

Neither is 4b's work. Both were found while doing 4b's work, both were escalated
to the owner, and in each case **the owner directed the fix onto this branch
before the PR** rather than into a follow-up. The reasoning was the same both
times and it is worth recording, because the project's usual instinct — and this
report's own §7 — is to defer: a defect that is live on **six shipped screens**
and that **no test catches** does not become cheaper by waiting, and the branch
that discovered it is the only one that can prove the fix with the harness
already open.

### 5.1 `parseRecordParam` has been dead on all six record screens since Block 3c

Commits `caef39d` (the fix) and `37d726c` (two claims in the fix's own
documentation that were not true).

Every screen that opens a record validates `?tab=` against a tuple of legal
slugs. Each of those six tuples was exported from that screen's **record
dialog** — a module whose first line is `'use client'`. The six `page.tsx` files
that import them are **Server Components**. React hands a Server Component a
registered client reference for such an import, not the value.

The defect had two faces, and the quiet one is why it survived three blocks:

- `?record=<id>&tab=<slug>` called `undefined` as `includes` and threw
  `TypeError: tabs.includes is not a function` during the server render. The
  screen came back as an error boundary.
- `?record=<id>` alone short-circuits before `.includes`, read `tabs[0]` as
  `undefined` and returned a null tab — so the server validated **nothing**, and
  only `useRecordDialog` re-deriving the tab in the browser hid it.

**No test caught either.** Every spec opened records by clicking a row, which
runs the same parse inside the hook in the browser, where the tuple is a real
array. The two specs that did navigate to an address carried no tab, took the
quiet branch, and passed.

The six tuples moved into `src/lib/record-params.ts`, beside `parseRecordParam`,
whose own doc comment already claimed to be the only module that knows how a
record's address is spelled — and the legal values of `tab=` are part of that
spelling. Not six neutral modules one per screen: that is six more places to
keep uniform by hand, which is the drift this grew out of. Every `as const` and
every derived union type is unchanged. Covered by an e2e that opens a cold
`?record=&tab=` address on two screens, each on a tab that is not the first, and
by a source-shape guard over every page that calls `parseRecordParam` — because
the invariant is a fact about the **module graph**, and nothing runnable under
vitest can observe it.

`37d726c` then corrected two things the fix said about itself: the guard's
`isClientModule` tested the first *text* in the file while its comment claimed
the first *statement*, so a dialog growing a licence header would have been
called a server module and let the whole guard pass on a live bug; and the
migration comment's "every property read off it answers `undefined`" was
falsified by the implementer's own probe, which printed `length => 0` — the
reference is a function, so `.length` is its arity. Narrowed to the two reads the
parser actually makes.

### 5.2 The record dialog's `close()` walked off the page when the record arrived by deep link

Commit `948bcac`.

`close()` in `useRecordDialog` called `history.back()` whenever the record was
in the URL. **Only `open()` puts an entry there to go back to.** When the record
arrived in the first address of the session — a pasted link, a bookmark, a deep
link — `back()` walked the browser off the current document.

Live on all six record screens since Block 3c. What it looked like from a desk:
an operator who opened a listener from a pasted address, closed it and
immediately clicked "Register listener" got the registration dialog and then
watched it close itself a moment later — the back navigation landed, the
document was replaced, and the grid remounted with its state reset.
`members-flow.spec.ts` had been red on that exact sequence, and the guard's own
comment described the accident it was failing to prevent.

The old guard asked whether the record **is** in the URL. That is true in both
cases, so it could not tell them apart. `close()` now asks whether **this hook**
pushed the entry. If it did, `history.back()` as before, so the stack does not
grow and Back still leaves the list. If it did not, `replaceState` writes the
closed address over the current entry: nothing navigates, no entry is added.
Neither branch reaches for `useRouter().push` — that is the one move that
re-runs the list's keyset query, which is the whole reason this hook exists.

This is also the commit that made the full e2e **14/14** for the first time on
this branch. `members-flow` passes because the product changed; that spec is
untouched by the commit.

---

## 6. A sentence to retire

**The hook's comment claimed `back()` was chosen so that closing "does not leave
a forward-stack entry that re-opens the record on Forward". It is the opposite,
and it has been documented backwards since Block 3c.**

`history.back()` moves the **traversal pointer**. It does not pop. The entry the
pointer moves away from stays on the stack, **ahead** of the pointer — so
`back()` is precisely the instrument that leaves the record one Forward away.
`pushState` is what truncates the forward entries.

The consequence is that **on the clicked path the record has always been one
Forward away after closing** — before this block and after it. Nothing changed;
what changed is that the comment now says so. `back()` is still the right
instrument on the branch it guards, for the *other* reason: the stack does not
grow, so Back leaves the list instead of walking backwards through every record
opened on the page. Only the reason given was wrong.

Three blocks of briefs carried the false sentence forward as a requirement.
**Do not carry it into another one.** The correction is now in the code, at
`src/hooks/use-record-dialog.ts:122-132`, and the two remaining "pops" the
branch review found beside it are gone too (§8.4).

**The open product question, for the owner.** Nobody has ever decided whether
that Forward behaviour is *wanted* or merely *tolerated*, because until this
branch nobody knew it was happening — the documentation asserted the opposite.
An operator who closes a record and presses Forward re-opens it. That may be
exactly right. It is not a decision anyone has made.

---

## 7. What Block 6 inherits

Each with the file and the line to change.

**1. Widen the ledger's promotion reference to the draw and delivery types.**
`supabase/migrations/0045_promotion_prizes.sql:124-128`, constraint
`inventory_movements_promotion_reference`. It admits `promotion_prize_id` on
`PROMOTION_LINK` and `PROMOTION_UNLINK` only, and forbids it on everything else.
`DRAW`, `DRAW_CANCEL`, `DELIVERY` and the return types all need it. Deliberately
excluded here: this block has no way to write one, and a check admitting a
column no caller can fill is a rule that cannot be tested. The header at
`0045:118-123` says so where Block 6 will look. Migrations are append-only, so
this is a drop-and-recreate of the constraint in a new file.

**2. Teach `apply_inventory_movement`'s type dispatch about each new type.**
`supabase/migrations/0047_promotion_prize_ledger.sql:239-261`. It handles
`PROMOTION_LINK` and `PROMOTION_UNLINK` and raises `XX000` on anything else
(`0047:257-259`). **That raise is the tripwire**: widen the constraint above
without touching this and the first draw fails loudly instead of appending a
movement the projection never hears about. Proved reachable — see §4.2, pgTAP
test 27. When you recreate this function, read §4.4 first: its argument list is
what forced the drop-and-recreate, and both the header's account of a missed
drop and the test that was credited with catching one were wrong until Task 10.
`02_permissions.test.sql` now counts `pg_proc` entries named
`apply_inventory_movement` and expects exactly 1 — widen the signature again and
that assertion still holds, which is the point of counting by name.

**3. Add `delivered` to `promotion_prize_balances`, with the movement that fills
it.** The column comment that promises it is
`supabase/migrations/0045_promotion_prizes.sql:93-94`. It is absent on purpose:
a `DELIVERY` movement cannot carry a `promotion_prize_id` until item 1 lands, so
nothing could ever increment it, and a column whose only writer does not exist
is the same shape as a guard that can never fire — a shape this project has
shipped five times.

**4. The `drawn` arm of `reconcile_inventory` starts returning real figures with
no change there.** `supabase/migrations/0048_reconcile_promotion_prizes.sql:156-179`.
It computes 0 for every row today because no `DRAW` movement can carry a
promotion reference. **Check it rather than trust it**: it handles `DRAW` and
`DRAW_CANCEL` only; `DELIVERY`, `RETURN_PENDING` and `RETURN_TO_STOCK` all fall
to `else 0` (`0048:163-170` says so in the file), and whether a delivered or
returned unit should
leave `drawn` is an open question nobody has settled. It is not a free choice
either — `promotion_prize_balances_drawn_within_linked` (`0045:86`) constrains
what the answer is allowed to be.

**5. `setPromotionPrizeDrawnDirectly` becomes unnecessary and should be
deleted.** `tests/isolation/harness.ts`, called four times in
`tests/isolation/promotion-prizes.test.ts`. It exists only because `drawn` has no
writer in this block, so D4's floor has no fixture reachable through any RPC.
Once the draw exists, all four call sites should become real `DRAW` movements and
the helper should go, along with the warning attached to it.

**And it takes nothing else with it.** An earlier version of this report said
deleting it would also remove "one of the two `execFileSync` spawns that
correlate with the worker crash". That was false in two ways. The other spawn was
never in this file: `corruptBalanceDirectly` is called from
`tests/isolation/inventory.test.ts` and has been since Block 2, so deleting this
helper would have left the mechanism live in a file nobody was watching — which
is the worst possible outcome for a reader who trusted the sentence. And there is
now no spawn to remove from either: both helpers run one parameterised statement
on a `pg` connection (§1.3). `superuserStatement`, which they share, must stay
for `corruptBalanceDirectly` regardless of what Block 6 does to this one.

**6. The modelling gap — the one that is not a test artefact.**
`supabase/migrations/0050_promotion_lifecycle_returns_prizes.sql:25-37` names it
in its header, so Block 6 finds it in the code and not only here.

> After a cancellation, the **drawn** units sit in the `linked` bucket on a
> promotion that is over, and **no operation left can move them.**

`unlink_prize_from_promotion` refuses below `drawn`
(`supabase/migrations/0049_promotion_prize_rpcs.sql:169-180`), cancelling again
is refused, and nothing else in the schema touches that bucket until the draw
arrives. They are **not lost** — the ledger and both projections agree about
them and reconciliation stays clean — but they are **stuck**. Whoever writes the
draw, the delivery and the returns must decide what a drawn unit on a *cancelled*
promotion means: the winner was promised something the Station then called off.
That is a product question, it is not answered here, and the shape of
`return_promotion_prizes` does not prejudge it — it simply refuses to take back
what a winner was promised.

---

## 8. Deferred minors, grouped

Roughly twenty-five across eleven tasks, disclosed in the ledger rather than
discovered here — **plus seven the whole-branch review found that this list did
not contain at all**, which is the more important half of that sentence. The
roll-up as Task 10 wrote it claimed completeness; it was complete over the
ledger, not over the branch. The seven are marked **✚** below and each says
where it came from. The five unpinned functions and the archive permission
consequence are the two that were merge-blocking; the rest are one- or
two-liners.

**⚑ marks what should not survive to Block 5.** ✔ marks what has since been
closed — during the block, or in the branch review's fix wave — and every one of
those is still listed, unmarked with ⚑, because a defect that was fixed is worth
more to the next reader as a record than as a silence.

### 8.1 Assertions that measure the wrong thing, or cannot fail

- ✔ **`promotion-prizes.spec.ts` used `nth(5)` for the Available column with no
  header assertion pinning the index.** Insert a column before it and the
  locator shifts onto In stock, which holds the same number at that point — so
  it keeps passing while measuring something that never moved. This is exactly
  the defect class the block spent ten tasks hunting; shipping one is worse than
  shipping none. **Closed in the fix wave**: the index is a named constant and
  `assertAvailableHeader` reads the header at that same index before the cell is
  read.
- ✔ **`refuses to go below what has been drawn` asserted `toContain('2')`**, a
  weak substring match on a message that also contains other digits. §4.1 is the
  run that depended on it — and, per that section, the *sole* assertion in the
  repository that dies when D4's floor is removed, because the table check raises
  the same `23514`. **Closed in the fix wave**: it now pins the whole sentence,
  `only 0 of the 2 unit(s) linked can be returned; 2 have already been drawn`.
- ✚ ✔ **`refuses more units than are available` asserted `toContain('3')`**, with
  the identical weakness, and was **not in this roll-up at all** — the branch
  review found it. Any refusal quoting any figure carries a `3` somewhere, and
  `23514` is the code the table checks raise too. **Closed in the fix wave**: it
  pins `only 3 unit(s) are in available, and 5 were requested`, which is the
  pairing the screen shows the operator.
- Two assertions in `promotion-prizes.spec.ts` are entailed by the row-count
  assertion above them and cannot fail.
- ✔ `04_promotion_prizes.test.sql`'s `has_function` check for
  `ensure_promotion_prize_balance_row` was described as proving "exactly one
  INSERT statement, in its own function" and proves only that the function
  exists. **Closed in the fix wave**, by rewording rather than by a new
  assertion: this is the same species as the overload claim two bullets below,
  which Task 10 spent a mutation retracting, and retracting one while leaving its
  twin next door is the inconsistency. The invariant stays prose-only, in `0047`'s
  header, and the message now says what it asserts.
- `tests/isolation/inventory.test.ts` discards `released.data`, so a
  `release_reservation` returning null while writing correctly would pass.
  Trivial given the assertions that follow.
- ✚ ✔ **`refuses to go below what has been drawn` handed `linked.data as string`
  to `setPromotionPrizeDrawnDirectly` without checking `linked.error` first**,
  while two sibling cases in the same file explain at length why they do check
  exactly that. Found by the branch review. Without it a failed link makes the
  helper's own UUID guard the red line, blaming the fixture for a link that never
  happened. **Closed in the fix wave.**
- The "exactly 50 prizes" half of the picker cap test is a baseline sanity
  check, not a regression net: with 50 rows, `limit 50` and `limit 51` return
  identical output. Only the 52-prize half distinguishes them.
- **The overload-count gap** (§4.4) — **closed in Task 10**, and listed here
  anyway because it is the purest specimen in the block: an assertion that names
  a signature, read for seven tasks as pinning uniqueness, and only a mutation
  could tell the difference.

### 8.2 Coverage the block shipped without

- ✚ ✔ **This block pinned Block 4a's grant grid and none of its own.**
  `03_promotions.test.sql` added twelve assertions closing 4a's gap, with a
  comment arguing that "a seventh promotion write RPC arriving without a pair
  here is the thing this block of assertions exists to make obvious" — and the
  same branch then shipped **five** functions with no such pair:
  `link_prize_to_promotion` and `unlink_prize_from_promotion` (`0049`),
  `list_promotion_prizes` and `list_linkable_prizes` (`0051`), and
  `return_promotion_prizes` (`0050`). Found by the branch review, not in this
  roll-up, and the only merge-blocking item on this list besides the isolation
  gate. **`return_promotion_prizes` is the sharp one**: it performs **no
  permission check of any kind**, it moves stock for both lifecycle RPCs, and its
  entire safety is that it is SECURITY INVOKER with EXECUTE granted to nobody —
  precisely the pair of properties `ensure_promotion_prize_balance_row` has four
  dedicated assertions for, and that one cannot move a unit. Marking it DEFINER
  is a one-word edit in a file full of DEFINER functions. **Closed in the fix
  wave**: four assertions for it in `02_permissions.test.sql` beside the two
  bootstraps it mirrors (plan 213 → 217), and an anon/authenticated pair for each
  of the four public RPCs in `03_promotions.test.sql` (plan 49 → 57), beside 4a's
  six rather than in Block 4b's own file — splitting the grid by migration is
  exactly how both gaps happened. Suite total 332 → **344**.
- ⚑ **The read-only notice scoping and the whole `!canLink` branch of the Prizes
  tab have no coverage** — the new e2e runs entirely as the owner. A permission
  branch on a shipped screen that no test enters.
- ⚑ **The client-module guard resolves one direct named import per page
  textually and does not follow re-export chains.** A neutral module
  re-exporting from a `'use client'` file passes the guard with the bug live.
  The implementer named this as the one it would take first.
- Both runtime nets for §5.1's defect are conditional on unrelated assertions
  earlier in their files, so its runtime coverage goes dark exactly when those
  files are already red.
- `formatBucketName` has no test at all — one caller, no unit coverage — so the
  label Task 4 added is unproven rather than merely unregressed.
- `data-testid="prize-link-cut"` is added but never asserted.

### 8.3 Accessibility and screen defects

- ✔ **Per-row unlink controls shared one accessible name** ("Units to return to
  stock", "Return") with no prize in either, against the precedent
  `inventory-grid.tsx` sets. The per-row testids were likewise duplicated and
  worked only because the test links exactly one prize — **a second row makes
  them strict-mode violations**, so this was a latent test break as well as an
  accessibility defect. **Closed in the fix wave**: the prize's *name* is
  interpolated into both accessible names, and its *id* into the three test ids —
  different keys on purpose, because nothing in the schema makes a prize's name
  unique within a Station, so keying the ids on the name would leave the
  strict-mode violation reachable and a rename would move every selector.
- The tab hand-rolls a `<table>` instead of `@/components/ui/table`
  (plan-mandated) and has no `<caption>` where `inventory-grid.tsx` has one.
- A half-filled Link form is discarded on a tab switch — consistent with
  `QuizTab`, noted because the rubric asks.
- Still no screen reader run against the tab strip or the portalled menu. The
  same gap 4a and 3c left, still open.

### 8.4 Comments, history and register

- `f06cfd5`'s **commit message** still carries the false "those units are in
  `awaiting_pickup`" sentence. The code and the comments were fixed in
  `6228a8b`; the history was not, and rewriting branch history was not
  authorised.
- **`0047`'s header was wrong about what a missed drop does**, and its shipped
  `comment on function` carried the same sentence (§4.4). **Both corrected in
  place in Task 10** — append-only binds across merges, not within an unmerged
  branch, and `6228a8b` and `f64cadf` set the precedent on this branch.
- ✔ The hook said `back()` "pops" the entry in two places
  (`src/hooks/use-record-dialog.ts`), which is the exact wrong model the
  paragraph twenty lines below disowns (§6). **Closed in the fix wave**: both now
  say the pointer steps off the entry and the entry stands.
- ✚ ✔ **`close()`'s early return left `ownsCurrentEntry` set**, so the invariant
  "this ref is false whenever the record is closed" held by an argument about
  which paths reach which line rather than unconditionally. Found by the branch
  review, not in this roll-up. **Closed in the fix wave**: the ref is read into a
  local and cleared before the early return.
- ✚ ✔ **`promotions.archive` and `promotions.cancel` now authorise a stock
  movement, and nothing said so.** `archive_promotion` gates on
  `promotions.archive` alone and then calls `return_promotion_prizes`; same for
  `cancel_promotion` on `promotions.cancel`. So a delegate holding
  `promotions.view` + `promotions.archive` and nothing else moves inventory,
  with no `promotions.prizes` and no `inventory.*` anywhere on the path — the
  **converse** of the separation `promotions.prizes` was created to make.
  The spec, the plan, `0050`'s header and §3.1 of this report all discussed
  archiving moving stock as a *behavioural* cost; **none discussed it as a
  permission cost**, which is the one an owner reviewing the permission screen
  would want. Found by the branch review. **The gating was deliberately not
  changed** — that is the owner's decision, not a reviewer's. **Stated in the fix
  wave**: a paragraph in `0050` above both functions, a sentence in each shipped
  `comment on function`, a question in the spec's §7, and an isolation case
  (`lets a delegate holding no promotions.prizes move stock by archiving`) that
  builds the link with a second client and asserts the same delegate is refused
  `unlink_prize_from_promotion` with `42501` first, so the case is about a
  delegate who may *not* move stock rather than merely about one who did. See §9.
- `0049:48-50` raises `P0002` before its permission gate, so a caller can
  distinguish "no such promotion" from "exists, you lack the code". `0042:259`,
  `:174` and `:323` do the same. `list_promotion_prizes`' two "cannot see it"
  paths are likewise distinguishable — a missing id reads `[]`, an existing one
  in an unreachable Station raises `42501`. **These are one question about an
  established register, not two task-level defects, and the branch review should
  rule on them together.**
- The link and unlink audit rows are asymmetric: unlink records whether the link
  closed, link records nothing about whether the row was created or topped up.
  Recoverable from `promotion_prizes.created_at`.
- `0050`'s grant block is a second responsibility in a file named for the first;
  the timing comment explains why it could not go in `0042`.
- "Resto" is untranslated in `0048` against the everything-in-English
  constraint. Precedent at `0045:92` and `0047:219`, where it names an actual
  screen label; `0048` does not gloss it.
- `src/app/(app)/promotions/errors.ts:34` is 103 characters against
  `.prettierrc`'s `printWidth` 100. **The real item is that no gate catches it**:
  `next lint` does not check formatting and CI has no `prettier --check` step.

### 8.5 Schema and server layer

Three the whole-branch review found, none of them in this roll-up, all closed in
the fix wave.

- ✚ ✔ **`promotion_prizes_promotion_idx` was write cost and storage for
  nothing.** `(promotion_id) WHERE deleted_at IS NULL`, two lines below
  `promotion_prizes_live_unique (promotion_id, prize_id) WHERE deleted_at IS
  NULL` — same predicate, same leading column, so every lookup and range scan by
  promotion that the two RPCs and both read functions make was already served by
  the unique index. **Removed in place in `0045`**, with the reasoning in the
  comment where the index used to be: append-only binds across merges, not within
  an unmerged branch, and `6228a8b` and `f64cadf` set that precedent here.
- ✚ ✔ **`quantity` in `src/schemas/promotions.ts` had no upper bound**, so a
  hand-posted `2147483648` reached `p_quantity integer` and came back `22003` —
  which maps to `InternalError` and reaches the operator as a generic "Could not
  save", a sentence that says nothing about what to change. **Closed**: a `.max()`
  at exactly `2147483647` with a message, plus two unit cases (the ceiling
  accepted, one past it refused by that message), so the bound cannot be loosened
  by a single unit without a red test. Unit 256 → **258**.
- ✚ ✔ **`list_promotion_prizes`' error was wrapped in `InternalError` directly**
  instead of going through `mapPromotionError`, unlike every other RPC call in
  `src/services/promotions.ts` — and it is the one call in `getPromotionRecord`
  that can raise `42501`, because the function is SECURITY DEFINER and re-checks
  `promotions.view` in its own body. A permission refusal was becoming a 500
  logged as ours. **Closed.** The three reads above it are ordinary PostgREST
  selects, where a policy denial arrives as an empty result and never as an
  error, so they have nothing to map.

### 8.6 Harness and runner

- ⚑ **The tinypool worker crash is still open, and it is bigger than this block**
  (§1.2, §1.3, §1.4). Escalated in the ledger after four tasks; Task 10
  established that it can drop a file while the run reports success. The branch
  review removed its suspected trigger, **and it reproduced anyway** — six times
  in fifteen full runs, on **six different files**, four of which touch nothing
  Block 4b added. Four hypotheses tested and killed. What *is* closed is the thing
  that made it dangerous: the gate can no longer report success while a file did
  not run, and that half was proved against the crash's own output. Read §1.3
  before spending time on this; the crossed-off answers are listed there, and the
  one lead left (`poolOptions.forks.singleFork`) with it.
- ⚑ **Isolation stderr is not pristine** — `cleanupUsers: could not delete N
  user(s)` on every run. Documented in `harness.ts` and pre-existing, but it
  means a genuine cleanup failure is indistinguishable from the baseline, which
  is how the §1.2 crash stayed unnoticed as long as it did. **Now measured**, and
  the figure is worse than "not pristine" suggests: five runs from a clean
  `db:reset` left **2245 rows in `auth.users`**, about 450 a run.
- ✔ `setPromotionPrizeDrawnDirectly` took 6.1 s and failed once during Task 5,
  because it reused `corruptBalanceDirectly`'s mechanism verbatim — the block
  extended an existing vector rather than introducing one, which is also why
  removing only this one would have left the vector live (§7 item 5). Both now
  run one parameterised statement on a `pg` connection instead of spawning the
  Supabase CLI. Note that this bought no measurable time: 124.98 s for the full
  suite before, 117–126 s over fifteen runs after, so that 6.1 s was an outlier.

**Closed during the block, recorded so nobody re-opens them:** Task 2's gap that
`promotion_prize_balances`' own policy had no live denial case was closed in
Task 7, and the denial is genuine — the same PostgREST query on the same primary
key returns the row for a `promotions.view` holder and `[]` **with a null error**
for a same-Station member holding only `members.view`, and the null error is what
distinguishes a policy denial from a missing grant. Task 7's narrow re-run of
isolation was superseded by Task 8 running all thirteen files.

---

## 9. Open, and deliberately not done

The spec's §7 as amended, plus what this task added.

- **`DRAW`/`DELIVERY` do not carry the promotion reference yet** (spec §3.3).
  Block 6 — §7 items 1 and 2.
- **Whether `promotions.prizes` should be its own code** (spec §4) — the owner's
  call at review, exactly as with 4a's five.
- **The inventory screen still cannot answer "which promotions hold this prize's
  stock"** (spec §5). Worth answering; not this block's.
- **Should `promotions.archive` and `promotions.cancel` authorise a stock
  movement on their own?** (spec §7, this report §8.4). The permission half of
  the decision below, and the half nobody had ruled on because nobody had written
  it down. A delegate holding `promotions.view` + `promotions.archive` and
  nothing else moves inventory. **The owner's call:** leave it, require
  `promotions.prizes` alongside, or split archiving in two. Deliberately not
  changed by the branch review; stated in the code, in both `comment on
  function` texts, in the spec and in an isolation case.
- **Archiving moves stock now** (spec §2 D1, this report §3.1). The only
  operation in the project whose name suggests filing a record away and which
  also touches a balance. Worth revisiting if Block 6's draw gives an ended
  promotion another way to let go of its prizes.
- **`list_linkable_prizes` caps at 50** and the picker says so. A Station with
  hundreds of prizes has a search box and nothing else; whether that is enough
  is a question for the first operator who has one.
- **Whether the record should stay one Forward away after closing** (§6) — never
  decided, because it was documented backwards for three blocks.
- **The `P0002`-before-the-gate register** (§8.4) — one whole-branch ruling, not
  two task-level fixes.
- **Nothing was pushed and no PR was opened** — the owner's call, and a
  whole-branch review runs first.
