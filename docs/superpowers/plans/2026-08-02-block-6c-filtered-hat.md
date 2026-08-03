# Block 6c — The filtered hat, and no runners-up — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A draw becomes what it always should have been — a shuffle over a list the operator filtered and can see, in which nobody wins twice in one promotion and nobody wins on a wrong answer unless somebody with the permission decided so — and runners-up leave the product.

**Architecture:** The hat stops being computed and starts being supplied. `run_draw` receives participation ids, validates every one against a single eligibility definition that now also excludes anybody who already won in this promotion, and derives from the hat's own contents whether the caller needed `draws.include_wrong_answers`. Correctness has one home, read by the list screen to filter and by `run_draw` to gate.

**Tech Stack:** Supabase Postgres 17 (plpgsql, RLS), Next.js App Router server actions, TypeScript strict, Zod, Vitest, pgTAP, Playwright, the isolation harness in `tests/isolation/harness.ts`.

**Spec:** `docs/superpowers/specs/2026-08-02-block-6c-filtered-hat-design.md`. Read it before Task 1. Decision references (D1–D9) point at its §2.

## Global Constraints

- **Everything in English — including the operator's interface.** This is D9, and it is a correction: Blocks 6a and 6b shipped the only Portuguese screens in the application. The only Portuguese in this product is what a **listener** reads on WhatsApp.
- **Vocabulary:** `Station` = a `companies` row, `Organization` = an `organizations` row, `Member`/listener = a `members` row.
- **Migrations `0075`–`0088` are edited IN PLACE.** They belong to Blocks 6a and 6b, neither of which is merged and neither of which has touched a production database. A feature that never shipped does not deserve a migration undoing it. `npm run db:reset` running clean is the proof, and it must be run after every such edit. **New** migrations start at `0089`.
- **Every gate is checked beside its own operation**, never inside a shared helper. Private cores are `SECURITY INVOKER` with EXECUTE granted to nobody.
- **`service_role` needs an explicit grant on every new table**, and `authenticated` needs one for anything a screen reads.
- **The ledger has one writer.** Inventory moves only through `apply_inventory_movement`.
- **No personal data in `audit_logs`.**
- **The gate before every commit:** `npm run lint && npm run typecheck && npm test`, plus `npm run db:test` when SQL changes. On `npm run test:isolation` only a **guard-complete** run counts.
- **After `supabase db reset`, the auth container answers `createUser failed: {}` until the stack is restarted.** Run `npx supabase stop && npx supabase start` before any isolation or Playwright run that follows a reset.
- **`alter type … add value` cannot be used in the transaction that adds it**, and `create or replace function` cannot change an argument list — dropping and recreating is the only way, and an overload left behind raises `42725` at call time.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **This repo sets `noUncheckedIndexedAccess`.**
- **Branch:** `block-6c`, cut from `block-6b`.

---

## File Structure

**Migrations edited in place**

| File | Change |
|---|---|
| `0075_draw_tables.sql` | drop `draw_runners_up`, `draws.runner_up_count`, `winner_status.SUPERSEDED`; add `draws.offered_count`, `draws.included_wrong_answers`; add the fifth permission |
| `0076_draw_eligibility.sql` | `draw_eligible_participations` excludes anybody who already won in this promotion |
| `0078_run_draw.sql` | `run_draw` loses `p_runner_up_count`, gains `p_participation_ids`; `apply_draw` loses the runner-up walk and gains validation, the permission derivation and the two new columns |
| `0080_draw_reads.sql` | `get_draw` loses `runners_up` |
| `0088_draw_reads_delivery.sql` | same, on the version that supersedes it |

**New migrations**

| File | Responsibility |
|---|---|
| `0089_participation_correctness.sql` | `promotion_participation_correctness` |
| `0090_participation_list_filters.sql` | the participants list read, with the two new filters and the already-won column |

**New TypeScript**

| File | Responsibility |
|---|---|
| `src/lib/participations/answer-filter.ts` | the filter's own rules, as pure functions |
| `tests/unit/answer-filter.test.ts` | their cases |

**Modified TypeScript**

