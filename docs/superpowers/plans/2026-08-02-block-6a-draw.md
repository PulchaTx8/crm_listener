# Block 6a — The draw, and the deadline it freezes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A promotion's winners are picked, the prize moves in the inventory, a deadline starts running — and anybody holding the record can recompute the same winners.

**Architecture:** The draw is one keyed sort and a walk. `sha256(seed || ':' || participation_id)` ranks every frozen entry; the walk hands each prize unit to the next entry whose listener has not already won, then keeps walking for the runners-up. It executes in plpgsql inside the transaction that consumes the stock, and is **independently re-implemented in TypeScript as a verifier** — the two must agree, which is what makes the audit claim real rather than circular.

**Tech Stack:** Supabase Postgres 17 (plpgsql, RLS), Next.js App Router server actions, TypeScript strict, Zod, Vitest, pgTAP, Playwright, the isolation harness in `tests/isolation/harness.ts`.

**Spec:** `docs/superpowers/specs/2026-08-02-block-6a-draw-design.md`. Read it before Task 1. Decision references (D1–D8) point at its §2.

## Global Constraints

- **Everything in English** — code, comments, identifiers, commit messages. The only Portuguese is what an operator or a listener reads on screen.
- **Vocabulary:** `Station` = a `companies` row, `Organization` = an `organizations` row, `Member`/listener = a `members` row.
- **Migrations are sequential. The next free number is `0075`.** Never edit a migration applied outside a local stack; within this unmerged branch, editing in place is sanctioned with a clean `supabase db reset` as the proof.
- **Every gate is checked beside its own operation**, never inside a shared helper. Private cores are `SECURITY INVOKER` with EXECUTE granted to nobody — the pattern `apply_participation` (0054) and `participation_status_for` (0069) established.
- **`service_role` needs an explicit grant on every new table**, and `authenticated` needs one for anything a screen reads. This schema revokes Supabase's default ACL and grants back by hand. Block 5a shipped three tables with the comment and without the grant and was non-functional end to end.
- **The ledger has one writer.** Inventory moves only through `apply_inventory_movement` (0027/0047). No table this block adds may write `inventory_movements`, `inventory_balances` or `promotion_prize_balances` directly.
- **No personal data in `audit_logs`.** Block 3's rule, absolute. A draw's audit row carries ids and counts, never a name or a phone.
- **The gate before every commit:** `npm run lint && npm run typecheck && npm test`, plus `npm run db:test` when SQL changes. On `npm run test:isolation` only a **guard-complete** run counts.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **This repo sets `noUncheckedIndexedAccess`.** In tests `toBe(v)`/`toEqual(v)`/`toBeNull()` are safe with optional chaining; `toBeUndefined()`/`toBeFalsy()` can pass vacuously on an empty array.
- **Branch:** `block-6a`, cut from `block-5b` because migrations `0065`–`0074` are unmerged. Rebase onto `main` once PR #19 lands.

---

## File Structure

**New migrations**

| File | Responsibility |
|---|---|
| `supabase/migrations/0075_draw_tables.sql` | `winner_status`, `draw_status`; `draws`, `draw_entries`, `winners`, `draw_runners_up`; the deadline columns; the two permission codes |
| `supabase/migrations/0076_draw_eligibility.sql` | `draw_eligible_participations` — the one definition of who is in the hat |
| `supabase/migrations/0077_run_draw.sql` | `run_draw` and its private core |
| `supabase/migrations/0078_cancel_draw.sql` | `cancel_draw` |
| `supabase/migrations/0079_draw_reads.sql` | `list_draws`, `get_draw` |

**New TypeScript**

| File | Responsibility |
|---|---|
| `src/lib/draw/algorithm.ts` | The verifier: the same contract, re-implemented, so agreement means something |
| `src/services/draws.ts` | `runDraw`, `cancelDraw`, `listDraws`, `getDraw` |
| `src/app/(app)/promotions/[id]/draws/page.tsx` | The draws of one promotion |
| `src/components/draws/run-draw-dialog.tsx` | How many of each prize, how many runners-up, and the button |
| `src/components/draws/draw-detail.tsx` | Winners, runners-up, the seed and the deadline |

