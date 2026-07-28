# Block 2 — Inventory & Prizes — Verification Report

- **Date:** 2026-07-28
- **Branch:** `block-2`
- **Spec:** `docs/superpowers/specs/2026-07-27-block-2-inventory-prizes-design.md`
- **Plan:** `docs/superpowers/plans/2026-07-27-block-2-inventory-prizes.md`
- **Ledger:** `.superpowers/sdd/2026-07-27-block-2-inventory-prizes/progress.md`
- **Predecessor:** Block 1c (`docs/block-1c-report.md`)

---

## 1. Verification

All run on a clean `npx supabase db reset`, local Supabase stack already running.

| Command | Result |
|---|---|
| `npm run lint` | PASS — no ESLint warnings or errors |
| `npm run typecheck` | PASS — no output |
| `npm test` | PASS — 12 files, 90 tests |
| `npx supabase db reset && npx supabase test db` | PASS — 3 files, 101 assertions |
| `npm run test:isolation` | PASS — 8 files, 66 tests |
| `npm run test:e2e` | PASS — 8 tests, default worker count (see §1.1) |
| `docker build -t pulchatx:b2 ...` | PASS — image 314 MB |

Verbatim output:

```
> pulchatx@0.1.0 lint
> next lint --dir src --dir tests
✔ No ESLint warnings or errors

> pulchatx@0.1.0 typecheck
> tsc --noEmit
(no output)

> pulchatx@0.1.0 test
> vitest run
 ✓ tests/unit/rate-limit.test.ts (4 tests)
 ✓ tests/unit/errors.test.ts (3 tests)
 ✓ tests/unit/supabase-config.test.ts (2 tests)
 ✓ tests/unit/sanity.test.ts (1 test)
 ✓ tests/unit/roles-schema.test.ts (13 tests)
 ✓ tests/unit/inventory-schema.test.ts (41 tests)
 ✓ tests/unit/env.test.ts (9 tests)
 ✓ tests/unit/logger.test.ts (5 tests)
 ✓ tests/unit/mailer.test.ts (1 test)
 ✓ tests/unit/provisioning-password.test.ts (3 tests)
 ✓ tests/unit/invitation-token.test.ts (5 tests)
 ✓ tests/unit/contact-requests.test.ts (3 tests)
 Test Files  12 passed (12)
      Tests  90 passed (90)

Applying migration 0025_inventory_catalogue.sql...
Applying migration 0026_inventory_ledger.sql...
Applying migration 0027_inventory_rpcs.sql...
Applying migration 0028_reconcile_inventory.sql...
Applying migration 0029_rls_inventory.sql...
Restarting containers...
Finished supabase db reset on branch block-2.

Connecting to local database...
/CRM - LISTENER/supabase/tests/00_smoke.test.sql ........ ok
/CRM - LISTENER/supabase/tests/01_identity.test.sql ..... ok
/CRM - LISTENER/supabase/tests/02_permissions.test.sql .. ok
All tests successful.
Files=3, Tests=101,  0 wallclock secs
Result: PASS

> pulchatx@0.1.0 test:isolation
> vitest run --config vitest.isolation.config.ts
 ✓ tests/isolation/roles.test.ts (17 tests) 12562ms
 ✓ tests/isolation/inventory.test.ts (14 tests) 14354ms
 ✓ tests/isolation/permissions.test.ts (11 tests) 5860ms
 ✓ tests/isolation/invitations.test.ts (7 tests) 4624ms
 ✓ tests/isolation/tenant.test.ts (9 tests) 4544ms
 ✓ tests/isolation/contact-requests.test.ts (3 tests) 81ms
 ✓ tests/isolation/provisional-password.test.ts (4 tests) 1338ms
 ✓ tests/isolation/signup-disabled.test.ts (1 test) 20ms
 Test Files  8 passed (8)
      Tests  66 passed (66)

> pulchatx@0.1.0 test:e2e
> playwright test
Running 8 tests using 5 workers
  ok 1 tests\e2e\home.spec.ts:3:5 › home shows the product and links to contact (745ms)
  ok 6 tests\e2e\home.spec.ts:9:5 › contact page renders the form (2.8s)
  ok 7 tests\e2e\home.spec.ts:15:5 › login page renders the credentials form and offers a reset (980ms)
  ok 8 tests\e2e\home.spec.ts:22:5 › an anonymous visitor is redirected away from the app (422ms)
  ok 2 tests\e2e\invitation-flow.spec.ts:38:5 › an owner invites a colleague who joins with their own password (19.7s)
  ok 3 tests\e2e\provisioning-flow.spec.ts:46:5 › provision a customer, sign in, change the password, then suspend (21.3s)
  ok 5 tests\e2e\inventory-flow.spec.ts:57:5 › a delegate holding a scoped Stock Keeper role runs the whole prize and stock journey (24.6s)
  ok 4 tests\e2e\roles-flow.spec.ts:49:5 › an owner composes a role and assigns it per Station (26.1s)
  8 passed (28.2s)

docker build -t pulchatx:b2 --build-arg NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy .
...
 ✓ Compiled successfully in 10.1s
   Linting and checking validity of types ...
 ✓ Generating static pages (10/10)
#20 naming to docker.io/library/pulchatx:b2 done
```