| File | Change |
|---|---|
| `src/lib/draw/algorithm.ts` | loses `runnersUp` and `runnerUpCount` |
| `src/services/draws.ts` | loses the queue; `runDraw` takes participation ids |
| `src/components/draws/run-draw-dialog.tsx` | loses the runner-up field; English |
| `src/components/draws/draw-detail.tsx` | loses the queue section; English |
| `src/components/draws/winner-actions.tsx` | English |
| `src/app/(app)/promotions/[id]/draws/*` | English, and the queue removed |
| `src/lib/auth/shell.ts` | `/participations` moves from Promotions to Audience |
| `src/app/(app)/participations/*` | the two filters, the already-won column, the Draw button |

**Modified tests and docs**

`supabase/tests/09_draws.test.sql`, `10_delivery.test.sql`, `tests/isolation/draw.test.ts`, `tests/unit/draw-algorithm.test.ts`, `tests/unit/run-draw-dialog.test.ts`, `tests/e2e/draw-flow.spec.ts`, `tests/e2e/delivery-flow.spec.ts`, `docs/block-6a-*.md`, `docs/block-6b-*.md`, `docs/superpowers/plans/2026-08-02-block-6a-draw.md`.

**Fixture UUID range:** `…00c0xx`–`…00c9xx`. `09_draws` owns `…00a0xx`–`…00a3xx` and `10_delivery` owns `…00b0xx`–`…00b4xx`.

---

### Task 1: Runners-up leave the product

**Files:**
- Modify: `supabase/migrations/0075_draw_tables.sql`, `0078_run_draw.sql`, `0080_draw_reads.sql`, `0088_draw_reads_delivery.sql`
- Modify: `src/lib/draw/algorithm.ts`, `src/services/draws.ts`, `src/components/draws/run-draw-dialog.tsx`, `src/components/draws/draw-detail.tsx`, `src/app/(app)/promotions/[id]/draws/draws-screen.tsx`, `page.tsx`
- Modify: `supabase/tests/09_draws.test.sql`, `10_delivery.test.sql`, `tests/unit/draw-algorithm.test.ts`, `tests/unit/run-draw-dialog.test.ts`, `tests/isolation/draw.test.ts`, `tests/e2e/draw-flow.spec.ts`, `tests/e2e/delivery-flow.spec.ts`

**Interfaces:**
- Produces: `run_draw(p_promotion_id uuid, p_units jsonb default null) returns uuid` — the third parameter is gone and the fourth has not arrived yet; Task 4 adds `p_participation_ids`.
- Produces: `runDrawAlgorithm(input: { seed: string; entries: DrawEntry[]; units: DrawUnit[] }): DrawOutcome` where `DrawOutcome` is `{ winners: { unit: DrawUnit; entry: DrawEntry; awardedRank: number }[] }`.

**This task deletes more than it writes, and the deletions are the deliverable.** Read spec §2 D1 before starting.

- [ ] **Step 1: Write the failing tests — the removal has to be asserted**

In `09_draws.test.sql`, replace every runner-up assertion with assertions that the things are **gone**. A removal nothing asserts is a removal somebody re-adds:

```sql
select ok(not exists (select 1 from pg_class
                       where relname = 'draw_runners_up' and relnamespace = 'public'::regnamespace),
          'there is no runner-up queue: a draw awards prizes and nothing waits behind them');

select ok(not exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = 'draws'
                         and column_name = 'runner_up_count'),
          'and a draw does not record how many runners-up were asked for');

select ok('SUPERSEDED' <> all(enum_range(null::public.winner_status)::text[]),
          'SUPERSEDED is gone: it existed only for a winner whose prize went to a runner-up');
```

Delete the runner-up cases from `09_draws.test.sql` (the "two runners-up" assertion in the happy draw) and from `10_delivery.test.sql`; lower each file's `plan(N)` to what remains. In `tests/unit/draw-algorithm.test.ts` delete every case naming `runnersUp` and every `runnerUpCount` argument. In `tests/unit/run-draw-dialog.test.ts` delete the runner-up ceiling cases. In `tests/isolation/draw.test.ts` delete the queue comparison and the `RUNNER_UPS` constant; the reproduction now compares winners only.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm run db:test` — expected FAIL, because `draw_runners_up` still exists.