**Modified**

| File | Change |
|---|---|
| `src/lib/supabase/database.types.ts` | regenerated after every migration |
| `scripts/verify-isolation-suite.mjs` | the new isolation file and its floor |

---

### Task 1: The tables, the deadline, and who may draw

**Files:**
- Create: `supabase/migrations/0075_draw_tables.sql`
- Create: `supabase/tests/09_draws.test.sql`

**Interfaces:**
- Produces: types `public.draw_status` (`COMPLETED`, `CANCELLED`) and `public.winner_status` (`AWAITING_PICKUP`, `DELIVERED`, `RETURNED`, `WRITTEN_OFF`, `SUPERSEDED`); tables `draws`, `draw_entries`, `winners`, `draw_runners_up`; columns `prizes.default_pickup_deadline_days`, `promotions.pickup_deadline_days`; permission codes `draws.execute`, `draws.cancel`.

- [ ] **Step 1: Write the failing pgTAP file**

Create `supabase/tests/09_draws.test.sql` beginning `begin; select plan(18);`. Assert, in this order: the two enums exist with exactly the values above (`has_type`, and `enum_range` compared to an array literal); each of the four tables exists; RLS is enabled on all four; `authenticated` holds `SELECT` on `draws` and `winners` and **no** `TRUNCATE` on any of the four; `service_role` holds `SELECT, INSERT` on `draws`; both new permission codes exist in `permissions`; a negative `default_pickup_deadline_days` is refused (`throws_ok`, `23514`); and a `draws` row carrying `cancelled_at` without `cancellation_reason` is refused (`23514`).

Seed fixtures with UUIDs in the `…0009xx` range so they cannot collide with `08_conversation`'s `…0008xx`/`…0009xx` block — **use `…00a0xx`** if `09xx` is already taken there; check before writing.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run db:test`
Expected: FAIL — `type "public.draw_status" does not exist`.

- [ ] **Step 3: Write the migration**

`0075_draw_tables.sql`, in this order:

1. The two enums.
2. `draws`:

```sql
create table public.draws (
  id              uuid primary key default gen_random_uuid(),
  promotion_id    uuid not null,
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,

  -- 64 hex characters, generated inside run_draw and never an argument (D3):
  -- a seed a caller could choose is a seed a caller could shop for.
  seed              text not null check (seed ~ '^[0-9a-f]{64}$'),
  algorithm_version integer not null,
  runner_up_count   integer not null check (runner_up_count >= 0),
  entry_count       integer not null check (entry_count > 0),

  status      public.draw_status not null default 'COMPLETED',
  drawn_at    timestamptz not null default now(),
  drawn_by    uuid references auth.users (id),

  cancelled_at        timestamptz,
  cancelled_by        uuid references auth.users (id),
  cancellation_reason text,

  constraint draws_promotion_fk
    foreign key (promotion_id, company_id)
    references public.promotions (id, company_id),
  constraint draws_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  -- The shape rule this schema uses everywhere: a cancellation is three facts
  -- or none of them. Without it a row can claim it was cancelled and not say
  -- by whom or why, which is the one thing a cancelled draw has to say.
  constraint draws_cancellation_shape check (
    (cancelled_at is null and cancelled_by is null and cancellation_reason is null)
    or (cancelled_at is not null and cancelled_by is not null
        and length(btrim(coalesce(cancellation_reason, ''))) > 0)
  ),
  constraint draws_cancelled_status check (
    (status = 'CANCELLED') = (cancelled_at is not null)
  ),
  constraint draws_id_company_unique unique (id, company_id)
);
```