### 1.1 The default-worker e2e question is settled: not flaky here

Task 10's review left one thing open: two pre-existing specs were reported as
intermittently timing out at the repo's default Playwright worker count, and the
implementer's authoritative passes were run at 2–3 workers instead. This block's
whole claim is that a number is either true or the system says so — the same
standard applies to the verification gate that guards it, so this could not be
quietly re-run at reduced parallelism and reported green.

`npm run test:e2e` was run **four times in this session at the repo's real
default** (no `--workers` override, no config change) — once before the invariant
mutations in §2 below, and three times in a row afterward to specifically probe for
the reported intermittency:

```
Run 1: Running 8 tests using 5 workers — 8 passed (28.2s)
Run 2: Running 8 tests using 5 workers — 8 passed (22.6s)
Run 3: Running 8 tests using 5 workers — 8 passed (24.9s)
Run 4: Running 8 tests using 5 workers — 8 passed (19.2s)
```

Default worker count on this machine (32 logical CPUs) is 5. Four consecutive
clean runs, zero timeouts, on the exact command the CI gate runs. This is treated
as **settled for this environment**: at the default, the suite is not flaky. It is
recorded rather than hidden that the concern existed and that this run is what
resolved it — if it recurs on a different machine or under CI's own resource
constraints, that is new evidence, not a contradiction of this result.

### 1.2 What the pgTAP and isolation counts do, and do not, prove

As in every prior block: pgTAP has no session harness, so nothing in
`supabase/tests/*.sql` proves a policy or a `SECURITY DEFINER` function actually
filters rows or enforces a permission for a real signed-in user — only that a grant
is present or absent, a constraint fires, or a flag is set. Session-dependent
enforcement — a role granting or withholding an `inventory.*` permission, a bucket
floor refusing a real caller by name, reconciliation running under a real
`inventory.view` holder rather than the table owner — is proven exclusively by
`tests/isolation/inventory.test.ts` under real JWTs. §2 below demonstrates this
distinction is not decorative: mutating the RPC's own check and mutating the table
CHECK constraint are different failures, and only the isolation suite's specific
message assertion tells them apart.

### 1.3 Branch-level fix round (2026-07-28) — counts updated

A whole-branch review of this block (§2.3 below) found one Critical defect and
several Important/Minor gaps that no single task's review could see, because each
saw only its own slice. Fixed on this same branch in `0030_inventory_adjustment_semantics.sql`
and an edit to `0029_rls_inventory.sql`, plus TypeScript/React changes. The gate was
re-run in full afterward; the counts in §1's table above are now stale and are
superseded by:

| Command | Result |
|---|---|
| `npx supabase db reset && npx supabase test db` | PASS — 3 files, **124** assertions (was 101; +23 new pgTAP cases) |
| `npm run test:isolation` | PASS — 8 files, **69** tests (was 66; +3 new cases for the Critical) |
| `npm run test:e2e` | PASS — 8 tests, default worker count (5 workers on this machine) |
| `npm run lint` / `npm run typecheck` / `npm run build` | PASS |
| `npm test` (unit) | PASS — 12 files, 90 tests, unchanged |

Full transcripts, including the failing-then-passing run for the three new
isolation cases, are in
`.superpowers/sdd/2026-07-27-block-2-inventory-prizes/final-fix-report.md`.

---

## 2. Proof that the invariant tests still bite

Two mutations were applied to the migrations on disk, each verified live against a
`npx supabase db reset`, then reverted with `git diff` confirmed empty before the
database was reset back to a clean state. Neither mutation is present in any commit.

### 2.1 Removing the source-sufficiency check from `apply_inventory_movement`

`supabase/migrations/0027_inventory_rpcs.sql`'s `apply_inventory_movement` reads the
source bucket's current figure and raises a named exception — `'only % unit(s) are
in %, and % were requested'`, `errcode 23514` — before it ever issues the `UPDATE`
that would drive the bucket negative. The function's own comment already states why
this check exists in addition to the table's `CHECK (available >= 0)` and its
siblings: *"The CHECK constraints would also refuse this, but they would refuse it
with a constraint name; the caller deserves the number."*

The `if v_current < p_quantity then raise exception ...` block was deleted, leaving
the `UPDATE` unconditional. After `npx supabase db reset`,
`tests/isolation/inventory.test.ts` was run:

```
 ❯ tests/isolation/inventory.test.ts (14 tests | 1 failed)
   × inventory > a movement cannot drive a bucket below zero — the RPC names the
     available count, not a bare constraint error
     → expected 'new row for relation "inventory_balan…' to match
       /only 5 unit\(s\) are in available, an…/

 FAIL  tests/isolation/inventory.test.ts > inventory > a movement cannot drive a
 bucket below zero — the RPC names the available count, not a bare constraint error
 AssertionError: expected 'new row for relation "inventory_balan…' to match
 /only 5 unit\(s\) are in available, and 10 were requested/
 - Expected:
 /only 5 unit\(s\) are in available, and 10 were requested/
 + Received:
 "new row for relation \"inventory_balances\" violates check constraint
 \"inventory_balances_available_check\""

 Test Files  1 failed (1)
      Tests  1 failed | 13 passed (14)
```

**This is the case the brief anticipated, and the test is at the right layer.** The
operation was still refused — the table's `CHECK` constraint is genuine defence in
depth and caught the below-zero write on its own — but the test does not merely
assert that an error occurred (line 48, `.not.toBeNull()`, still passed on its own).
It asserts the *message* (line 49), which pins the RPC's own sufficiency check, and
separately asserts the message does **not** match `/violates check constraint/i`
(line 53) — a second, independent assertion written for exactly this failure mode.
Both fired. The test did not pass vacuously at the wrong layer; it failed loudly and
specifically, in the one place a test written to only check "was there an error"
would have stayed green. Caught by:
`tests/isolation/inventory.test.ts:26` — *"a movement cannot drive a bucket below
zero — the RPC names the available count, not a bare constraint error"*.

The change was reverted; `git diff` on the file was empty before the database was
reset again.

### 2.2 Making `reconcile_inventory` return no rows unconditionally

`supabase/migrations/0028_reconcile_inventory.sql`'s final `select ... where
coalesce(s.stored, 0) <> coalesce(c.computed, 0) order by ...` was changed to `where
false`, so the function type-checks and runs but can never surface a divergence
regardless of what is actually stored versus computed. After `npx supabase db
reset`:

```
 ❯ tests/isolation/inventory.test.ts (14 tests | 1 failed)
   × inventory > reconciliation reports nothing after real movements, and the
     exact divergence after a balance is corrupted directly
     → expected [] to have a length of 1 but got +0

 FAIL  tests/isolation/inventory.test.ts > inventory > reconciliation reports
 nothing after real movements, and the exact divergence after a balance is
 corrupted directly
 AssertionError: expected [] to have a length of 1 but got +0
 - Expected: 1
 + Received: 0

 Test Files  1 failed (1)
      Tests  1 failed | 13 passed (14)