- [ ] **Step 3: Cut it out of the migrations**

In `0075_draw_tables.sql`: delete the whole `draw_runners_up` block and its comment; delete `runner_up_count` from `draws` and its CHECK; remove `'SUPERSEDED'` from the `winner_status` enum and rewrite that type's comment, which currently says the five values are 6b's vocabulary; delete the four grant/revoke/policy lines naming `draw_runners_up`.

In `0078_run_draw.sql`: delete `p_runner_up_count` from both `run_draw` and `apply_draw`, the runner-up INSERT, the `v_awarded` bookkeeping that exists only to offset the queue's positions, and the `runner_up_count` column from the `draws` INSERT. The walk stops after the units.

In `0080_draw_reads.sql` and `0088_draw_reads_delivery.sql`: delete the `runners_up` key from `get_draw`'s object and the `runner_up_count` from `list_draws` and `get_draw`.

- [ ] **Step 4: Cut it out of the TypeScript**

`algorithm.ts`: `DrawOutcome` loses `runnersUp`; the input loses `runnerUpCount`; the second walk loop goes. The `takeNext` closure and the awarded `Set` stay — they are what makes one prize per person fall out of the walk.

`services/draws.ts`: `DrawDetail` loses `runnersUp` and `runnerUpCount`; `DrawSummary` loses `runnerUpCount`; `runDraw` loses the argument; `DEFAULT_RUNNER_UP_COUNT` is deleted.

`draw-detail.tsx`: the whole runner-up section goes, and so does the `runnersUp.length` term in the header summary.

`run-draw-dialog.tsx`: the runner-up input, `DRAW_RUNNER_UP_MAX`, and the `runnerUpCount` half of `validateDrawRequest`. Its signature becomes `validateDrawRequest(input: { units: DrawUnitChoice[]; allTaken?: boolean }): DrawRequestResult`.

- [ ] **Step 5: Reset, run everything, and read the count**

```bash
npm run db:reset && npm run db:test
npx supabase stop && npx supabase start
npm run lint && npm run typecheck && npm test
```

- [ ] **Step 6: Commit**

```bash
git add -A supabase src tests
git commit -m "feat(draw): runners-up leave the product

Owner's ruling, 2026-08-02, withdrawing requirement N8 from the master spec.
A draw is a shuffle over a filtered list and each prize goes to one person in
it; a prize nobody collects follows the pickup deadline into a return or a
write-off, which 6b already built. Nothing is promoted, because there is no
queue to promote from.

winner_status.SUPERSEDED goes with it, having existed for exactly one thing.
6a declared all five values arguing that declaring them early cost nothing;
this is what it cost.

The removal is asserted rather than merely performed: a removal nothing tests
is a removal somebody re-adds.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Correctness, with one home

**Files:**
- Create: `supabase/migrations/0089_participation_correctness.sql`
- Create: `supabase/tests/11_filtered_hat.test.sql`

**Interfaces:**
- Produces: `public.promotion_participation_correctness(p_promotion_id uuid) returns table (participation_id uuid, answered_correctly boolean)`, `SECURITY INVOKER`, `stable`, EXECUTE to nobody.

- [ ] **Step 1: Write the failing pgTAP file**

Create `supabase/tests/11_filtered_hat.test.sql` beginning `begin; select plan(N);` with `N` set to the assertions you actually write. Seed in the `…00c0xx` range: a Station, a promotion with **two** QUIZ questions each having one correct option, and participations covering every case:

- answered both correctly → `answered_correctly` true;
- answered one correctly and one wrongly → false;
- answered one correctly and left the other unanswered → **false** (D6: not answering is not getting it right);
- answered nothing at all → false;
- a second promotion with **no** QUIZ question → every participation true;
- a promotion whose only question is `MULTIPLE_CHOICE` → every participation true, because `0041` refuses `is_correct` on anything but a QUIZ and there is nothing to miss.

Plus: `authenticated` holds no EXECUTE on the function.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run db:test`
Expected: FAIL — `function public.promotion_participation_correctness(uuid) does not exist`.

- [ ] **Step 3: Write the migration**

