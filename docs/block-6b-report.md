# Block 6b — Handing the prize over — Verification Report

**Date:** 2026-08-02
**Branch:** `block-6b` (cut from `block-6a`)
**Spec:** `docs/superpowers/specs/2026-08-02-block-6b-delivery-design.md`
**Plan:** `docs/superpowers/plans/2026-08-02-block-6b-delivery.md`
**Migrations:** `0081`–`0088`

Everything an operator does deliberately with a prize that has been won.

---

## 1. Gates

Measured on this branch at the end of the block.

| Gate | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm test` (Vitest) | **538** cases, 36 files |
| `npm run db:test` (pgTAP) | **837** cases, 11 files |
| `npm run test:isolation` | **213** cases, 19 files, guard-complete |
| `CI=1 npx playwright test` | **25** passed |
| `npm run build` | clean |

Block 6b's own additions: 78 pgTAP assertions in `10_delivery.test.sql`, 8 Vitest
cases in `winner-actions`, 3 isolation cases, 1 Playwright journey, 1 new unit
case on the worker route.

---

## 2. What shipped

| Migration | What |
|---|---|
| `0081_delivery_tables.sql` | `winner_status_history`; the three receipt columns; `winners (id, company_id)`; four permission codes |
| `0082_delivery_movement_type.sql` | `DELIVERY_CANCEL`, alone |
| `0083_delivery_ledger.sql` | both movement checks widened; the projection taught five types |
| `0084_deliver_prize.sql` | `apply_winner_transition` (private), `deliver_prize`, `cancel_delivery` |
| `0085_return_prize.sql` | the core's other two branches, `return_prize`, `write_off_prize` |
| `0086_delivery_receipts.sql` | the private bucket, its two policies, `attach_delivery_receipt` |
| `0087_storage_erasure.sql` | `storage_erasure_queue`; `anonymize_member` extended |
| `0088_draw_reads_delivery.sql` | `get_draw` carries what the screen decides with |

TypeScript: `src/services/winners.ts`, `src/lib/storage/erasure.ts`,
`src/components/draws/winner-actions.tsx`, the receipt form and the wiring
through the draws route.

---

## 3. The decisions, and where they landed

| Decision | Where it is enforced |
|---|---|
| D1 — the receipt is optional and never blocks a delivery | `attach_delivery_receipt` is a separate call; the upload control does not render until the winner is `DELIVERED`; Playwright walks that order |
| D2 — taking a prize back is one step | `return_prize` emits `RETURN_PENDING` + `RETURN_TO_STOCK` in one transaction; `pending_return` never rests; `winner_status` keeps 6a's five values |
| D3 — a delivery can be undone | `DELIVERY_CANCEL`, its own permission, mandatory reason |
| D4 — undoing does not touch the deadline | asserted directly: `deadline_at` read before and after |
| D5 — erasure reaches the receipt | `anonymize_member` clears and enqueues in one transaction; the worker deletes; the isolation case asserts the **file** |
| D6 — four permission codes | four pgTAP cases, each proving one code does not grant another |

---

## 4. Deviations from the plan, recorded

**4.1 The enum needed a migration of its own.** The plan warned that
`ALTER TYPE … ADD VALUE` cannot be used in the transaction that adds it. It
cannot, so `0082` contains one statement and nothing else, and the block runs to
`0088` rather than the plan's `0086`.

**4.2 `get_draw` had to grow.** The plan did not say where the screen would
learn `allows_return_to_stock` from. Without it the Devolver button would be
offered for prizes the RPC then refuses — a screen that teaches operators its
buttons lie. `0088` adds it, plus the receipt fields.

**4.3 The receipt upload control was not in the plan's file list.** The plan
listed `attachDeliveryReceipt` in the service and the actions, and no surface to
call it from. Added to the winner row, rendering only after the delivery.

**4.4 Two pgTAP assertions moved out of the operator's role.** The delivery
operator holds the four `winners.*` codes and nothing about inventory, so reads
of `inventory_movements` and `promotion_prize_balances` come back empty under
RLS — which is correct behaviour, and would have made those assertions pass or
fail for a reason unrelated to what they claim. They run as `postgres`, with the
reason in a comment.

---

## 5. Concerns

### 5.1 An erasure is finished by the worker, and nothing on screen says otherwise

`anonymize_member` clears `receipt_path` and stamps `receipt_erased_at`
immediately; the **file** is deleted on the next worker tick. If the worker
stops, erasures accumulate as recorded-but-unfinished and every screen looks
correct. The runbook (§5) carries the query that shows the backlog. This is the
block's most serious operational obligation and it is invisible by construction.

Deliberately no give-up threshold: a row that keeps failing is retried for ever,
because a queue that empties itself by forgetting is indistinguishable from one
that worked.

### 5.2 Measured: the concurrency case needed its error code, again

With `FOR UPDATE` removed from `apply_winner_transition`, the outcome pair and
both counts were **unchanged** — the ledger's sufficiency check caught the loser
several steps later with `23514` instead of the transition check's `22023`.
Block 6a recorded this exact trap and this block walked into the same shape
before the code assertion was added. Two blocks in a row: a count alone cannot
tell a working lock from a constraint cleaning up after it.

### 5.3 Measured: the projection's decrement is caught twice

Mutating away `drawn = drawn - p_quantity` in `RETURN_TO_STOCK` turns the
figures assertion red **and** trips `promotion_prize_balances_drawn_within_linked`
on the next draw — the CHECK `0045` added with the comment that it belonged in
the schema rather than only inside the RPC. That comment was right.

### 5.4 A third door onto audience data, and the first bucket

Block 6a made `get_draw` a second door onto listeners' names. This block adds a
private bucket holding photographs of them. Both are gated, both are narrow, and
both are places an audit of "who can see the audience" must now visit that are
not Block 3's policies. The storage policies are also the only part of this
schema that pgTAP cannot check at all — `tests/isolation/draw.test.ts` is their
sole live proof.

### 5.5 One receipt slot, and the case it costs

A re-delivered prize cannot be given a second receipt. Chosen because every
alternative destroys something: clearing on undo deletes evidence of a real
handover, replacing silently does the same without saying so. The cost is
accepted and small — the original object shows the same person receiving the
same prize — but it is a rule an operator can hit, and the runbook says so.

### 5.6 Inherited, unchanged

The isolation flake (Block 4b) is still live and still uncaused: one incomplete
run before a clean one this block. The error-code existence leak now crosses
eight migrations. Neither is this block's to fix and both are still open.

---

## 6. Deferred to Block 6d

> Renumbered by Block 6c (2026-08-03). What this section deferred "to 6c" is now
> 6d's: 6c turned out to be the filtered hat, and the clock is what is left.

The deadline expiring, the cron that finds overdue winners, and the notification
through `outbox_messages`.

**Not** promoting a runner-up. Block 6c withdrew runners-up from the product on
the owner's ruling, and `winner_status.SUPERSEDED` went with them — it existed
for exactly that one thing, and `0075` was edited in place to declare four
values rather than five. What happens to an overdue prize is already built here:
an operator returns it to stock or writes it off, and the clock's job is to find
the winner and say so rather than to hand the prize on.

This report's own sentence that `availableWinnerActions` "already returns
nothing for `SUPERSEDED`, so 6c adds a transition rather than re-shaping the
screen" is therefore withdrawn: there is no such status to return nothing for,
and the branch was deleted.

---

## 7. Not done

**The PR is not open.** The owner decides when it opens. Block 6a's PR is also
still closed, and 6b is branched from it.