3. `draw_entries` — `draw_id`, `participation_id`, `member_id`, `position integer not null check (position > 0)`, primary key `(draw_id, position)`, plus `unique (draw_id, participation_id)`. Composite FK to `draws (id, company_id)` carrying `company_id`.
4. `winners` — `id`, `draw_id`, `promotion_prize_id`, `member_id`, `participation_id`, `awarded_rank integer not null check (awarded_rank > 0)`, `deadline_at timestamptz`, `status public.winner_status not null default 'AWAITING_PICKUP'`, `unique (draw_id, awarded_rank)`, and **`unique (draw_id, member_id)` — D2 made structural**, so one person cannot hold two prizes from one draw even if a future edit to the walk forgets.
5. `draw_runners_up` — `draw_id`, `position`, `member_id`, `participation_id`, primary key `(draw_id, position)`, and `unique (draw_id, member_id)` for the same reason.
6. The deadline columns, both `integer` with `check (… is null or … > 0)`, on `prizes` and `promotions`, each with a comment saying null means no deadline (spec §6) and that the promotion's value overrides the prize's.
7. RLS on all four, a `select` policy for `authenticated` gated on `has_permission('promotions.view', company_id)` — reading a draw is reading a promotion — and the grants: `select` to `authenticated`, `select, insert` to `service_role`, `revoke truncate` from `service_role`, `revoke all` from `anon`.
8. The permission rows:

```sql
insert into public.permissions (code, description, introduced_by_block, module, label, scope, display_order)
values
  ('draws.execute', 'Run a promotion''s draw', '6a', 'promotions', 'Sortear', 'company', 250),
  ('draws.cancel',  'Cancel a draw that has already run', '6a', 'promotions', 'Cancelar sorteio', 'company', 260);
```

Check `0015`/`0040` for the exact column set of `permissions` before writing this, and copy their `module`/`scope` vocabulary rather than inventing one.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test`
Expected: `09_draws.test.sql` 18 of 18.

- [ ] **Step 5: Regenerate types, run the gate, commit**

```bash
npm run db:types
npm run lint && npm run typecheck && npm test
git add supabase/migrations/0075_draw_tables.sql supabase/tests/09_draws.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(draw): the hat, the winners, and a deadline that cannot move

winners carries unique (draw_id, member_id): one person, one prize per draw
is the owner's rule and it is structural here rather than only inside the
walk, so a future edit to the algorithm cannot quietly break it.

The deadline columns default to null, which means no deadline. A Station that
has not configured one has not agreed to a rule, and inventing thirty days
for them would start a clock they never set.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Who is in the hat

**Files:**
- Create: `supabase/migrations/0076_draw_eligibility.sql`
- Modify: `supabase/tests/09_draws.test.sql`

**Interfaces:**
- Produces: `public.draw_eligible_participations(p_promotion_id uuid) returns table (participation_id uuid, member_id uuid, participated_at timestamptz)`, `SECURITY INVOKER`, `stable`, EXECUTE for nobody.

- [ ] **Step 1: Write the failing tests**

Raise the plan and append cases covering, each with its own listener so a failure names one rule: a `VALID` participation is in; a `DUPLICATE`, a `TOO_SOON` and an `OVER_LIMIT` are each out; a soft-deleted listener is out; an anonymised listener is out; a listener under a live `draw_ban` is out; a listener under a live `suspension` is out (D6); and a listener whose block was **lifted** is back in. Then: two participations by one listener both appear — **D1, and the case the whole weighting rule rests on**.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run db:test`
Expected: FAIL — `function public.draw_eligible_participations(uuid) does not exist`.

- [ ] **Step 3: Write the function**

A single `select` joining `participations` to `members`, filtering `status = 'VALID'`, `m.deleted_at is null`, `m.anonymized_at is null`, and `not public.is_member_blocked(m.id, p.company_id)` — read `is_member_blocked`'s signature in 0032 and match it exactly; do not re-express what a block is. Ordered by `(participated_at, id)`, which is the order Task 4 freezes as `position`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test`

- [ ] **Step 5: Mutation-prove the block filter**

Remove the `is_member_blocked` call, re-run, and confirm **both** block cases go red and nothing else does. Restore byte-identical and report both outputs. A draw that quietly includes banned listeners is the defect this block would be least forgiven for.

- [ ] **Step 6: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run db:test
git add supabase/migrations/0076_draw_eligibility.sql supabase/tests/09_draws.test.sql
git commit -m "feat(draw): one definition of who is in the hat

Both kinds of block exclude, on the owner's ruling: somebody suspended is not
eligible for anything. is_member_blocked already answers this and stays the
only thing that answers it.