```sql
create function public.promotion_participation_correctness(p_promotion_id uuid)
returns table (participation_id uuid, answered_correctly boolean)
language sql
stable
set search_path = pg_catalog, public
as $$
  select p.id,
         not exists (
           -- One row per QUIZ question this participation did NOT get right:
           -- either it chose an option that is not the correct one, or it did
           -- not answer at all. A left join is what makes the second case
           -- appear; an inner join would silently call an unanswered question
           -- correct, which is the whole of D6 backwards.
           select 1
           from public.promotion_questions q
           left join public.participation_answers a
             on a.participation_id = p.id and a.question_id = q.id
           left join public.promotion_question_options o
             on o.id = a.option_id
           where q.promotion_id = p_promotion_id
             and q.kind = 'QUIZ'
             and coalesce(o.is_correct, false) = false
         )
  from public.participations p
  where p.promotion_id = p_promotion_id;
$$;
```

Read `0041_promotion_questions.sql` before writing this to confirm the column names and that `is_correct` is refused on non-QUIZ kinds; the `q.kind = 'QUIZ'` term rests on that.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test`

- [ ] **Step 5: Mutation-prove the unanswered case**

Change the `left join public.participation_answers` to an inner join, re-run, and confirm **only** the "answered one, left the other unanswered" case goes red. Restore byte-identical and report both outputs. This is the term most likely to be written wrong and the least likely to be noticed, because every other case passes either way.

- [ ] **Step 6: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run db:test
git add supabase/migrations/0089_participation_correctness.sql supabase/tests/11_filtered_hat.test.sql
git commit -m "feat(draw): whether somebody got the quiz right, in one place

0052 said Block 6 would derive correctness at draw time and Block 6a did not.
This is that function, and it has one home because two readers are coming:
the participants list filters on it, and run_draw decides a permission by it.

Not answering a question is not getting it right. That is a left join rather
than an inner one, and it is the term a mutation test is written for -- every
other case passes either way.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Nobody wins twice in one promotion

**Files:**
- Modify: `supabase/migrations/0076_draw_eligibility.sql`, `supabase/tests/11_filtered_hat.test.sql`

**Interfaces:**
- Consumes: `winners`, `draws` (0075).
- Produces: `draw_eligible_participations` with one term added; signature unchanged.

- [ ] **Step 1: Write the failing tests**

Raise the plan and append: a listener who won in a draw of this promotion is **not** in the eligible list; a listener who won in a draw of a **different** promotion **is**; a listener whose winning draw was **cancelled** is back in; a listener whose prize was **returned** or **written off** is still out, because they won and what happened afterwards is a different fact.

The cancelled case needs a draw put into `CANCELLED`. `cancel_draw` (0079) needs `draws.cancel` and a signed-in caller; setting `status`, `cancelled_at`, `cancelled_by` and `cancellation_reason` by hand is enough here and keeps the case about eligibility.

- [ ] **Step 2: Run them to make sure they fail**

- [ ] **Step 3: Add the term**

In `0076_draw_eligibility.sql`, inside `draw_eligible_participations`'s WHERE:

```sql
    -- D4, revising 6a's D2: one person, one prize is now per PROMOTION.
    -- The rule lives here rather than in run_draw so that the list the
    -- operator sees and the hat the database accepts are the same set --
    -- building only the first would need two definitions of who is eligible.
    --
    -- A cancelled draw's winner is eligible again: the draw was undone, so
    -- nothing was won. A winner whose prize came back to stock or was written
    -- off is NOT: they won, and what happened next is a different fact.
    and not exists (
      select 1
      from public.winners w
      join public.draws d2 on d2.id = w.draw_id
      where w.member_id = m.id
        and d2.promotion_id = p_promotion_id
        and d2.status <> 'CANCELLED'
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test`

- [ ] **Step 5: Mutation-prove it**

Delete the `and d2.status <> 'CANCELLED'` line, re-run, and confirm **only** the cancelled-draw case goes red. Restore byte-identical and report both outputs.

- [ ] **Step 6: Run the gate and commit**

---

### Task 4: The hat comes from the screen

**Files:**
- Modify: `supabase/migrations/0075_draw_tables.sql` (two columns, one permission), `0078_run_draw.sql`, `supabase/tests/11_filtered_hat.test.sql`

**Interfaces:**
- Consumes: `promotion_participation_correctness` (Task 2), `draw_eligible_participations` (Task 3).
- Produces: `public.run_draw(p_promotion_id uuid, p_units jsonb default null, p_participation_ids uuid[] default null) returns uuid`; columns `draws.offered_count`, `draws.included_wrong_answers`; permission `draws.include_wrong_answers`.

- [ ] **Step 1: Write the failing tests**

- a draw with `p_participation_ids` naming three of five eligible participations writes exactly three `draw_entries`, and `offered_count` is 3;
- `p_participation_ids` null draws everybody, and `offered_count` equals `entry_count`;
- an id from another promotion is refused (`22023`);
- an id whose listener is blocked is refused (`22023`);
- an id whose listener already won in this promotion is refused (`22023`);
- a hat containing somebody who answered wrongly, drawn by an operator **without** `draws.include_wrong_answers`, is refused (`42501`);
- the same hat drawn by an operator **with** it succeeds and sets `included_wrong_answers` true;
- a hat of only correct answerers succeeds without the permission and sets `included_wrong_answers` false;
- on a promotion with no QUIZ question, a caller without the permission draws anybody and `included_wrong_answers` is false;
- the permission code exists in `permissions`.

- [ ] **Step 2: Run them to make sure they fail**

- [ ] **Step 3: Write it**

In `0075_draw_tables.sql`, on `draws`:

```sql
  offered_count          integer not null,
  included_wrong_answers boolean not null default false,
```

and a fifth permission beside the other draw codes, `display_order` 130:

```sql
  ('draws.include_wrong_answers', 'Draw among listeners who answered the quiz wrongly', '6c', 'promotions', 'Draw among wrong answers', 'company', 130),
```

In `0078_run_draw.sql`, `run_draw` gains `p_participation_ids uuid[] default null` and passes it down. `apply_draw` gains it too, and before the hat is frozen:

```sql
  if p_participation_ids is not null and array_length(p_participation_ids, 1) is not null then
    -- Every supplied id must be eligible. Rejected ids REFUSE THE DRAW rather
    -- than being dropped (D3): a draw over a set the operator never approved,
    -- while they go on saying they drew among the forty-two they saw, is worse
    -- than a refusal they can act on.
    select count(*) into v_rejected
    from unnest(p_participation_ids) as supplied(id)
    where not exists (
      select 1 from public.draw_eligible_participations(p_promotion_id) e
      where e.participation_id = supplied.id
    );

    if v_rejected > 0 then
      raise exception
        '% of the % listed participations can no longer be drawn; the list has moved, refresh it',
        v_rejected, array_length(p_participation_ids, 1)
        using errcode = '22023';
    end if;
  end if;
```

Then the correctness gate, which reads the hat rather than any label:

```sql
  select exists (
    select 1
    from public.promotion_participation_correctness(p_promotion_id) c
    where not c.answered_correctly
      and (p_participation_ids is null
           or c.participation_id = any(p_participation_ids))
      and exists (select 1 from public.draw_eligible_participations(p_promotion_id) e
                   where e.participation_id = c.participation_id)
  ) into v_wrong;
```

`run_draw` checks `has_permission('draws.include_wrong_answers', v_company)` when `v_wrong` and raises `42501` otherwise — beside its own operation, like every other gate here. `apply_draw` writes `offered_count` (the supplied length, or `entry_count` when null) and `included_wrong_answers = v_wrong`.

The hat freeze filters by the supplied set when there is one.

**`run_draw` must be dropped and recreated, not replaced**, because the argument list changes twice over. Leaving the old three-argument overload alive makes every existing call ambiguous and raises `42725` at call time — the trap `0047` documented.

- [ ] **Step 4: Run the tests to verify they pass**

- [ ] **Step 5: Mutation-prove the derivation**

Replace `v_wrong` with a literal `false`, re-run, and confirm **only** the "refused without the permission" case goes red. Restore byte-identical and report both outputs. A permission that cannot be shown to refuse anybody is decoration.

- [ ] **Step 6: Regenerate types, run the gate, commit**

---

### Task 5: The participants list learns to filter

**Files:**
- Create: `supabase/migrations/0090_participation_list_filters.sql`, `src/lib/participations/answer-filter.ts`, `tests/unit/answer-filter.test.ts`
- Modify: `supabase/tests/11_filtered_hat.test.sql`

**Interfaces:**
- Produces: `list_participations` gains `p_answered_correctly boolean default null` and `p_option_id uuid default null`, and returns `already_won boolean` per row; `describeAnswerFilter` and `answerFilterIsUsable` in `answer-filter.ts`.

**Read `src/app/(app)/participations/list-params.ts` and the existing list RPC before writing this**, and follow their keyset shape rather than inventing one. The new arguments are two more filters on a read that already has four.

- [ ] **Step 1: Write the failing tests**

pgTAP: filtering `p_answered_correctly => true` returns only correct answerers; `false` only the others; null returns both. `p_option_id` returns only participations that chose that option. Both together **AND** (D5) — a participation that answered correctly but chose a different option for the named question is absent. `already_won` is true for a listener who has won in this promotion.

Vitest for `answer-filter.ts`: the filter row is unusable without a promotion selected (a question belongs to one promotion, and "correct" means nothing across several), and its description reads correctly for each combination.

- [ ] **Step 2: Run them to make sure they fail**

- [ ] **Step 3: Write it**

- [ ] **Step 4: Run the tests, the gate, and commit**

---

### Task 6: The screen

**Files:**
- Modify: `src/lib/auth/shell.ts`, `src/app/(app)/participations/participations-filters.tsx`, `participations-grid.tsx`, `page.tsx`, `list-params.ts`, `actions.ts`, `access.ts`

**Interfaces:**
- Consumes: Task 5's read, Task 4's `runDraw`.

- [ ] **Step 1: Move the item**

In `src/lib/auth/shell.ts`, move `{ href: '/participations', label: 'Participations', icon: ICONS.ticket }` out of the Promotions section and into Audience, beside Members. One line moved; the icon and label do not change.

- [ ] **Step 2: Write the failing tests**

Playwright: an operator opens Participations from the Audience section of the sidebar, filters to correct answerers, and sees fewer rows than unfiltered.

- [ ] **Step 3: Build the filters and the column**

The correct/wrong/all control renders only when the selected promotion has a QUIZ question; the question+option control renders only when a promotion is selected. An `already won` column marks the rows that the draw will refuse.

- [ ] **Step 4: Build the Draw button**

It opens the run-draw dialog — prizes and quantities, no runner-up field after Task 1 — and calls `runDraw` with the filtered ids. On success it shows the winners.

- [ ] **Step 5: Run the gate and commit**

---

### Task 7: English, everywhere an operator looks

**Files:**
- Modify: `src/components/draws/run-draw-dialog.tsx`, `draw-detail.tsx`, `winner-actions.tsx`, `src/app/(app)/promotions/[id]/draws/draws-screen.tsx`, `page.tsx`, `src/app/(app)/promotions/prizes-tab.tsx`, `tests/e2e/draw-flow.spec.ts`, `delivery-flow.spec.ts`

**This is D9 and it is a correction, not a feature.** Blocks 6a and 6b shipped the only Portuguese screens in the application.

- [ ] **Step 1: Translate**

Every operator-facing string in those files. The table in the spec's D9 discussion is the vocabulary: Draw, no deadline, View receipt, Write off, Return to stock, receipt erased at the listener's request, Undo delivery, Reason, Attach receipt, Runners-up (deleted anyway), Draws of this promotion.

Do **not** touch: `outbox_messages` bodies, the WhatsApp conversation copy, or anything a listener reads. Those are Portuguese on purpose.

- [ ] **Step 2: Fix the Playwright specs that assert Portuguese**

`draw-flow.spec.ts` and `delivery-flow.spec.ts` locate by `data-testid` mostly, but `getByLabel('Motivo')` and `getByRole('button', { name: 'Confirmar' })` name Portuguese. Update both.

- [ ] **Step 3: Run the gate and both e2e specs, then commit**

---

### Task 8: The boundary and the round, end to end

**Files:**
- Modify: `tests/isolation/draw.test.ts`, `scripts/verify-isolation-suite.mjs`

- [ ] **Step 1: Write the failing tests**

A whole round as a signed-in operator: filter to correct answerers through the list RPC, draw with those ids, then run a **second** round and assert the first winner is no longer in the list and that supplying their id is refused. And: a hat containing a wrong answerer refused for an operator without `draws.include_wrong_answers`, accepted for one with it.

- [ ] **Step 2: Run them to make sure they fail**

- [ ] **Step 3: Make them pass**

- [ ] **Step 4: Raise the floor, run the guard, commit**

`npm run test:isolation` — guard-complete only. If it comes back incomplete, re-run: the Block 4b flake is still live and uncaused, and the fix is the flake, never the guard.

---

### Task 9: Runbook, report, and the documents that still promise runners-up

**Files:**
- Create: `docs/block-6c-runbook.md`, `docs/block-6c-report.md`
- Modify: `docs/block-6a-runbook.md`, `docs/block-6a-report.md`, `docs/block-6b-runbook.md`, `docs/block-6b-report.md`, `docs/superpowers/plans/2026-08-02-block-6a-draw.md`

- [ ] **Step 1: Correct the older documents**

6a's runbook explains the runner-up queue and its report lists D4. 6b's runbook mentions promoting a runner-up as 6c's job. All of it is now false. Correct it in place with a line saying when and why, the way the master spec was struck — a runbook that describes a feature nobody can find is worse than one that admits it was withdrawn.

- [ ] **Step 2: The runbook**

How to filter a list and draw over it; what correct/wrong means and what an unanswered question counts as; why somebody disappears from the list between rounds; which permission the wrong-answer draw needs and what it does not cover; and the refusal messages with what to do about each.

- [ ] **Step 3: The report**

Follow `docs/block-6b-report.md`. Measured numbers, run rather than copied. The Concerns section at minimum: that the hat is now proposed by the browser and what stands between that and a forged draw; that `offered_count` and `entry_count` differing is the only in-database sign that a draw was filtered; and whatever the implementation found.

- [ ] **Step 4: Run the whole gate and record the real numbers**

```bash
npm run lint && npm run typecheck && npm test && npm run db:test && npm run test:isolation && CI=1 npx playwright test --workers=1
```

Clear `public.rate_limit_counters` before the Playwright run.

**Do not open the PR** — the owner decides when it opens.

---

## Self-Review

**Spec coverage.** D1→Task 1 (and Task 9 for the documents). D2→Task 4. D3→Task 4's rejection count. D4→Task 3. D5→Task 5. D6→Task 2. D7→Task 4's derivation and its mutation. D8→Task 6's Draw button, resting on Task 1 having removed the runner-up field. D9→Task 7. Spec §3.1→Task 1; §3.2→Task 4; §3.3→Task 2; §3.4→Task 3; §3.5→Task 4; §4→Task 4; §5→Tasks 5 and 6; §6→Tasks 3 and 4; §7→Tasks 2, 3, 4, 5, 8; §8 is the out-of-scope list.

**One gap found while reviewing, and closed here rather than left to the implementer:** the spec says `offered_count` is NOT NULL and equals `entry_count` when no list was supplied, but `draws` rows already exist in every test fixture that inserts one by hand — `09_draws.test.sql` and `10_delivery.test.sql` both do. Adding a NOT NULL column with no default breaks them. **Task 4 must give `offered_count` a default of 0 in the column definition, or update every hand-written `draws` insert.** Prefer updating the inserts: a default of 0 would let a real draw record a lie if the write ever forgot the column.

**A second:** Task 1 removes `SUPERSEDED` from an enum. `alter type … drop value` does not exist in Postgres — the value can only go by recreating the type. Since `0075` is edited in place and the database is reset from scratch, the enum is simply declared with four values and nothing needs dropping. Stated because an implementer who reaches for `drop value` will not find it.

**Type consistency.** `promotion_participation_correctness` returns `(participation_id, answered_correctly)` in Task 2 and is consumed under those names in Tasks 4 and 5. `run_draw`'s final signature is declared in Task 4 and used by Task 6. `validateDrawRequest`'s reduced signature is declared in Task 1 and consumed in Task 6.
