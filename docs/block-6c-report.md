# Block 6c — The filtered hat, and no runners-up — Verification Report

**Date:** 2026-08-03
**Branch:** `block-6c` (cut from `block-6b`)
**Spec:** `docs/superpowers/specs/2026-08-02-block-6c-filtered-hat-design.md`
**Plan:** `docs/superpowers/plans/2026-08-02-block-6c-filtered-hat.md`
**Migrations:** `0089`, `0090`; `0075`, `0076`, `0078`, `0080`, `0088` edited in place

A draw becomes what it always should have been: a shuffle over a list the
operator filtered and can see, in which nobody wins twice in one promotion and
nobody wins on a wrong answer unless somebody with the permission decided so.
Runners-up leave the product.

---

## 1. Gates

Measured on this branch at the end of the block, not copied from 6b.

| Gate | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm test` (Vitest) | **541** cases, 37 files |
| `npm run db:test` (pgTAP) | **877** cases, 12 files |
| `npm run test:isolation` | **216** cases, 19 files, guard-complete |
| `CI=1 npx playwright test --workers=1` | **26** passed |
| `npm run build` | clean; `/participations` 7.65 kB, 120 kB first load |

Block 6c's own arithmetic, because two of those totals went **down** as well as
up: 43 pgTAP assertions in the new `11_filtered_hat.test.sql` against 3 removed
from `09_draws.test.sql` (+40); 10 new Vitest cases in `answer-filter.test.ts`
against 7 deleted from `draw-algorithm` and `run-draw-dialog` (+3); 3 isolation
cases in `draw.test.ts`; 1 Playwright journey. 18 commits.

---

## 2. What shipped

| Migration | What |
|---|---|
| `0075_draw_tables.sql` *(edited)* | `draw_runners_up`, `draws.runner_up_count` and `winner_status.SUPERSEDED` **removed**; `draws.offered_count` and `draws.included_wrong_answers` added; permission `draws.include_wrong_answers` |
| `0076_draw_eligibility.sql` *(edited)* | `draw_eligible_participations` excludes anybody who already won in this promotion |
| `0078_run_draw.sql` *(edited)* | `run_draw` loses `p_runner_up_count` and gains `p_participation_ids`; validation, the permission derivation and the two new columns; the runner-up walk deleted |
| `0080` / `0088` *(edited)* | `get_draw` loses `runners_up`; `list_draws` loses `runner_up_count` |
| `0089_participation_correctness.sql` | `promotion_participation_correctness` |
| `0090_list_participations.sql` | the participants list, as one `SECURITY DEFINER` function |

TypeScript: `src/lib/participations/answer-filter.ts`;
`src/app/(app)/participations/draw-panel.tsx`; `collectDrawHat` and the rewritten
`listParticipationsPage` in `src/services/participations.ts`; `runDraw` gains a
hat; the two answer filters and the "Won here" column on the participants
screen; `/participations` moved to the Audience section of the sidebar; and
every operator-facing string on the draws and delivery screens translated.

**Migrations `0075`–`0088` were edited in place**, per the plan: they belong to
Blocks 6a and 6b, neither merged and neither ever run against a production
database. `npm run db:reset && npm run db:test` is the proof, and it was re-run
after every such edit.

---

## 3. The decisions, and where they landed

| Decision | Where it is enforced |
|---|---|
| D1 — no runners-up | the tables, columns, enum value, walk and field are gone; `09_draws.test.sql` asserts each **absence**, because a removal nothing tests is a removal somebody re-adds |
| D2 — the hat is supplied | `run_draw(p_promotion_id, p_units, p_participation_ids)`; the freeze filters by the supplied set |
| D3 — a moved list refuses the draw | `apply_draw` counts the rejected ids and raises `22023` naming how many; never drops them |
| D4 — one person, one prize per PROMOTION | a term inside `draw_eligible_participations`, mutation-proven; read by the list and by `run_draw`, so the set the operator sees and the set the database accepts cannot drift |
| D5 — the two answer filters AND | `list_participations`, and `describeAnswerFilter` says "and" rather than "or" |
| D6 — an unanswered question is not a right answer | the `left join` in `promotion_participation_correctness`, mutation-proven |
| D7 — the permission is derived from the hat | `draw_hat_has_wrong_answers` read inside `run_draw`; there is no flag the caller can send, mutation-proven |
| D8 — the Draw button sends the filtered ids | `collectDrawHat` → `runDrawFromListAction` → `p_participation_ids` |
| D9 — English everywhere an operator looks | every string on the draws and delivery surfaces; the WhatsApp copy a **listener** reads is untouched |

**Mutation testing: five run, each restored byte-identical and re-run green.**
What each one actually turned red, rather than what it was expected to:

| Mutation | Went red |
|---|---|
| `left join` → `inner join` in `promotion_participation_correctness` | **two** cases, not one — the half-answered participation and the one that answered nothing. The same rule caught twice, which is more than the plan predicted. Every other case in the file passes either way. |
| drop `d2.status <> 'CANCELLED'` from the eligibility term | exactly the cancelled-draw case |
| the wrong-answer gate in `run_draw` → literal `false` | exactly one case — *"a hat holding somebody who answered wrongly needs the chief, even with no filter at all"*. A permission that cannot be shown to refuse anybody is decoration; this one refuses. |
| drop `deleted_at is null or is_owner_of_company(...)` from `list_participations` | exactly the two archived-promotion cases added in Task 8, and nothing else |
| drop the already-won skip from `collectDrawHat` | the Playwright journey's second-round hat reads **2 entries** instead of **1**, and nothing else |

---

## 4. Deviations from the plan, recorded

**4.1 The participants list had to become an RPC, and the plan did not know it.**
Task 5 assumed `list_participations` was "a read that already has four filters"
gaining two more. It was not a function at all: it was a PostgREST query with an
embed (`member_company_links.members`), a keyset cursor and a search over the
listener's name and phone. Neither cheap route survives — a view cannot carry
the foreign key PostgREST needs to embed the listener, which **is** the search;
and returning matching ids to filter with `.in()` puts a promotion's whole
participation list into a URL. Put to the owner, who chose the function. The
spec §5 was amended in place rather than left describing a smaller change.

**4.2 `offered_count` cannot do the job the spec gave it.** See §5.2.

**4.3 The Draw button reads the hat when the panel OPENS, not when the button is
pressed.** The plan said "calls `runDraw` with the filtered ids" and left where
they come from unstated. The screen renders 25 rows of a keyset page, so the
browser does not hold the filtered set; something has to fetch it. Fetching it
at press time would make the operator approve a *description* — "everybody
matching these filters, whoever that turns out to be in a moment" — and an entry
recorded while they read the summary would join a draw they never saw it in.
Fetching it when the panel opens is what makes D3's refusal message
("the list has moved, open it again") mean anything at all.

**4.4 The hat is capped at 5000 and the cap refuses rather than truncates.** Not
in the plan. The ids travel out of the database, into a server action's result,
into the browser, back through a second action and into a `uuid[]`; an unbounded
set eventually meets a limit somewhere in that chain with no sentence attached
to it. Reaching the cap refuses, because a hat quietly cut to a size nobody
chose is exactly the draw an operator would go on describing as "everyone who
answered". Drawing among everybody is still available with no cap from the
promotion's own draws screen, and the refusal says so.

**4.5 Two exclusions happen in the browser's proposal, and are counted.**
`collectDrawHat` drops rows that are not `VALID` and rows whose listener has
already won here, and reports how many of each. Both are visible on the screen
already — the status badge and the "Won here" column — and sending them would
refuse **every** draw made from the default filters the moment a promotion has a
second round. This is not the silent narrowing D3 forbids: the number the
operator approves is stated before they approve it. Anything the screen cannot
see — blocked, erased — still reaches `run_draw` and still refuses it.

**4.6 The Portuguese fix took the timezone with it.** Task 7 was a translation.
6a rendered every instant on the draws route with `toLocaleString('pt-BR')` and
**no timezone**, so an operator in another state read a draw as having happened
an hour from when the Station ran it — spec L2, which every other screen obeys
through `formatInstant`. The language and the zone are the same call. Fixed
together, with the Station's zone read alongside the two reads the page already
made.

---

## 5. Concerns

### 5.1 The hat is now proposed by the browser

Before this block a draw's hat was computed entirely in Postgres from the
promotion id. Now a client sends a list of participation ids and the database
draws over it. That is a real widening of what a caller decides, and it is worth
being precise about what stands between it and a forged draw.

**Every id is validated against `draw_eligible_participations` before anything
is frozen**, inside the same transaction that holds `FOR UPDATE` on the
promotion. An id from another promotion, an entry that did not count, a blocked
or erased listener, or somebody who already won here — each refuses the whole
draw with `22023`. So the worst a hostile caller can do is draw over a **subset
of the genuinely eligible**, which is exactly what the feature is for.

What that leaves is a narrowing nobody outside can see: an operator holding
`draws.execute` can name three of forty eligible entries and produce a draw that
looks, in the record, exactly like a promotion that only ever had three. The
answer is not cryptographic and is not meant to be — it is that `draw_entries`
freezes **who was in the hat**, permanently, so the question a listener actually
asks ("was I in it?") always has an answer. The question "why were only these
three?" has none, and §5.2 is the same problem seen from the other end.

This is not the same shape as the permission gate: `draws.include_wrong_answers`
is derived from the hat's own contents rather than claimed by the caller, so a
browser cannot dodge it by lying about what it sent.

### 5.2 Measured: `offered_count` and `entry_count` can never differ

The plan asked this report to record that "`offered_count` and `entry_count`
differing is the only in-database sign that a draw was filtered". Having built
it, that sentence is false, and the column is nearly useless.

`offered_count` is `array_length(p_participation_ids, 1)`, defaulting to
`entry_count` when no list was supplied. But **every supplied id must be
eligible or the draw is refused** (D3), and the hat is exactly the supplied set
intersected with the eligible set — so after the refusal check the two are the
same number by construction. They can differ only if a caller sends the same id
twice, which is a defect rather than a signal.

Left as the spec specifies it (§3.2), because changing what a column means is
the owner's call and not the implementer's. What would actually record "this
draw was filtered" is a count of how many participations were eligible **at the
moment of the draw**, against which `entry_count` could be compared. That is one
more `count(*)` over a function `apply_draw` already calls. Recommended if the
distinction is ever wanted; not done here.

### 5.3 Measured: the isolation suite caught what pgTAP and the type checker could not

`list_participations` became `SECURITY DEFINER`, which means it inherits none of
the RLS it replaced and every rule has to be restated by hand. Task 5 restated
two of them and missed a third: `0044`'s promotions policy hides an **archived**
promotion from everybody but the platform admin and the Organization's owner,
and `0053`'s participations policy inherited that for free through its
`promotion_id in (select id from public.promotions)` sub-select. For the length
of five commits, every delegate could read an archived promotion's entries.

Nothing else would have found it. pgTAP tested the function's own filters;
`tsc` and ESLint have no opinion about a policy; the Playwright journey uses one
live promotion. The isolation suite ran once, at Task 8, and failed on the case
that had been asserting this since Block 4c. The rule is now restated in `0090`
and pinned from **both** sides in pgTAP — the delegate who must not see it and
the owner who must — because asserting only the exclusion would be satisfied by
hiding it from the owner too.

**The lesson is about when the suite is run, not about the suite.** It is not in
the per-commit gate because it takes three minutes; this block ran it once, at
the end of the second-to-last task, and paid five commits of latency for a live
hole. A SQL change that moves a boundary — and a `SECURITY DEFINER` function is
always one — deserves the isolation suite in the same round it is written.

### 5.4 A read that used to answer empty now refuses

Asking `list_participations` about a Station the caller holds no role in raises
`42501` where the old query returned an empty page. That is deliberate — a
function that has to ask the permission itself can afford to answer, and an
empty page is indistinguishable from "nobody has entered there" — and the
isolation case that pinned the old behaviour now pins the new one and says why.

Recorded as a concern rather than a decision because it is a **behaviour change
to a read that Block 3b shipped**, made in passing by a rewrite that was
supposed to be adding two filters. Nothing leaks: the caller named the Station,
so the refusal tells them only what they supplied. And the screen never asks
this question, because `listCompanyAccess` offers only Stations the caller can
view and a stale `companyId` falls back to the first of those.

### 5.5 The draw does not refresh the list it was run from

`runDrawFromListAction` calls no `revalidatePath`, on this codebase's standing
rule: re-running a keyset list throws away the operator's place in it. So after
a draw, the "Won here" column behind the panel still shows what it did a moment
ago, and the winners are named in the panel instead. The runbook says so in
words. The alternative — revalidate, and lose the page somebody was reading — is
worse, but this is a screen that is knowingly one fact behind until refreshed.

### 5.6 Inherited, unchanged

The isolation flake (Block 4b) did not appear this block: every full run came
back guard-complete on the first attempt. It remains live and uncaused.

The error-code existence leak (`P0002`/`42501` answered before the permission
gate) is unchanged at eight migrations — this block's two add no new instance of
it, and `0090`'s `42501` names only the Station the caller supplied.

`decodeCursor` still accepts any non-empty string as a cursor id, so a
hand-edited `?after=` reaches Postgres and comes back `22P02` — four screens
share that door and the fix is one change with four callers, which is the
owner's to scope.

None of the three is this block's to fix, and all three are still open.

---

## 6. Deferred to Block 6d

What the clock does: the deadline expiring, the cron that finds overdue winners,
and the notification through `outbox_messages`. The master spec's own words for
it survive N8's withdrawal unchanged — *"processes expired deadlines →
`RETURN_PENDING` + notifies"* — because that never depended on a runner-up.

What an overdue winner then becomes is already built: returned to stock or
written off, by an operator, deliberately (Block 6b).

---

## 7. Not done

**The PR is not open.** The owner decides when it opens. Blocks 6a and 6b are
also still closed, and 6c is branched from 6b.