```

Caught by: `tests/isolation/inventory.test.ts:381` — the planted-divergence half of
*"reconciliation reports nothing after real movements, and the exact divergence
after a balance is corrupted directly"*. The test seeds a real seven-movement
sequence (confirming the clean-case assertion `expect(clean.data).toEqual([])`
still passed, unaffected by this mutation since there was no real divergence to
report there), then corrupts `delivered` directly via `corruptBalanceDirectly` —
chosen specifically because no movement in the fixture ever names `delivered`, so
the divergence exists on the stored side of the `FULL OUTER JOIN` alone and cannot
be produced by any bug that only weakens the join. `reconcile_inventory` returned
zero rows where exactly one planted divergence was expected — the detector was
silenced, and the test caught it immediately.

The change was reverted; `git diff` on the file was empty before the database was
reset again, `npx supabase test db` (101/101) and `npm run test:isolation` (66/66)
re-run clean.

### 2.3 The Critical the branch-level review found: `adjust_stock` reconciled the wrong quantity

**Found by a whole-branch review, not by any task review** — each task review saw
only its own slice; only reading `adjustment-form.tsx` (Task 9) against `adjust_stock`
(Task 3) and the spec's own equation (§4) side by side surfaced the mismatch between
what the form told the operator to do and what the RPC actually computed.

`adjustment-form.tsx` instructs the operator: *"What is actually on the shelf right
now — not the difference from what is booked."* But `adjust_stock` reconciled **only
the `available` bucket** against `p_counted`. The design spec (§4) puts `reserved`
**inside** the physical total — a reservation commits units, it does not remove them
from the Station — so an operator who correctly counted the whole shelf while some
of it was reserved had their honest count read as an increase to `available` alone,
inventing units that were never missing. With `available = 30, reserved = 10`
(physical total 40), a count of 40 produced `available = 40 - 30 = +10`, leaving the
balance at `available 40, reserved 10` — physical total 50, ten units invented. This
was reachable the moment `reserve_stock` had been used even once (shipped in this
same block) and invisible to `reconcile_inventory`, because the ledger row and the
projection agreed with each other; only the physical count outside the system
disagreed, and the system had no way to hear that.

**Reproduced first, before any fix.** Three isolation cases were added to
`tests/isolation/inventory.test.ts` (the `describe('adjust_stock reconciles the
physical count, not available alone', ...)` block) and run against the pre-fix
schema (`npx supabase db reset` on the migrations as they stood, `0001`–`0029`):

```
 ❯ tests/isolation/inventory.test.ts (17 tests | 3 failed)
   × inventory > adjust_stock reconciles the physical count, not available alone >
     a physical count equal to available + reserved (+ every other committed
     bucket) records no movement and changes nothing
     → expected '7490ef6b-b318-44ac-be0c-79b8e4866360' to be null
   × inventory > adjust_stock reconciles the physical count, not available alone >
     a genuinely different physical count moves only available, leaving reserved
     untouched
     → expected { movement_type: 'ADJUSTMENT_POSITIVE', quantity: 15, ... } to
       match object { movement_type: 'ADJUSTMENT_POSITIVE', quantity: 5, ... }
   × inventory > adjust_stock reconciles the physical count, not available alone >
     a physical count below what is already committed is refused, naming both
     figures
     → expected null not to be null

 Test Files  1 failed (1)
      Tests  3 failed | 14 passed (17)
```

Exactly the three failure shapes the defect predicts: a physically-correct count
recorded a spurious movement instead of a no-op; a genuine 5-unit difference was
recorded as 15 (the pre-existing 10 reserved units folded into the delta); and a
count below what was already committed was silently accepted (an `ADJUSTMENT_NEGATIVE`
succeeded) instead of refused. All 14 pre-existing cases still passed, confirming the
new cases were the only ones probing this contract.

**Fixed in `supabase/migrations/0030_inventory_adjustment_semantics.sql`** by
re-declaring `adjust_stock` (not editing `0027` in place, per the coordinator's
instruction) so that `p_counted` means the physical count: `committed` (reserved +
linked + awaiting_pickup + pending_return) is read under the same balance-row lock as
`available`; the new `available` is `p_counted - committed`; the recorded movement is
the difference between that and the current `available`; and a count below `committed`
is refused with `23514`, naming both figures. The mandatory note, the post-lock
pre-delta idempotency check, the null-return no-op and the permission check are all
unchanged from `0027`. The fix deliberately does **not** ask the operator for "free to
promise" (available alone) instead — that would make them subtract the committed
units in their head before typing a number, reintroducing exactly the sign-inversion
risk the design already rejected once for the available/delta question.

After the fix, `npx supabase db reset` and the same three cases:

```
 ✓ tests/isolation/inventory.test.ts (17 tests) 16586ms
   ✓ inventory > adjust_stock reconciles the physical count, not available alone >
     a physical count equal to available + reserved (+ every other committed
     bucket) records no movement and changes nothing
   ✓ inventory > adjust_stock reconciles the physical count, not available alone >
     a genuinely different physical count moves only available, leaving reserved
     untouched
   ✓ inventory > adjust_stock reconciles the physical count, not available alone >
     a physical count below what is already committed is refused, naming both
     figures
```

`adjustment-form.tsx` was also updated: the helper text now says the operator is
counting everything physically present, **including units already reserved**, and the
form renders `BalanceStats` above it (physical total and the committed portion) so the
person can see what the system believes before they overwrite it — previously the
form sat on the same page as `BalanceStats` without referencing it at all.

---

## 3. Deployment steps

Everything in `docs/block-1a-report.md` §1, `docs/block-1b-report.md` §3 and
`docs/block-1c-report.md` §3 still applies. Migrations `0025`–`0030` apply with
`npx supabase db push --linked`:

- `0025_inventory_catalogue.sql` — `prize_categories`, `prizes`, the six
  `inventory.*` permission rows and their seeded label.
- `0026_inventory_ledger.sql` — `inventory_movements` (the immutable ledger) and
  `inventory_balances` (the projection), with the sixteen-row legal-transition
  `CHECK` and the per-bucket floor `CHECK`s.
- `0027_inventory_rpcs.sql` — `apply_inventory_movement` and the five movement RPCs
  (`record_stock_entry`, `record_stock_exit`, `adjust_stock`, `reserve_stock`,
  `release_reservation`), plus `create_prize`/`update_prize`/`archive_prize` and
  category management.
- `0028_reconcile_inventory.sql` — the read-only reconciliation function.
- `0029_rls_inventory.sql` — RLS enabled on all four tables, `select`-only grants,
  and the ledger sealed against every write from every role.

- `0030_inventory_adjustment_semantics.sql` — **the one migration here that changes
  the meaning of an existing operation, and the one to tell operators about.**
  `adjust_stock` previously reconciled only the `available` bucket while the form
  asked for the physical shelf count; with anything reserved, the two disagreed and
  the difference was recorded as invented stock that reconciliation could not
  detect. It now takes the physical count, subtracts the committed portion
  (`reserved + linked + awaiting_pickup + pending_return`) read under the same lock,
  and refuses outright when the count is below what is already committed. Also adds
  `ensure_inventory_balance_row`, the shared bootstrap that restores the
  single-writer property to something literally true.

  **Anyone trained on the old behaviour must be retold what the field means**: it is
  everything physically present, including units already reserved. The screen now
  says so and shows the figures being reconciled against, but a person who learned
  the old form will not read the new label.

Still additive: `0030` replaces two function bodies and adds one; it drops no
column, deletes no row and rewrites no ledger entry.

**Unlike Block 1c, nothing in this migration set is destructive.** Every one of
`0025`–`0029` was checked directly for `DROP TABLE`, `DROP COLUMN`, `DROP FUNCTION`,
`DROP POLICY` and `DELETE FROM` — none appears in any of the five files. No table is
dropped, no column is dropped, no existing row anywhere in the schema is deleted or
rewritten by these migrations. They add **four** new tables, two enum types and
**eleven** new functions (sixteen is the count of `inventory_movement_type` values,
not of RPCs), plus their RLS — nothing here touches a table Block 1a/1b/1c already
shipped except to grant `SELECT` on the four it creates. A deployer does not need a
pre-migration snapshot for the reason Block 1c's report gave (§3 there names three
irreversible changes on live tables); this block has none. The one property worth
protecting going forward is the *absence* of write grants (spec §16, risk 1): no
future migration should grant `INSERT`/`UPDATE`/`DELETE` on `inventory_movements` or
`inventory_balances` to anything but the `SECURITY DEFINER` RPCs that already own
them, and no future block should write to `inventory_balances` directly.

