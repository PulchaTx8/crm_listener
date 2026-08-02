# Block 6a — The draw — Verification Report

**Date:** 2026-08-02
**Branch:** `block-6a` (cut from `main` after PR #19)
**Spec:** `docs/superpowers/specs/2026-08-02-block-6a-draw-design.md`
**Plan:** `docs/superpowers/plans/2026-08-02-block-6a-draw.md`
**Migrations:** `0075`–`0080`

A promotion's winners are picked, the prize moves in the inventory, a deadline
starts running — and anybody holding the record can recompute the same winners.

---

## 1. Gates

Every number below was measured on this branch at the end of the block, not
copied from a previous report.

| Gate | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm test` (Vitest) | **529** cases, 35 files |
| `npm run db:test` (pgTAP) | **759** cases, 10 files |
| `npm run test:isolation` | **210** cases, 19 files, guard-complete |
| `CI=1 npx playwright test` | **24** passed |
| `npm run build` | clean; `/promotions/[id]/draws` builds as a dynamic route |

Block 6a's own additions: 84 pgTAP assertions in `09_draws.test.sql`, 23 Vitest
cases across `draw-algorithm` and `run-draw-dialog`, 5 isolation cases in
`draw.test.ts`, 1 Playwright journey.

---

## 2. What shipped

| Migration | What |
|---|---|
| `0075_draw_tables.sql` | `draw_status`, `winner_status`; `draws`, `draw_entries`, `winners`, `draw_runners_up`; the two deadline columns; `draws.execute` and `draws.cancel` |
| `0076_draw_eligibility.sql` | `member_block_active`; `draw_eligible_participations`; `is_member_blocked` and `members_blocked_bulk` refactored onto the new core |
| `0077_draw_ledger.sql` | the movement-reference constraint widened to `DRAW`/`DRAW_CANCEL`; `project_promotion_prize_movement`; `apply_inventory_movement` replaced to call it |
| `0078_run_draw.sql` | `apply_draw` (private) and `run_draw` |
| `0079_cancel_draw.sql` | `cancel_draw` |
| `0080_draw_reads.sql` | `list_draws`, `get_draw` |

TypeScript: `src/lib/draw/algorithm.ts` (the verifier), `src/services/draws.ts`,
the `/promotions/[id]/draws` route with its screen, and the two components.

---

## 3. The decisions, and where they landed

| Decision | Where it is enforced |
|---|---|
| D1 — one entry per VALID participation | `draw_eligible_participations`; pgTAP "two participations by one listener are two entries"; the 30-entry isolation fixture |
| D2 — one prize per person per draw | the walk's `distinct on (member_id)`, **and** `winners_one_prize_per_member` as a constraint, so a future edit to the walk cannot break it quietly |
| D3 — reproducible from a stored seed | seed generated inside `apply_draw`, `CHECK` on its shape, `algorithm_version` per draw, and `tests/isolation/draw.test.ts` |
| D4 — one ordered runner-up queue | the same walk continued, `unique (draw_id, member_id)` on the queue |
| D5 — the deadline is frozen at the draw | `winners.deadline_at` written once; pgTAP proves promotion-overrides-prize and null-means-none |
| D6 — both kinds of block exclude | `member_block_active`, mutation-proven |
| D7 — a cancelled draw is kept whole | `cancel_draw` deletes nothing; pgTAP asserts hat, winners and seed survive |
| D8 — the operator chooses how many units | `p_units`, defaulting to `linked − drawn` |

---

## 4. Deviations from the plan, recorded

**4.1 `is_member_blocked` could not be the eligibility filter.** The plan said to
call it and to read its signature in `0032`. Two things were wrong with that.
Its live body is `0036`'s, which supersedes `0032`'s and says so. And it is
`SECURITY DEFINER` with its own caller gate: it raises `42501` unless the caller
holds `members.view`, and `auth.uid()` does not change inside a `SECURITY
DEFINER` body — so an operator holding `draws.execute` alone would have got a
permission error instead of a draw, while spec §4.3 gates drawing on
`draws.execute`. It also costs a `member_reachable` call per participation.

Put to the owner, who chose extraction: `member_block_active` answers the domain
question with no caller gate, and `is_member_blocked` and `members_blocked_bulk`
keep their guards and now read the predicate from it. Neither changed what it
answers — `02_permissions.test.sql`'s six-way probes are untouched and pass.

*Not* a defect that was feared and checked for: this never silently included
banned listeners. Reachability is true whenever the gate's third arm is, since
the listener is linked to the Station they participated at.

**4.2 The ledger tripwire fired, and needed its own migration.** `0047` admitted
`promotion_prize_id` on two movement types and raised `XX000` if a third
arrived, explicitly so Block 6 could not widen the constraint without teaching
the projection. The first `DRAW` hit it. `0077` does both halves together and
lifts the projection into `project_promotion_prize_movement`, so 6b adds its
four types to a small function instead of restating a 180-line one. This is why
the block runs to `0080` rather than the plan's `0079`.

`04_promotion_prizes.test.sql` reached that tripwire *through* `DRAW`, which now
has a rule. It moves to `MANUAL_ENTRY` — not `DELIVERY`, the obvious 6b
stand-in, because source sufficiency runs before the projection and `DELIVERY`
would be refused with `23514` several steps short of the branch.

**4.3 Refusal codes follow the schema, not the plan.** The plan's self-review
asked for `22023` on both a cancelled and an archived promotion.
`link_prize_to_promotion` (`0049`) and `apply_participation` (`0054`) both answer
`P0002` for a soft-deleted promotion and `22023` for a cancelled one. A third
dialect here is the drift those two exist to prevent.

**4.4 The screen is a route, on the owner's ruling.** The plan's file map asked
for `/promotions/[id]/draws`, but the promotion detail is a tabbed record dialog
with no `[id]` route at all. Put to the owner, who chose the route.

**4.5 The names gate is not in the plan.** `get_draw` is `SECURITY DEFINER` and
would have handed any listener's name to anyone holding `promotions.view`, which
`members_select_reachable` (`0035`) refuses. It asks for `members.view`
separately and returns null names without it, reporting `shows_names` so the
screen says *nome não visível* rather than rendering a blank. Decided during
implementation, not by the owner — flagged in §5.4.

**4.6 pgTAP plan counts.** The plan estimated 18 assertions for Task 1; the file
carries 84 across the block. The counts were written to match the assertions
actually present.

---

## 5. Concerns

### 5.1 The algorithm is now a versioned contract nobody may change silently

`sha256(seed || ':' || participation_id)`, ascending as bytes, ties broken by
the frozen position. Every draw already run records `algorithm_version = 1`, and
the runbook publishes the recipe. Changing the walk, the separator, the
encoding, the byte-vs-hex comparison or the tie-break **changes who would have
won**, and every draw stored under version 1 becomes unverifiable against the
new code.

The rule for anyone editing `apply_draw` or `algorithm.ts`: a behaviour change
is a **new version number**, with the old rule kept for old draws. This is the
single most fragile thing the block ships, and it is fragile by design — the
alternative was a draw nobody could check.

### 5.2 Measured: pgTAP is blind to the thing the block is about

With the SQL ordering mutated from the sha256 rank to the frozen position — a
draw that ignores its own seed entirely — **all 733 pgTAP assertions passed**.
Only `tests/isolation/draw.test.ts`'s three rounds went red.

That is the whole argument for Task 5 existing, and it is measured rather than
asserted. A future round that finds the isolation suite slow and drops the
reproduction rounds would leave the audit claim with nothing behind it.

### 5.3 Measured: the concurrency case needed its error code to be real

Twelve rounds of two concurrent draws over one unit. With `FOR UPDATE` removed
from `run_draw`, the outcome pair (one success, one refusal), `drawn = 1` and
the winner count were **all unchanged** — the ledger's own sufficiency check
caught the loser several steps later, and the test still passed.

What makes it real is asserting *which* refusal: `22023` from `apply_draw` with
the lock, `23514` from `apply_inventory_movement` without it. The plan warned
that a count alone cannot tell "the lock worked" from "the constraint caught
what the lock should have prevented"; that warning was correct and the first
version of the case was inadequate.

### 5.4 The names gate is a product decision made by the implementer

§4.5. An operator with `draws.execute` and `promotions.view` but not
`members.view` can run a draw and cannot see who won by name. That is the
conservative reading of Block 3's gate, and it may not be what a Station wants —
somebody who is trusted to draw is arguably trusted to read the winner's name.
It is one `case when` in `get_draw` either way. **Worth the owner's confirmation
before this ships.**

### 5.5 The isolation flake is unchanged and still uncaused

Block 4b recorded fifteen runs, six crashes, six different files, no repetition.
This block saw three incomplete runs before a clean one, then two clean runs.
`fileParallelism: false` is already set; `poolOptions.forks.singleFork` remains
the one untested hypothesis. The guard fails closed and reported every one of
them correctly. **The fix is the flake, never the guard.**

Separately: after `supabase db reset`, the auth container answers `createUser
failed: {}` until the stack is restarted. `npx supabase stop && npx supabase
start` clears it. This cost twenty minutes of misdiagnosis mid-block and is the
same class of trap Block 3c recorded for Kong.

### 5.6 A link that merely rendered caused a fetch

Adding the Prizes-tab link to the draws route turned `promotion-prizes.spec.ts`
red: Next prefetches an in-viewport `Link`, that RSC request's path starts with
`/promotions`, and the spec counts exactly that to prove the list is never
re-queried. The guard was right — the tab really had started causing a fetch it
did not need, and rendering the draws route runs twelve `has_permission` calls
plus both draw reads. Fixed with `prefetch={false}` on the link rather than by
narrowing the spec's filter.

### 5.7 Inherited, unchanged

The error-code existence leak (`P0002`/`42501` before or after the permission
gate) now crosses six migrations, `run_draw` and `cancel_draw` included: both
answer `P0002` for a promotion or draw the caller cannot reach, before checking
permission. Block 4b logged it; it is still open and still a decision, not a
bug.

---

## 6. Deferred to Block 6b

Delivery and its receipt; the `DELIVERY` movement and the return types — the
ledger constraint and `project_promotion_prize_movement` deliberately still
refuse them, and `04_promotion_prizes.test.sql`'s tripwire is waiting for
whichever block widens them next. Return to stock honouring
`prizes.allows_return_to_stock`; promoting a runner-up and re-arming its
deadline; `winner_status_history`; the deadline cron and its notification.

`winners.status` already carries the full five-value vocabulary, so 6b adds
behaviour rather than re-shaping a column that holds rows.

---

## 7. Not done

**The PR is not open.** The owner decides when it opens.