Two participations by one listener are two entries, which is D1 and the case
every other rule in this block leans on.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The algorithm, as a function with no database

**Files:**
- Create: `src/lib/draw/algorithm.ts`
- Create: `tests/unit/draw-algorithm.test.ts`

**Interfaces:**
- Produces:

```ts
export const DRAW_ALGORITHM_VERSION = 1;

export interface DrawEntry {
  participationId: string;
  memberId: string;
  /** 1..N, the frozen order. Ties in the ranking value are broken by it. */
  position: number;
}

export interface DrawUnit {
  promotionPrizeId: string;
  unitIndex: number;
}

export interface DrawOutcome {
  winners: { unit: DrawUnit; entry: DrawEntry; awardedRank: number }[];
  runnersUp: { entry: DrawEntry; position: number }[];
}

export function runDrawAlgorithm(input: {
  seed: string;
  entries: DrawEntry[];
  units: DrawUnit[];
  runnerUpCount: number;
}): DrawOutcome;
```

**This is the verifier, and it is deliberately a second implementation of the same rule.** Everywhere else this project insists a rule has one home; here two independent implementations are the point, because a verifier that shared code with the executor would prove only that the code equals itself. Task 5 is what holds them together.

- [ ] **Step 1: Write the failing tests**

Cover: the same seed and the same entries give the same winners, run twice; a different seed gives a different order (assert the winner list differs for a fixture with enough entries that agreement by chance is negligible — say 50 entries, 3 units); **one listener with three entries wins at most one unit**; a hat of two entries against three units awards two winners and reports no third; runners-up continue past the winners and never repeat a listener; `runnerUpCount: 0` yields none; and ties in the ranking value fall back to `position` (construct this by feeding two entries whose participation ids you have chosen to collide — if you cannot construct a real collision, assert the comparator directly instead and say so in a comment rather than faking one).

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/unit/draw-algorithm.test.ts`
Expected: FAIL — cannot resolve `@/lib/draw/algorithm`.

- [ ] **Step 3: Write it**

```ts
import { createHash } from 'node:crypto';

function rank(seed: string, participationId: string): Buffer {
  return createHash('sha256').update(`${seed}:${participationId}`, 'utf8').digest();
}
```

Sort a copy of `entries` by `Buffer.compare(rank(a), rank(b))`, falling back to `a.position - b.position`. Then walk: for each unit in the order given, take the next entry whose `memberId` is not already in a `Set` of awarded members; stop when the entries run out. Continue the same walk for `runnerUpCount` more.

Mutating the caller's array is a defect — sort a copy. The function reads no clock and no environment.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/draw-algorithm.test.ts`

- [ ] **Step 5: Mutation-prove the skip**

Remove the awarded-member `Set` check and confirm the "one listener wins at most one unit" case fails and only it. Restore byte-identical; report the output.

- [ ] **Step 6: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/lib/draw/algorithm.ts tests/unit/draw-algorithm.test.ts
git commit -m "feat(draw): the contract, written where it can be run a thousand times a second

One keyed sort and a walk: sha256(seed:participation_id) ascending, ties
broken by the frozen position, skipping anybody already awarded. One prize per
person falls out of the walk rather than being enforced beside it.

A SECOND implementation of a rule this project otherwise insists has one
home, and deliberately: a verifier that shared code with the executor would
prove only that the code equals itself.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Running the draw

**Files:**
- Create: `supabase/migrations/0077_run_draw.sql`
- Modify: `supabase/tests/09_draws.test.sql`

**Interfaces:**
- Consumes: Task 2's eligibility function; `apply_inventory_movement(p_company_id, p_prize_id, p_type, p_quantity, p_from, p_to, p_note, p_idempotency_key)` (0027).
- Produces: `public.run_draw(p_promotion_id uuid, p_units jsonb, p_runner_up_count integer default 3) returns uuid`, `SECURITY DEFINER`, EXECUTE to `authenticated`.

`p_units` is `[{"promotion_prize_id": "…", "quantity": 2}, …]`. Null or empty means **every unit still available on every live link** — `linked - drawn` from `promotion_prize_balances` (D8).

- [ ] **Step 1: Write the failing tests**