---

## 4. Definition of done

Copied from the spec's §14, with evidence per row.

| Criterion | Status | Evidence |
|---|---|---|
| A negative balance is impossible, attempted through the RPC and directly | ✅ | `tests/isolation/inventory.test.ts:26` — "a movement cannot drive a bucket below zero…" (RPC path, message pinned); `supabase/tests/02_permissions.test.sql` bucket-floor `throws_ok` cases (direct path, pinned to the `_check` constraint name); §2.1 above demonstrates both layers are genuinely load-bearing, not just one masquerading as two |
| Every bucket transition checks its source bucket before moving | ✅ | `tests/isolation/inventory.test.ts:26`; `supabase/migrations/0026_inventory_ledger.sql`'s `inventory_movements_legal_transition` — sixteen-row enumeration verified in both directions against the spec's §5 table by Task 2's review |
| The ledger cannot be updated or deleted by any role | ✅ | `tests/isolation/inventory.test.ts` — "the ledger cannot be updated or deleted, with a real JWT nor with the service client"; `supabase/tests/02_permissions.test.sql` assertions 43–46 (`authenticated`/`service_role` denied `UPDATE`/`DELETE` on `inventory_movements`) |
| A replayed movement is one movement | ✅ | `tests/isolation/inventory.test.ts` — "a replayed idempotency_key yields one movement and returns the same id"; `0027`'s partial unique index plus `ON CONFLICT DO NOTHING` arbiter, confirmed by Task 3 review to genuinely match the index |
| Each operation is refused without its permission and allowed with it | ✅ | `tests/isolation/inventory.test.ts` — "each operation is refused without its permission and allowed with it", one case per code across all six `inventory.*` permissions plus the composite "every code except inventory.adjust" case |
| A permission held in one Station does not act in another | ✅ | `tests/isolation/inventory.test.ts` — "inventory.entry held in Station A does not act in Station B — refused by the role, not the access gate" |
| Reconciliation finds no divergence after a real sequence, and finds a planted one | ✅ | `tests/isolation/inventory.test.ts:381`; §2.2 above proves the planted-divergence half is genuinely falsifiable, not passing regardless of the function's behavior |
| The inventory permissions appear in the role editor without it being modified | ✅ | `tests/e2e/inventory-flow.spec.ts` — asserts each of the six `inventory.*` permission labels individually in the role editor, with no change to `roles/role-form.tsx` in this block |
| A non-owner delegate completes the journey end to end | ✅ | `tests/e2e/inventory-flow.spec.ts` — a delegate holding a composed "Stock Keeper" role (`inventory.view/catalogue/entry/reserve`, not `inventory.adjust`) registers a prize, adds stock, reserves with a note, reads the movement history, and is refused `adjust_stock` by the database (verified mid-session by revoking the permission and confirming the still-rendered form is refused server-side, not merely hidden) |
| A prize with stock cannot be archived | ✅ | `tests/isolation/inventory.test.ts` — "archiving a prize with stock is refused, naming the count; archiving one without stock succeeds"; the archive/entry race closed with `FOR UPDATE`/`FOR SHARE` and demonstrated blocking with a live two-session transcript (Task 3 fix round 1) |
| lint, typecheck, unit, pgTAP, isolation, e2e and `docker build` all pass | ✅ | §1, including the default-worker e2e settlement in §1.1 |

---

## 5. What the plan and the implementation got wrong

Seven of ten reviewed tasks (1, 2, 4, 7, 8, 9, 10) reviewed clean on the first pass
with no Critical or Important finding. The three that needed a fix round — 3
(movement engine), 5 (RLS sealing the ledger), 6 (isolation coverage) — are exactly
the tasks touching where stock actually moves or where the ledger's guarantees are
enforced, and were reviewed on the most capable model for that reason.

### 5.1 A design gap the implementer found: the adjustment replay

