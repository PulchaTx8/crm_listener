# Block 6d — The clock, the pile it makes, and the way back — Verification Report

**Date:** 2026-08-03
**Branch:** `block-6d` (cut from `block-6c`, merge base `d35e018`)
**Spec:** `docs/superpowers/specs/2026-08-03-block-6d-deadline-clock-design.md`
**Plan:** `docs/superpowers/plans/2026-08-03-block-6d-deadline-clock.md`
**Migrations:** `0091`–`0097`

A pickup deadline now expires on its own. An hourly `pg_cron` job parks the
prize of anyone who missed it in a new stock bucket, `pending_return`, where it
rests until an operator finishes the matter — back to the listener, back to
stock, or written off. Winners get a home: two new screens, `/pickups` and
`/inventory/movements`, so "what is waiting to be collected in this Station"
and "what happened to this prize" are both questions with a screen to answer
them, not a query somebody has to already know how to write. And, added
mid-block on the owner's ruling, a cancelled draw's phantom winner can no
longer consume a live winner's unit.

---

## 1. Gates

Measured on this branch after Task 11's own commit, not copied from an earlier
task in this block.

| Gate | Result |
|---|---|
| `npm run lint` | clean |
| `npx tsc --noEmit` | clean |
| `npm run build` | clean; `/pickups` 6.27 kB / 119 kB first load, `/inventory/movements` 2.82 kB / 116 kB first load |
| `npm test` (Vitest) | **597** cases, 40 files |
| `npm run db:test` (pgTAP) | **953** cases, 15 files |
| `npm run test:isolation` | **223** cases, 20 files, guard-complete — took **2 attempts**: the first crashed with `Worker exited unexpectedly` (17/20 files reported, exit 1, the script's own INCOMPLETE banner); the second, run immediately after with no other change, reported all 20 files and 223 cases, guard-complete. This is Block 4b's own documented flake, live and uncaused, not something this block introduced or fixed. |
| `npx playwright test --workers=4` | **27** specs. Two consecutive full runs: 24 passed / 3 failed, then 23 passed / 4 failed — never the same three or four specs twice, and `deadline.spec.ts` (this task's own) was among the failures exactly once. Every failing spec passed when re-run alone at `--workers=1` (7 re-runs in total, across both rounds). See §4 for what one of those reruns actually found underneath the noise. |

The isolation number (223 cases / 20 files) is unchanged from Task 10's own.
The unit count has a real history, not a flat one: Task 8 measured 552/552
across 38 files; Task 10 added 26 new cases in
`tests/unit/movement-params.test.ts`, bringing it to 597/597 across 40 files;
Task 11 added none — only the one e2e spec. `db:test` grew by nothing over
Task 12's own 953/953: Task 11 touches no migration.

---

## 2. What shipped

| Migration | What |
|---|---|
| `0091_return_pending_enum.sql` | `winner_status.RETURN_PENDING`, `inventory_movement_type.RETURN_PENDING_CANCEL` |
| `0092_return_pending_transitions.sql` | the ledger's `RETURN_PENDING_CANCEL` arm; `apply_winner_transition` widened to four arguments and four new arcs |
| `0093_reopen_pickup_deadline.sql` | permission `winners.reopen_deadline`; `reopen_pickup_deadline(p_winner_id, p_deadline_at, p_reason)` |
| `0094_sweep_pickup_deadlines.sql` | `sweep_pickup_deadlines()` (procedure) + `cron.schedule('pickup-deadline-sweep', '0 * * * *', ...)` |
| `0095_list_pickups.sql` | `list_pickups` — one keyset page of every winner across every promotion of a Station |
| `0096_list_movements.sql` | `list_movements` — one keyset page of a Station's whole stock ledger |
| `0097_cancelled_draw_awards_nothing.sql` | `apply_winner_transition` refuses every transition on a cancelled draw's winner (22023) |

TypeScript: `src/services/pickups.ts`, `src/services/movements.ts`;
`src/app/(app)/pickups/*` (page, grid, filters, actions, access, errors,
reopen-form, list-params); `src/app/(app)/inventory/movements/*` (page, grid,
filters, errors, list-params); the Inventory nav split into **Stock** and
**Movements**, a new **Pickups** item under Promotions
(`src/lib/auth/shell.ts`); `availableWinnerActions`
(`src/components/draws/winner-actions.tsx`) widened to require `drawStatus`;
`decodeCursor` (`src/lib/keyset.ts`) now rejects a non-uuid cursor id;
`src/lib/supabase/database.types.ts` regenerated.

**Migrations `0091`–`0097` are this block's own** — nothing older was edited in
place, unlike 6c's relationship to 6a/6b. `0094` and `0095` were each edited in
place once **within this branch**, before either was reviewed and merged
elsewhere (Task 5's cancelled-draw exclusion, Task 9's `draw_status` column) —
the same append-only-across-merges rule 6c and 4b both state.

---

## 3. The decisions, and where they landed

| Decision | Where it is enforced |
|---|---|
| D1 — an expired deadline moves the stock, resting in `pending_return` | `winner_status.RETURN_PENDING`; `apply_winner_transition`'s `RETURN_PENDING` branch emits one `RETURN_PENDING` movement, not the two-step return's pair |
| D2 — the way back is the deadline reopening | `apply_winner_transition`'s `AWAITING_PICKUP`-from-`RETURN_PENDING` branch; `RETURN_PENDING → DELIVERED` was never wired |
| D3 — reopening is the one thing that may write `deadline_at` | a guard at the top of `apply_winner_transition`: any other transition passing a non-null `p_deadline_at` is refused with `22023` before it reaches a branch that would ignore the argument |
| D4 — reopening is its own permission | `winners.reopen_deadline`, checked inside `reopen_pickup_deadline` and nowhere folded into `winners.return` |
| D5 — the clock is SQL, scheduled directly | `sweep_pickup_deadlines()`, `SECURITY INVOKER`, no application code, no HTTP, no dependency on the WhatsApp worker's tick |
| D6 — one poisoned winner must not stop every Station | a procedure, one `commit` per winner inside its own exception block; `12b_deadline_sweep.test.sql` proves it — see §5.5 for what that proof actually depends on |
| D7 — both new lists are `SECURITY DEFINER` and re-state every rule | `list_pickups` (4 rules + the cancelled-draw exclusion) and `list_movements`, both re-implementing Station scope, the archived-promotion rule and the blocked/anonymised-listener behaviour by hand; both exercised by `tests/isolation/pickups.test.ts` in the same task that wrote them |
| D8 — `decodeCursor` is fixed here | `src/lib/keyset.ts`'s `decodeCursor` now returns `null` for a non-uuid id instead of forwarding it to Postgres |
| the owner's mid-block ruling — a cancelled draw awards nothing | `0097`: `apply_winner_transition` refuses every transition on a cancelled draw's winner; `list_pickups` and `sweep_pickup_deadlines` independently exclude cancelled draws from their own candidate sets (Task 5), so the sweep never even attempts the doomed move |

---

## 4. What Task 11 added, and what it found

**The e2e spec** (`tests/e2e/deadline.spec.ts`) seeds a Station, a prize, a
promotion, a listener and a draw through the real RPCs, exactly as the
sibling specs in this suite do. From there:

1. A direct Postgres connection, as `postgres` — the migration-owning role,
   the same target `draw-flow.spec.ts` already uses and for the identical
   reason (`tests/local-supabase.ts`'s own `LOCAL_SUPABASE_DB_URL`) — sets the
   winner's `deadline_at` to an hour ago and `CALL`s
   `sweep_pickup_deadlines()`. **Not through the service-role client**: Task 4
   revoked its `EXECUTE` deliberately (a `service_role` call fails every
   winner, is swallowed by the sweep's own broad handler, and returns success
   having done nothing), and separately no PostgREST client can invoke a
   transaction-controlling `PROCEDURE` at any privilege. The harness already
   carries a `pg` dependency (`draw-flow.spec.ts` uses it to close a
   promotion directly), so no new dependency was added.
2. An operator (the Station's owner, who holds every permission including
   `promotions.view`, `winners.reopen_deadline` and `winners.deliver`) opens
   `/pickups`, filters to **Return pending**, finds the row, reopens the
   deadline three days out with a reason, watches it move to **Awaiting
   pickup**, then hands the prize over and watches it move to **Delivered**.
3. `/inventory/movements`, filtered to the one prize, reads back **six**
   rows, not four — `record_stock_entry` and `link_prize_to_promotion` in the
   fixture setup each write their own movement (`MANUAL_ENTRY`,
   `PROMOTION_LINK`) before anyone ever wins anything. The **newest four**
   are the block's own claim, DOM-order reversed because `list_movements`
   sorts newest first: `Delivered to winner`, `Deadline reopened`, `Pending
   return`, `Draw`. Each is asserted against its own `<td>` rather than a
   substring of the row, because `RETURN_PENDING`'s own label ("Pending
   return") is also a fragment of the neighbouring `RETURN_PENDING_CANCEL`
   row's `From → To` cell — a `toContainText` over the whole row would not
   have discriminated between the two. The test also asserts the actor
   column: `(deadline)` for the sweep's own row and `Unnamed operator` for
   the other three (the owner's profile carries no `full_name` in this
   fixture) — proof, not narration, that the sweep's row really does carry no
   human actor while the surrounding three do.

Asserting **six**, not the brief's four, is not a weakening of step 8's
assertions — every one of the four causal rows is still checked, in order,
each against its own cell. It is a correction to an assumption the brief
carried into the fixture: a prize has a ledger from the moment it is
registered, not from the moment it is first won.

**Discovery worth carrying forward for whoever runs this spec again in this
same terminal session:** the invitation-acceptance path
(`src/services/invitations.ts`) rate-limits at 10 accepted invitations per
hour, keyed on the caller's IP address — which every local Playwright request
reports as the literal string `"unknown"`, so every spec that accepts an
invitation shares one bucket. Running the full suite, then re-running
individual specs, several times in one session exhausted it and produced
`members-flow.spec.ts` and `roles-flow.spec.ts` failures whose signature
(`/invite/<token>?error=failed` instead of `/login`) looks nothing like the
compile-timeout signature this block's e2e diagnosis already documented.
Confirmed by reading `public.rate_limit_counters` directly: the key for
`"unknown"` held `count = 11` against a limit of 10. Clearing that row (a
`delete` local to the test database) made both specs pass immediately, with
no other change. Not a defect in this block or any other — a real limiter
doing exactly what it is for — but worth knowing before reporting either spec
red from a long verification session rather than a single run.

---

## 5. Concerns

### 5.1 Nothing notifies anybody

The clock moves the stock in silence. An operator finds out from the
`/pickups` screen, not from a message. The reminder the owner actually wants —
sent *before* a deadline expires, so there is still something to act on — is a
**Station-initiated** message, days after the draw, outside WhatsApp's
24-hour customer-service window, which Meta will accept only as an
**approved template**. That path does not exist in this codebase yet. Block
5a foresaw exactly this gap, verified verbatim in
`src/lib/integrations/whatsapp/graph.ts`:

> Block 6's first Station-initiated message — a draw result — will need a
> template, and this method is not it.

It moves to the Templates block (agreed with the owner 2026-08-03): a
`template` column on `outbox_messages`, a template-shaped `claim_outbox_messages`
rewrite, `sendTemplate` on the transport, and a runbook for registering and
getting a template approved — roughly the size of this whole block, and a
platform door rather than a deadline feature.

### 5.2 `get_draw` and `list_pickups` disagree about who may read a listener's name, on purpose

`get_draw` (Block 6a/6c) returns a winner's name to anyone holding
`promotions.view` at the Station — the owner's ruling there was that whoever
may see a draw may see who won it. `list_pickups` (this block) returns the
name **only** to a caller who also holds `members.view`, folding 6c's
stricter rule for `list_participations` forward: a wide list with a search
box is a different threat model from one narrow draw the caller already
reached. This is recorded rather than silently inherited (design spec D7) —
picking the looser rule by accident would have widened audience exposure
across every promotion in a Station. `get_draw` is the odd one out and stays
that way; nothing in this block changed it.

### 5.3 `reopen_pickup_deadline` answers `42501` where its 6b siblings answer `P0002` — and the existence leak is a bigger number than this project has been quoting

`return_prize` and `write_off_prize` (Block 6b) read the winner first, raise
`P0002` when it is missing, and only then check the permission — which tells
an unauthorised caller whether an id exists before telling them they may not
see it. `reopen_pickup_deadline` (0093) declines to add to that: its existence
check is folded into the same `42501` a missing permission would raise, so an
unknown winner id and a Station the caller holds nothing in are
indistinguishable from outside. This fixes none of the older doors — it only
declines to open one more.

**How many older doors, exactly, is a number this project has been repeating
without ever counting.** 6c's report said "eight migrations"; the 6d design
spec (§7.2) and the plan's Global Constraints repeated it; Task 3 discovered
mid-block that a rough scan (files where a permission check follows a
`P0002` raise) returns roughly twenty, which itself over-counts because a
file can define several functions and a function can be redefined by a later
file. Counted properly for this report, by locating each function's
**current** (latest-superseding) definition across every migration and
comparing, within that one definition, the line of its first "not found"
`P0002` raise against the line of its first permission check
(`has_permission`, `has_org_permission`, `member_reachable`,
`is_platform_admin`, `is_owner`, `is_owner_of_company` or
`has_company_access`):

- **45** currently-defined functions raise `P0002` for a missing row before
  any permission check in the same body;
- **5** check permission first (`add_company`, `provision_customer`,
  `reactivate_company`, `reset_provisional_password`, `suspend_company` — all
  platform-admin-gated, none scoped to a caller-supplied Company/Station id in
  the same way);
- **9** raise `P0002` with no permission check in the same body at all —
  private helpers called from inside an already-gated `SECURITY DEFINER`
  caller (`apply_inventory_movement`, `apply_member_creation`,
  `apply_participation`, `apply_winner_transition`, `resolve_or_create_member`),
  or self-scoped operations with no caller-supplied target
  (`complete_password_change`, `complete_whatsapp_conversation`,
  `enqueue_whatsapp_outbound`, `record_whatsapp_refusal`).

Neither "eight" nor "twenty" survives this count. **This block adds no new
instance either way**: `list_pickups` and `list_movements` raise only
`42501`, and `reopen_pickup_deadline` folds its own existence check into
`42501` rather than adding a 46th door. The number this report is leaving
behind is 45, measured by the method above, not a headcount repeated a fourth
time without being checked.

### 5.4 `decodeCursor` is fixed — in the one place, not in each caller

Task 7 rewrote `decodeCursor` (`src/lib/keyset.ts`) to reject any id that
does not parse as a uuid, returning `null` — the function's own existing
contract, "a bad cursor starts the list over, never an error page" — instead
of forwarding a hand-edited `?after=` straight to Postgres as a raw id and
coming back `22P02`. The fix lives in `decodeCursor` itself, so no keyset
screen that calls it carries the hole any more, present or future — a screen
does not have to remember to guard its own cursor, because the shared
function it must already call to get one does. Grep for `decodeCursor(` to
see which screens hold that invariant today; it is not restated here as a
count, because this block's own history is why: this report's own first
draft of this section put a number here — "six" — and got it wrong twice
over, both against its own body text and against the code, which is exactly
the pattern §5.3 above describes and exactly what stating the invariant
instead of the count is meant to stop happening a fourth time. Task 7 also
caught and fixed four tests in `tests/unit/keyset.test.ts` that fed non-uuid
ids through the real `decodeCursor` and were quietly asserting the hole
rather than closing it.

### 5.5 D6's proof is coupled to the sweep's own raise-on-failure

The pgTAP proof that the sweep commits per winner rather than as one
transaction (`12b_deadline_sweep.test.sql`) discriminates on
`count(distinct xmin)` over two winners that both expire in the same run,
*combined with* `sweep_pickup_deadlines` raising an exception at the end of
the loop whenever any winner failed. Task 4's own fix history is explicit
about why: an earlier, simpler version of the same assertion
(`count(distinct xmin) = 2`) was found vacuous by mutation — a subtransaction
takes its own xid whether or not it commits, so removing both `commit`
statements left the count unchanged. What actually discriminates is the pair
together: with the commits removed, the end-of-loop raise aborts the
*enclosing* transaction, undoing the neighbour's otherwise-uncommitted work;
with commits present, the neighbour's row survives regardless. **Remove the
raise this block added for the `cron.job_run_details` finding (§5.6) and the
poisoned-winner proof goes vacuous again**, silently, with no committed test
that would catch it. Anyone touching that raise in a later block needs to
know this before touching it.

### 5.6 One permanently-broken winner makes the hourly job record `failed` every hour, forever

`cron.job_run_details` does not capture a `WARNING` — measured directly
against this project's own `pg_cron`: a disposable job that only raises a
warning and a notice still records `status=succeeded`. So
`sweep_pickup_deadlines` raises an exception at the end of its loop whenever
`v_failed > 0`, after every succeeding winner is already committed — that is
the only thing that reaches `cron.job_run_details` at all. The consequence is
structural, not hypothetical: a winner whose movement can never succeed (a
Station's stock genuinely out of balance for that prize, say) stays
`AWAITING_PICKUP` and overdue forever, so every future run re-selects it,
re-fails it, and re-raises. **The job will report `failed` every hour, for
ever, from the moment one winner gets stuck** — not once, and not
self-resolving. Block 11's §31 alert has to be designed for a *chronically
red* job with one bad row inside an otherwise-clean run, not for a one-shot
failure that a human investigates once and moves on from. An alert that pages
on every `failed` status without distinguishing "new failure" from "the same
known winner, again" will be muted within a week.

### 5.7 The sweep's privilege argument was measured on the local container

`sweep_pickup_deadlines` carries no `SECURITY DEFINER` and checks no
permission of its own; the argument for why that is safe is that `pg_cron`
runs a scheduled job **as the role that called `cron.schedule()`** — which,
on this local stack, is the migration-running role, `postgres`, the owner of
`apply_winner_transition` and everything beneath it. Task 4's review verified
this by reading `proacl` from the catalog on the local container: `postgres`
and `service_role` only, nobody else. **This holds only if a hosted
deployment also applies its migrations as the owning role.** A hosted
redeploy that ran migrations as some other, lower-privileged role would
change which role `cron.schedule()` was called by, and therefore which role
the sweep runs as in production — the whole safety argument is conditional on
that operational fact, not on anything the SQL itself guarantees.

### 5.8 An orphan comment in `0079_cancel_draw.sql`, predating this block

`0079_cancel_draw.sql:9` still reads: *"6a has no vocabulary for
'un-awarded', and SUPERSEDED means something else that 6b will define."*
Verified still present, unchanged. `SUPERSEDED` was a `winner_status` value
6a declared and 6c withdrew (Block 6c's own report); nothing ever gave it
the meaning this comment promises, and nothing now will, because the value
it refers to no longer exists. This block did not create the orphan and does
not need to fix it — `0079` belongs to 6a, already merged — but it is the
kind of stale comment this block's own report keeps warning readers about
elsewhere (§5.3, §5.4), so it is named here rather than left for a fourth
block to independently rediscover.

### 5.9 `0094` cannot be safely re-applied as written, and only part of it is idempotent

`sweep_pickup_deadlines` is declared with `create procedure`, not `create or
replace procedure`. Verified directly against this project's own local
container: re-running the whole file a second time fails at that first
statement —

```
ERROR:  function "sweep_pickup_deadlines" already exists with same argument types
```

— which is not a corruption risk (the existing procedure is left exactly as
it was), but does mean **the file as a whole is not what re-applies it**.
The trailing `cron.unschedule(...)`/`cron.schedule(...)` pair, by contrast, is
written to be idempotent on purpose (unschedule-if-exists, then schedule) and
was observed re-applying cleanly even after the earlier statement's error —
so a second run of this file surfaces an error and leaves the *schedule*
correctly configured regardless, but does **not** change the procedure's
body. A hosted redeploy that needs to alter `sweep_pickup_deadlines` itself
cannot do it by re-running `0094`; it needs a new migration written as
`create or replace procedure`. This was flagged during Task 4 as a deferred
design question for the owner and dropped from earlier drafts of this
report; it belongs here because it is exactly the kind of gap between "this
migration applied once, successfully" and "this migration is safe to
re-apply" that a hosted-deployment runbook has to get right the first time.

### 5.10 `list_participations` takes unvalidated uuid parameters straight from the URL

Found by Task 7 while re-grounding this block's own `22P02` comments, and
verified now rather than left as it was flagged: `list_participations`
(0090) declares `p_promotion_id` and `p_option_id` as `uuid`-typed parameters,
and `src/app/(app)/participations/list-params.ts` passes the raw
`?promotion=`/`?option=` query-string values straight through
(`raw.promotion?.trim() || undefined`) with no uuid-shape check —
`src/services/participations.ts` sends them to the RPC as-is. A malformed
value fails to cast at the RPC boundary and raises `22P02`, which
`mapParticipationError` already maps to a `ValidationError` — the same code
family `decodeCursor`'s own hole used to leak before this block fixed it. This
is the same class of defect one layer down (a filter parameter rather than a
cursor id) and it is not this block's function to fix — `list_participations`
belongs to Block 6c. Recorded here, next to `decodeCursor`'s own history, so
it does not have to be rediscovered a third time.

### 5.11 The e2e suite's concurrency behaviour, confirmed again

Task 10 diagnosed, and this task's own two full `--workers=4` runs confirm:
a run at default (14-worker) concurrency against the local `next dev` server
is not a trustworthy gate, and even at `--workers=4` a full run can surface a
handful of navigation-timeout failures that have nothing to do with the code
under test. Two consecutive runs this task made produced 24/3 and 23/4
splits, on different specs each time (`deadline.spec.ts` itself failed in
exactly one of the two, passing clean alone both times it was tried in
isolation and once inside a clean full run). Every failing spec in both
rounds passed when re-run alone. `npm run test:e2e` — the default-concurrency
form — was not used to draw any conclusion in this block; `--workers=4`,
followed by isolating and re-running anything red, is the form this report's
own numbers rest on.

### 5.12 An observed characteristic, not a finding: e2e cleanup fails silently, and compounds §4's rate-limiter note

`deadline.spec.ts`'s own `afterAll` — copied faithfully from
`draw-flow.spec.ts` and `delivery-flow.spec.ts`, which share the identical
line — calls `admin.auth.admin.deleteUser(id)` for every user id the fixture
created, without checking the returned `error`. Deleting an Organization's
sole owner trips the `organization_memberships_keep_owner` constraint
trigger (`0011`/`0016`: "an organization must keep at least one owner"), so
that specific `deleteUser` call fails — and nothing in any of these three
specs notices. This predates Task 11 and is not this task's defect to fix,
but it is worth recording precisely: it is one of the named causes in the
isolation suite's own cleanup log (`cleanupUsers: could not delete N
user(s), left behind in auth.users (non-cascading FKs from
audit_logs/companies/invitations/roles, or an Organization's sole owner
tripping the "at least one owner" trigger)`), and it compounds §4's
rate-limiter finding above: every test run that fails to clean up its owner
leaves a fully-provisioned Organization behind in the local container, and
every one of those Organizations was, at some point, an invitation accepted
from `"unknown"`. The two are independent mechanisms feeding the same
symptom — a local container that accumulates state across a long session —
and either alone would eventually produce a failure that looks unrelated to
the code being tested.

---

## 6. Deferred

- The Templates block: the deadline reminder, the approved-template
  registry, and the System/Interaction/Meta Templates screens (§5.1).
- Block 11's §31 alerting design must account for §5.6 above.
- A hosted-deployment audit of which role applies migrations, before §5.7's
  argument can be trusted outside this local container.
- `0079_cancel_draw.sql:9`'s orphan `SUPERSEDED` comment (§5.8) — Block 6a's
  to fix, if anyone does; harmless but stale.
- A follow-up migration rewriting `0094`'s procedure as `create or replace
  procedure` before a hosted redeploy ever needs to change
  `sweep_pickup_deadlines`'s body (§5.9).
- `list_participations`'s unvalidated uuid parameters (§5.10) — Block 6c's to
  fix.
- The advisory-lock overlap question Task 4 raised for the owner (no guard
  against two sweep runs overlapping on an hourly schedule) — noise, not
  corruption, per Task 4's own review, but still open.

---

## 7. Not done

**The PR is not open.** The owner decides when it opens.