pgTAP: a draw over a promotion with three eligible listeners and one unit writes one `winners` row, three `draw_entries`, a `draws` row whose `seed` matches `^[0-9a-f]{64}$`, and moves `promotion_prize_balances.drawn` from 0 to 1; asking for more units than `linked - drawn` is refused (`22023`); a promotion with **no** eligible participation is refused (`22023`) and writes no `draws` row (spec §7 — nothing happened, and a row saying it did is worse than none); the deadline is `drawn_at + promotion days` when the promotion sets one, `+ prize days` when only the prize does, and **null** when neither does; a caller without `draws.execute` gets `42501`; and two listeners with three entries each, one unit, produce exactly one winner.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm run db:test`

- [ ] **Step 3: Write it**

`run_draw` checks `has_permission('draws.execute', company_id)` beside its own operation, takes `FOR UPDATE` on the promotion row (the shape `link_prize_to_promotion` (0049) uses, which serialises every draw and every link against that promotion), then delegates to a private `apply_draw` core that:

1. resolves the unit list, defaulting to `linked - drawn` per live link, and raises `22023` naming the shortfall if any link cannot cover what was asked;
2. inserts `draws` with `seed = replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')` and `algorithm_version = 1`;
3. freezes the hat: `insert into draw_entries … select …, row_number() over (order by participated_at, participation_id) from public.draw_eligible_participations(p_promotion_id)`, and raises `22023` if it inserted none;
4. computes the order with `order by sha256(convert_to(d.seed || ':' || e.participation_id::text, 'UTF8')), e.position`;
5. walks it, awarding one unit at a time and skipping members already awarded — `distinct on (member_id)` over the ordered list gives each listener's best entry in one pass, and the walk then takes the first N of that;
6. writes `winners` with `awarded_rank` = the unit's position in the ordered unit sequence, and `deadline_at = now() + make_interval(days => coalesce(promo.pickup_deadline_days, prize.default_pickup_deadline_days))` — null when both are null;
7. writes `draw_runners_up` from the next rows of the same list;
8. issues one `apply_inventory_movement(company, prize, 'DRAW', 1, 'linked', 'awaiting_pickup', …)` **per winner**, with `p_idempotency_key = draw_id || ':' || awarded_rank`;
9. writes one `audit_logs` row carrying `draw_id`, `promotion_id`, counts and the algorithm version — **no member id and no name**.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test`

- [ ] **Step 5: Mutation-prove the ordering**

Replace the `sha256(...)` ordering with `order by e.position` and confirm the seeded-order cases fail. Restore byte-identical. Then remove the `FOR UPDATE` and confirm Task 8's concurrency case fails — if it does not, that case is not reaching the contested code and must be fixed before this task is called done.

- [ ] **Step 6: Run the gate and commit**

```bash
npm run db:types
npm run lint && npm run typecheck && npm test && npm run db:test
git add supabase/migrations/0077_run_draw.sql supabase/tests/09_draws.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(draw): the hat is frozen in the transaction that consumes the stock

The entries are written before anything is drawn and the units are taken
under FOR UPDATE on the promotion, so two draws cannot read one hat and both
spend the same unit.

A promotion with nobody eligible is refused rather than recorded as an empty
draw: nothing happened, and a row saying it did is worse than none.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The two implementations must agree

**Files:**
- Create: `tests/isolation/draw.test.ts`
- Modify: `scripts/verify-isolation-suite.mjs`

**Interfaces:**
- Consumes: `run_draw` (Task 4), `runDrawAlgorithm` (Task 3).

**This is the task the block's audit claim rests on.** If the SQL and the TypeScript ever disagree, "anybody can recompute the winners" is false, and nothing else in the suite would notice.

- [ ] **Step 1: Write the failing test**

Seed a promotion with **at least 30 eligible participations across at least 12 listeners** and 3 linked units — enough that an accidental agreement is not plausible. Run `run_draw` through the real RPC as a signed-in operator holding `draws.execute`. Read back `draws.seed`, `draw_entries` ordered by `position`, and the unit sequence. Feed them to `runDrawAlgorithm` and assert the winners and the runner-up queue match **in order**, by `participation_id`.