**Task 3, in the plan's design, not the implementer's code.** `adjust_stock` was
specified to derive its movement from the *current* `available` figure. The
implementer ran the replay path — required by the brief rather than reasoned about
— and found that a second call with the same idempotency key recomputes its delta
against the *already-adjusted* balance, not the original one: a zero delta against
the new figure, returning `null` instead of the original movement id. Same key,
different answer — a broken idempotency contract, not a replay. Fixed with a key
lookup performed after the balance lock is taken (so a concurrent same-key call is
visible) and before the delta is computed (so it short-circuits before the
recomputation runs at all). The reviewer confirmed this is the only placement that
is correct in both respects.

### 5.2 An implementation defect: `archive_prize`'s guard protected one direction only

**Task 3, in the implementation.** `archive_prize` read the prize row unlocked and
took its lock on the balance row — which locks nothing for a prize that has never
moved. A concurrent `apply_inventory_movement` call that had already passed its own
liveness check could land on a prize archived in between, stranding exactly the
units the archive guard exists to prevent. Fixed with `FOR UPDATE` on the archive's
prize read and `FOR SHARE` on the engine's, the idiom `0017` already uses to stop a
role archival racing an assignment. Fix round 1's re-review went further than
reasoning about lock order: a live two-session transcript shows the blocked call
issued while the other session's transaction is still open, resolving within 3ms of
that session's commit in both directions — the observable signature of real lock
contention, which two independent sequential calls could not produce. This gives
Block 2 a concurrency proof where Block 1c had accepted reasoning alone for the same
class of race.

### 5.3 A reviewer correcting a convention of mine: reconciliation deserved a pgTAP guard

**Task 4, a controller error, not a plan or implementation defect.** I had extended
Task 3's own precedent — no pgTAP for RPCs, because their substance is a permission
check that needs a real session — to `reconcile_inventory` as well. The reviewer was
right that only the *gate* (`has_permission`) needs a session; the recomputation
and the `FULL OUTER JOIN` behind it are pure SQL, testable directly, and this
function is the block's entire safety net. Before the correction, that net rested
on one-time transcripts written into a report rather than a committed guard. Folded
into Task 5's dispatch: a pgTAP case seeds two real movements and one deliberately
wrong stored value, and — verified empirically by running a second copy of the
function with the `from_bucket` subtraction arm removed against the identical
fixture — genuinely fails if either arm of the recomputation is dropped
(`supabase/tests/02_permissions.test.sql`, assertions 48–51/60–63).

### 5.4 A case where the code was plausible and the reasoning was wrong: the archived-prize read policy

**Task 5, the new category of finding for this project.** The catalogue's `select`
policies (`prizes_select_inventory_view`, `prize_categories_select_inventory_view`)
were written to omit `deleted_at is null`, justified by the claim that
reconciliation needs to see archived prizes too. The SQL that shipped was
syntactically fine and the claim about reconciliation is even true in isolation —
but `reconcile_inventory` is `SECURITY DEFINER`, owned by the table owner, and so
**bypasses RLS entirely**; it never consults these policies at all, the same
interaction `0024_delegated_admin_visibility.sql` already documents from the other
direction in this project. The divergence bought reconciliation nothing it needed,
while its real, undisclosed effect was that any `inventory.view` holder could list
every archived prize and category through an ordinary read, indefinitely, on a
screen nobody has written yet. A careful read of the SQL would have passed it —
what failed was the sentence explaining why it was there. Fixed by adding
`deleted_at is null` to both policies, with a live before/after under a real
`inventory.view` holder session (two rows visible before the fix, one after) and a
permanent pgTAP regression pair (assertions 64–65) so the behavior is pinned rather
than remembered.

### 5.5 The brief itself contained a contradiction, resolved correctly

**Task 6.** Case 5 was asked to corrupt a balance "with the service client" to prove
reconciliation detects it — but Task 5 had just revoked every write grant from
`service_role` on these four tables precisely so that call is impossible, and
`02_permissions.test.sql` pins it. Restoring the grant to make the test pass would
have destroyed the guarantee Task 5 exists to prove, and broken the sibling
ledger-immutability case in the same stroke. The implementer corrupted through the
superuser connection instead — the exact scenario `0028`'s own comment names — which
the reviewer verified independently as the only correct resolution. This is recorded
in the isolation suite's own comment as: Case 5 proves the *detector*, not the
*producer* — nothing in `0025`–`0029` can itself produce a divergence, by design.

### 5.6 Two green tests that would have proved nothing had the wrong code shipped

**Task 6's most valuable finding was about two claims, not two bugs.** Case 5
corrupted a bucket (`available`, `reserved`) present on *both* sides of the `FULL
OUTER JOIN`, so degrading the join to an ordinary `INNER JOIN` would have left the
test green — the failure mode reconciliation exists to catch, undetected by the
test written to catch it. Case 6 stocked only `available`, so a version of
`archive_prize` that dropped four of its five physical buckets from the guard sum
would also have left that test green. Both tests passed, both exercised something
real, and the falsifiability table said they were covered when they were not —
worse than an honestly-labeled weak test. Fixed by corrupting `delivered` instead
(no movement anywhere in the fixture names it, so it exists on only one side of the
join — this is the fixture §2.2 above reused directly), and by reserving the full
stocked quantity so the archive refusal genuinely depends on `reserved` reaching
zero, not merely on `available` being untouched.