Repeat the whole thing three times with fresh promotions, so a single lucky seed cannot carry it.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run test:isolation`
Expected: FAIL — cannot resolve the module, then a genuine mismatch until Task 4's ordering matches Task 3's exactly.

- [ ] **Step 3: Make them agree**

If they disagree, the likeliest causes in order: the SQL orders by the bytea digest while TypeScript compares a hex string (compare bytes on both sides); the seed is concatenated with a different separator; the tie-break is missing on one side; the unit sequence differs. Fix whichever side is wrong against the spec §4.1, which is the contract — not whichever is easier to change.

- [ ] **Step 4: Add the file to the manifest and run the guard**

Run: `npm run test:isolation` — guard-complete only.

- [ ] **Step 5: Commit**

```bash
git add tests/isolation/draw.test.ts scripts/verify-isolation-suite.mjs
git commit -m "test(draw): the executor and the verifier, held to each other

Thirty entries, twelve listeners, three units, three fresh promotions. The
draw runs in Postgres and is recomputed in TypeScript from nothing but the
stored seed and the frozen hat, and the two lists must match in order.

Without this the audit claim is a sentence in a spec: two implementations
that have never been compared are two implementations that differ.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Cancelling a draw

**Files:**
- Create: `supabase/migrations/0078_cancel_draw.sql`
- Modify: `supabase/tests/09_draws.test.sql`

**Interfaces:**
- Produces: `public.cancel_draw(p_draw_id uuid, p_reason text) returns void`, `SECURITY DEFINER`, EXECUTE to `authenticated`, gated on `draws.cancel`.

- [ ] **Step 1: Write the failing tests**

Cancelling returns every unit (`promotion_prize_balances.drawn` back to 0, one `DRAW_CANCEL` movement per winner); the `draws` row is `CANCELLED` with all three cancellation columns set; **the winners, the entries and the seed are still there** (D7 — the record of a cancelled draw is the evidence it was cancelled); a blank reason is refused (`22023`); cancelling twice is refused (`22023`); a caller holding `draws.execute` but not `draws.cancel` gets `42501`; and — the guard 6b will need — cancelling a draw one of whose winners is not `AWAITING_PICKUP` is refused (`22023`), set up by moving one winner to `DELIVERED` by hand.

- [ ] **Step 2: Run them to make sure they fail**

- [ ] **Step 3: Write it**

Permission check, `FOR UPDATE` on the draw, the refusals above, one `apply_inventory_movement(…, 'DRAW_CANCEL', 1, 'awaiting_pickup', 'linked', …)` per winner with `p_idempotency_key = draw_id || ':cancel:' || awarded_rank`, the three cancellation columns and the status in one statement, and an audit row.

Winners are left `AWAITING_PICKUP` rather than given a new status: 6a has no vocabulary for "un-awarded", and `SUPERSEDED` means something else 6b will define. The `draws.status` is what says the draw is void.

- [ ] **Step 4: Run the tests, mutation-prove, gate, commit**

Mutation: drop the "not all winners are AWAITING_PICKUP" refusal and confirm that case, and only it, goes red. Restore byte-identical.

---

### Task 7: The screen

**Files:**
- Create: `supabase/migrations/0079_draw_reads.sql`, `src/services/draws.ts`, `src/app/(app)/promotions/[id]/draws/page.tsx`, `src/components/draws/run-draw-dialog.tsx`, `src/components/draws/draw-detail.tsx`
- Modify: `supabase/tests/09_draws.test.sql`, and the promotion page's navigation

**Interfaces:**
- Produces: `list_draws(p_promotion_id uuid)` and `get_draw(p_draw_id uuid)`, both `SECURITY DEFINER` gated on `promotions.view`; `runDraw`, `cancelDraw`, `listDraws`, `getDraw` in `src/services/draws.ts`, each taking an access token exactly as `src/services/members.ts` does.

- [ ] **Step 1: Write the failing tests**

pgTAP for the two reads: a draw is visible to somebody with `promotions.view` at that Station and invisible across Stations. Vitest for the dialog's own rule: it may not offer more units than are available, and it refuses a runner-up count below zero.

- [ ] **Step 2: Run them to make sure they fail**