### 5.7 A pre-existing production defect the journey surfaced, and its own root cause

**Task 10, predates Block 2 entirely.** `admin/customers/page.tsx` resolved every
Company's owner e-mail with a single `.in()` filter across every owner this platform
has ever provisioned. Past roughly 250 ids that request exceeds PostgREST's
URI-length limit; this stack's local history had accumulated 268. The request
failed, the error was logged and swallowed like every other read on that page (same
inconsistency Block 1c §5 item 9 already names), and the console silently blanked
every "Owner:" line, not just the newest one. The 268 accounts exist because of a
defect this project already knows about and has not closed: the isolation suite's
`cleanupUsers` cannot delete accounts that have acted (non-cascading foreign keys,
first recorded in Block 1c §5 item 1) — a test-hygiene problem created the exact
conditions that exposed a production one. Fixed by batching the lookup at 100 per
request, confirmed by the reviewer to be arithmetically gap- and overlap-free,
deduplicated, and roughly half the measured failure boundary. `team/page.tsx`
carried the identical unbounded `.in()` pattern at its two lookups (member profiles,
invitation roles) — scoped to one Organization, so far lower risk in practice, but
the same defect class at its other occurrence. Batched identically in this task
(`src/app/(app)/team/page.tsx`), same 100-row chunk size, same accumulate-then-map
shape as the customers page fix.

### 5.8 Smaller findings worth naming plainly

- **Task 1** (in my brief, not the implementation): the catalogue's seeded
  `inventory.catalogue` permission label read "Register, edit and archive prizes"
  where the design spec's own wording is "…prizes and categories." User-facing copy
  in the role editor; not fixed as part of this block's scope, recorded so the next
  touch of that seed corrects it.
- **Task 1** (in the implementation, deferred as harmless): the migration omits the
  filename header comment every migration from `0016` through `0024` carries as its
  first line. Cosmetic, house-style only.
- **Task 2** (in the implementation, fixed): `inventory_movements_has_direction` and
  `inventory_movements_not_circular` were fully subsumed by the sixteen-row
  transition enumeration — every legal branch already pins at least one bucket
  non-null and never sets `from = to` — so neither constraint could ever be the
  deciding one. Removed, with the enumeration's own comment stating that it
  subsumes them: three constraints implying two live defences where there is
  actually one is worse than one constraint alone.
- **Task 4** (in the implementation, deferred): a nonexistent Company yields
  `42501` from `reconcile_inventory` where every sibling RPC in `0027` raises
  `P0002 'station not found'` first. Fails closed either way; a house-style
  inconsistency, not a security gap.
- **Task 6** (in the implementation, fixed): Case 8 (ledger immutability) was
  pinned only to a bare not-null check, which a schema-cache miss could have
  satisfied identically to a genuine `42501` denial. Re-pinned to assert the error
  code on all four attempted mutations.
- **Task 7** (in the implementation, deferred, folded to Task 8): the schema names
  the entry variant's field `entryType`, the service interface calls the same
  concept `type`, and the service took hand-written interfaces rather than variants
  of the schema's own discriminated union — each shape matched its RPC correctly,
  but nothing compiler-checked the two stayed in step. Closed in Task 8: the
  service's input types now derive from the schema via `Extract<...>`, confirmed by
  running `npm run typecheck` against the derivation rather than merely inspecting it.
- **Task 8** (in the implementation, deferred, accepted): the prize detail page
  resolves the caller's viewable Stations with a sequential loop, one round-trip per
  Station — self-flagged by the implementer, harmless at this block's scale. The
  "not found" response returns HTTP 200 rather than 404 — cosmetic, since both the
  genuinely-missing and the exists-but-hidden cases already render one identical
  body, so there is no tenant-existence leak either way.
- **Task 9** (in the implementation, fixed in Task 10): `createCategoryAction`
  bounded the category name only by a trim check, where the prize form's own schema
  bounds `prizes.name` at 120 characters against the same unbounded `text` column.
  A caller bypassing the form could store an arbitrarily long name; bounded
  identically in Task 10.
- **Task 9** (in the implementation, accepted, cosmetic): `Number(formData.get(...))`
  on a missing quantity field yields `NaN`, which zod rejects with "must be a whole
  number" rather than "is required" — a confusing message for an unlikely path,
  since the form itself always supplies the field.
- **Task 9** (disclosed scope decision, carried to §6 below): idempotency keys are
  deliberately unwired from every movement form. Correct as shipped, but a scope
  decision rather than an implementation detail, and worth the owner's explicit
  sign-off rather than staying implicit.

---

10. **Three residuals the final re-review left standing, none blocking.** Recorded
    so they are found rather than rediscovered: `src/app/(app)/inventory/page.tsx`
    and `errors.ts` still name `listViewableCompanies` after its rename; with the
    Station scan capped, a legitimate `?companyId=` beyond the cap falls back to the
    first visible Station and renders it without saying which — reachable only above
    fifty visible Companies, and disclosed by the cap notice but not by name; and
    `0029`'s comment still calls `apply_inventory_movement` the single writer of
    `inventory_balances`, which is now one function short since the bootstrap moved
    into `ensure_inventory_balance_row`. The live catalogue comments are accurate;
    only that one migration comment is stale.


## 6. Open items

1. **A zero-delta `adjust_stock` call is not idempotent, and this is accepted, not
   fixed.** `adjust_stock` reconciles to a counted figure, not a delta, and
   `quantity > 0` makes a zero-quantity ledger row unrepresentable — so the one call
   whose net effect is "nothing changed" never persists an idempotency key. If the
   balance changes between an original zero-delta call and a retry carrying the same
   key, the retry recomputes against the new figure instead of reproducing the
   original no-op. The window is narrow (same key, same zero delta, a real change to
   the balance in between) and the outcome stays auditable either way because the
   operator's note is mandatory on every call. Documented in the function's own
   comment (`supabase/migrations/0027_inventory_rpcs.sql`) rather than fixed, per
   Task 3's controller decision.

2. **`service_role`'s default-ACL `TRUNCATE` on the four inventory tables — closed
   during the final review, recorded here because the reasoning changed.** The
   original judgement was that closing it meant a project-wide default-ACL audit
   rather than a one-migration patch. The whole-branch review disagreed for these
   four tables specifically: `0029` already writes eight explicit grant and revoke
   statements against exactly them, so one more line closed the gap without touching
   any other table. `0029` now revokes `TRUNCATE` from `service_role` on all four,
   and `02_permissions.test.sql` pins eight cells so a future migration cannot
   reopen it silently. **The general default-ACL audit across the rest of the schema
   remains open** — this closed the four tables where "immutability is a grant, not
   a comment" is a claim the block actually makes.

3. **The isolation suite's teardown still leaks accounts.** Every isolation file in
   this verification run printed a `cleanupUsers: could not delete N user(s)...`
   warning (55, 48, 29, 19, 23 and 8 accounts across the six affected files this
   run; Block 1c recorded the same shape at different counts). The root cause,
   unchanged since Block 1a and recorded in `docs/block-1c-report.md` §5 item 1, is
   non-cascading foreign keys from `audit_logs`/`companies`/`invitations`/`roles`
   into `auth.users`, plus the "at least one owner" trigger tripping on an owner's
   own teardown delete. This is not cosmetic: it is what created the 268-owner
   local-history condition Task 10's e2e journey turned into a real production
   defect (§5.7 above) by exceeding PostgREST's URI-length limit on an unbounded
   `.in()` filter. The leak is honestly reported, not hidden, but it is not closed,
   and every local run of this suite makes the next accidental unbounded `.in()`
   elsewhere in the codebase more likely to trip the same limit sooner.
   **This block itself deepens the same hole**: `prizes.created_by` (`0025`) and
   `inventory_movements.actor_id` (`0026`) are two more non-cascading foreign keys
   into `auth.users`, added by this block on top of the ones already named above —
   any user who has ever registered a prize or recorded a movement now joins the
   set `cleanupUsers` cannot remove.

4. **Idempotency keys are not wired into any of the six movement forms.** Every
   movement RPC accepts an `idempotency_key` parameter and the ledger's partial
   unique index and `ON CONFLICT` arbiter genuinely dedupe a replay
   (`tests/isolation/inventory.test.ts` — "a replayed idempotency_key yields one
   movement and returns the same id") — but nothing in `src/app/(app)/inventory/`
   generates or threads a key from any form submission today, so a double-click or
   a retried network request currently produces two real movements rather than one
   deduplicated one. Disclosed by the implementer as a scope decision in Task 9, not
   an oversight discovered later — but it is a product decision (does a double-click
   on "Add stock" need to be safe today, or is that acceptable until a later block
   wires the key through) rather than something that should stay an unreviewed
   implementation choice. It belongs with the owner's explicit sign-off before or
   shortly after this merges.

5. Items 1, 2, 5, 8 and 9 of `docs/block-1c-report.md` §5 remain open and are
   unrelated to this block's scope (non-cascading FKs on internal-user deletion,
   `RAISE LOG`-only denial paths, the `roles.manage` self-escalation property, the
   table-wide `profiles` `SELECT` grant, and the four-screens-three-behaviors
   read-failure inconsistency — the last of which this block's own screens
   (`inventory/page.tsx`, `inventory/[prizeId]/page.tsx`) join rather than resolve:
   every service call there is wrapped and renders a distinct error card per Task 8's
   review, which is a fourth distinct behavior, not a fix to the inconsistency
   itself).