- [ ] **Step 3: Build it**

Follow the record-dialog pattern (`docs/superpowers/specs/2026-07-29-record-dialog-pattern-design.md`) rather than inventing a layout. The detail view shows the winners with their deadline, the runner-up queue in order, and — plainly, not hidden behind a toggle — **the seed and the algorithm version**, because a proof nobody can see is not a proof.

- [ ] **Step 4: Run the tests, the gate, and commit**

- [ ] **Step 5: Add a Playwright case**

An operator opens a closed promotion, runs a draw, and sees the winners. Follow `tests/e2e/`'s existing sign-in helper.

---

### Task 8: The boundary, and two draws at once

**Files:**
- Modify: `tests/isolation/draw.test.ts`, `scripts/verify-isolation-suite.mjs`

- [ ] **Step 1: Write the failing tests**

**The boundary, per Block 5a's hardest lesson.** For each of the four new tables, drive the exact read or write the application issues through the harness's `admin` client and through a signed-in operator, and assert it succeeds. pgTAP runs as `postgres` and cannot see a missing grant.

**Two draws at once, twelve rounds.** One promotion, one unit, two `run_draw` calls fired with `Promise.all`. Exactly one succeeds; the other is refused for want of stock. Assert `promotion_prize_balances.drawn` is 1 and that exactly one `winners` row exists — a count alone cannot tell "the lock worked" from "the constraint caught what the lock should have prevented", so assert both the outcome pair and the count, the way `participations.test.ts` does.

- [ ] **Step 2: Run them to make sure they fail**

- [ ] **Step 3: Make them pass**

- [ ] **Step 4: Raise the isolation floor, run the gate, commit**

---

### Task 9: Runbook and report

**Files:**
- Create: `docs/block-6a-runbook.md`, `docs/block-6a-report.md`

- [ ] **Step 1: The runbook**

How to run a draw and what the operator is choosing; what the seed is for and **how somebody outside the company re-checks a draw** — the exact recipe, with the hash expression written out; what a null deadline means; when a draw can and cannot be cancelled; and how to read `draw_entries` to answer "was I in it?".

- [ ] **Step 2: The report**

Follow `docs/block-5b-report.md`. The gate table carries this block's own measured numbers — run the suites, do not copy. The Concerns section is the part that matters: at minimum, that the algorithm is now a versioned contract nobody may change silently, and whatever the implementation actually found.

- [ ] **Step 3: Run the whole gate and record the real numbers**

```bash
npm run lint && npm run typecheck && npm test && npm run db:test && npm run test:isolation && CI=1 npx playwright test
```

**Do not open the PR** — the owner decides when it opens.

---

## Self-Review

**Spec coverage.** D1→Tasks 2, 3 (the two-entries case and the weighting test). D2→Task 1's unique constraint, Task 3's walk, Task 4's step 5. D3→Task 1's seed CHECK, Task 4's generation, Task 5 entirely. D4→Tasks 3, 4, 7. D5→Task 1's columns and Task 4's step 6. D6→Task 2. D7→Task 6. D8→Task 4's `p_units`. Spec §3→Task 1; §4.1→Tasks 3, 4; §4.3→Tasks 1, 4, 6; §5→Task 2; §6→Tasks 1, 4; §7→Tasks 4, 6, 8; §8→Tasks 2–8; §9 is the out-of-scope list.

**One gap found while reviewing, and closed here rather than left to the implementer:** the spec says a draw may run while the promotion is still open, but says nothing about a **cancelled or archived** promotion. It must be refused — `apply_participation` (0054) already refuses both for an entry, and a draw over a cancelled promotion would award prizes for something that is not happening. **Task 4's step 1 must include those two refusals (`22023` each), and step 3 must check `cancelled_at is null and deleted_at is null` after taking `FOR UPDATE`.**

**Type consistency.** `DrawEntry`, `DrawUnit` and `DrawOutcome` are declared in Task 3 and consumed unchanged in Task 5. `draw_eligible_participations`' three output columns are declared in Task 2 and consumed in Task 4's step 3. `p_units`' shape is declared in Task 4's interface block and consumed by `runDraw` in Task 7.
