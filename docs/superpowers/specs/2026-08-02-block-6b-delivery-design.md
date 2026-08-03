# Block 6b — Handing the prize over, and taking it back — Design Spec

**Date:** 2026-08-02
**Status:** approved by the owner
**Master spec:** `docs/superpowers/specs/2026-07-25-crm-radios-multitenant-design.md` §6, §17, §18
**Depends on:** Block 6a (`winners`, `winner_status`, the deadline), Block 2 (the ledger), Block 3 (`anonymize_member`), Block 5a (the worker tick)

---

## 1. What this block is for

Block 6a ended at the moment a winner exists: a prize is committed to a person,
a unit sits in `awaiting_pickup`, and a deadline is running. This block is
everything an **operator does deliberately** from there — hands the prize over,
undoes that when it was recorded wrong, or takes the unit back because it is not
going to be collected.

What the **clock** does is Block 6c: the deadline expiring, promoting a
runner-up, and the notification. Nothing in this block reads a clock to decide
anything, and 6c depends on this block rather than the other way round.

Block 6 was split into 6a and 6b on the owner's ruling of 2026-08-02, and 6b was
split again from 6c on 2026-08-02 for the reason 6a's own spec gave: five
subsystems in one pass produce a diff nobody reviews.

---

## 2. Decisions

**D1 — The receipt is optional, and a delivery is never blocked by storage.**
Owner's ruling. `deliver_prize` succeeds with or without an attachment. What
proves a delivery is the ledger movement with its actor and its timestamp, and
that cannot fail for want of a network. A prize that has physically left the
operator's hands and cannot be recorded because a photo upload failed is worse
than a delivery with no photo — the stock would lie until somebody came back to
fix it.

**D2 — Taking a prize back is one step, and the operator names the
destination.** Owner's ruling. The operator says "this is not being collected"
and chooses: back to stock, or written off. `pending_return` is a bucket the
ledger passes **through** inside one transaction and never rests in.

The consequence, stated because it is why this shape was chosen:
`winner_status` was frozen at five values in 6a, and a persistent
"awaiting inspection" state would need a sixth. There is no queue of items to
inspect, because nothing waits.

**D3 — A delivery can be undone.** Owner's ruling. `DELIVERY_CANCEL` moves the
unit `delivered → awaiting_pickup`, carries a mandatory reason and its own
permission — the shape 6a gave `DRAW_CANCEL`, for the same reason: undoing is
not doing. The ledger stays immutable; this is another entry, never an edit.

The alternative considered and rejected: correcting a mis-recorded delivery with
a stock adjustment. It fixes the count and leaves `winners` saying `DELIVERED`
for ever, and that row is the one somebody reads when the listener telephones.

**D4 — Undoing a delivery does not touch the deadline.** Owner's ruling.
`deadline_at` was frozen at the draw (6a's D5) and the delivery never changed
it, so undoing does not either. A winner whose deadline passed while the
delivery stood comes back **already overdue**, and that is 6c's problem to see
and act on. Nothing here invents a new date.

**D5 — Erasure reaches the receipt.** Owner's ruling. A receipt is a photograph
or a signature: personal data, and Block 3's rule is that an erasure is true.
`anonymize_member` clears the path, stamps `receipt_erased_at` and **enqueues
the object for deletion in the same transaction**; the worker that already runs
(`0064`) drains the queue and deletes through the storage API.

The queue exists because of a fact that must not be discovered later: deleting a
row from `storage.objects` in SQL removes the metadata and leaves the file in
the backing store. An erasure implemented in SQL alone would be half an erasure,
and it would look complete.

What survives an erasure: the `DELIVERY` movement, who recorded it and when.
That is a fact about stock, not about a person.

**D6 — Four permission codes.** Owner's ruling: `winners.deliver`,
`winners.deliver_cancel`, `winners.return`, `winners.write_off`. Two separations,
each with a precedent in this codebase: 6a separated `draws.cancel` from
`draws.execute` because undoing is not doing, and Block 2 separated
`inventory.exit` from `inventory.entry` because destroying stock is not adding
it. Writing a prize off destroys value; returning it to stock does not.

---

## 3. The data

### 3.1 `winners`, three new columns

| Column | Why |
|---|---|
| `receipt_path text` | The object's path in the private bucket. Null means no receipt — either none was ever attached, or it was erased. |
| `receipt_uploaded_at timestamptz` | When one was attached. |
| `receipt_erased_at timestamptz` | Set by `anonymize_member`. Distinguishes "never had one" from "had one, and it is gone", which is the difference between a gap and an erasure. |

A shape constraint: `receipt_erased_at is null or receipt_path is null` — a
receipt cannot be both erased and present.

**One slot, and what that means across an undo.** A winner has at most one
receipt. `attach_delivery_receipt` refuses (`22023`) when the slot is already
filled, and `cancel_delivery` **keeps** it.

That combination is deliberate and it is the only one that destroys nothing.
Clearing the slot on an undo would delete a photograph of a real handover
because somebody corrected a record; replacing it silently on a re-delivery
would do the same without even saying so. Keeping it costs one case — a
re-delivered prize cannot be given a second receipt — and that case is not a
real loss: the object depicts the same person receiving the same prize, which is
what a re-delivery is. **The only thing that ever clears this slot is erasure
(§7).**

### 3.2 `winner_status_history`

One row per transition, and the **only** writer is the private core in §4.

| Column | |
|---|---|
| `id`, `winner_id`, `company_id` | tenancy through the composite key to `winners` |
| `from_status`, `to_status` | both `winner_status` |
| `reason text` | **mandatory for `cancel_delivery`, `return_prize` and `write_off_prize`; optional for `deliver_prize`** |
| `changed_by uuid`, `changed_at timestamptz` | |

The asymmetry on `reason` is the point rather than an oversight. Handing a prize
to the person who won it is the thing that was supposed to happen and needs no
justification; a note is offered and may be left empty. The other three each
undo or destroy something somebody was already told about, and a row that does
not say why is the one thing they must say — the same rule 6a put on cancelling
a draw. A CHECK enforces it: `reason` is non-blank whenever `to_status` is not
`DELIVERED`.

No personal data: ids and statuses only. Read under `promotions.view`, the same
gate the draw's own tables carry.

Written by the core rather than by a trigger on `winners`. A trigger would catch
every path including one a future block forgets — but it cannot carry a reason
or an actor without a session variable, and this schema's answer to "who
guarantees coverage" is a single writer, which is what `apply_inventory_movement`
already is for the ledger.

### 3.3 `storage_erasure_queue`

`id`, `bucket`, `path`, `enqueued_at`, `processed_at`, `attempts`,
`last_error`. `service_role` only, RLS on with no policy — the shape
`whatsapp_conversations` (0065) uses.

---

## 4. How a transition happens

Four doors, one private core. The doors are `deliver_prize`, `cancel_delivery`,
`return_prize` and `write_off_prize`; each checks **its own** permission beside
its own operation and then delegates.

A single generic `set_winner_status(winner, new_status, reason)` was considered
and rejected: its gate would have to choose a permission code from an argument,
which `apply_participation` (0054) already refuses to do in as many words —
a caller-supplied label must never choose which permission it faces.

The core, `apply_winner_transition`, is `SECURITY INVOKER` with EXECUTE granted
to nobody, and in one transaction:

1. takes `FOR UPDATE` on the `winners` row;
2. refuses a transition that is not in the table below, naming both statuses;
3. emits the ledger movements through `apply_inventory_movement` — the ledger's
   single writer, as every block does it;
4. writes the new status on `winners`;
5. writes one `winner_status_history` row;
6. writes one `audit_logs` row carrying ids and counts and no listener.

### 4.1 The transition table

| From | Door | To | Movements |
|---|---|---|---|
| `AWAITING_PICKUP` | `deliver_prize` | `DELIVERED` | `DELIVERY` (`awaiting_pickup → delivered`) |
| `DELIVERED` | `cancel_delivery` | `AWAITING_PICKUP` | `DELIVERY_CANCEL` (`delivered → awaiting_pickup`) |
| `AWAITING_PICKUP` | `return_prize` | `RETURNED` | `RETURN_PENDING` then `RETURN_TO_STOCK` |
| `AWAITING_PICKUP` | `write_off_prize` | `WRITTEN_OFF` | `WRITE_OFF` (`awaiting_pickup → written_off`) |

`RETURNED` and `WRITTEN_OFF` are terminal in this block. `SUPERSEDED` is 6c's
and nothing here writes it.

`return_prize` is **refused with `22023`** when the prize carries
`allows_return_to_stock = false`, naming the prize. This block is that column's
first reader; `0025` registered it as deliberate debt.

A draw whose winner is not `AWAITING_PICKUP` still cannot be cancelled — 6a's
guard, unchanged, and now reachable, which is what it was written for.

---

## 5. The ledger, and the per-promotion figures

`0026`'s legal-transition check gains `DELIVERY_CANCEL`
(`delivered → awaiting_pickup`). `0045`'s promotion-reference check and
`project_promotion_prize_movement` (0077) gain all five types this block emits.

What each does to `promotion_prize_balances`:

| Movement | `linked` | `drawn` | Why |
|---|---|---|---|
| `DELIVERY` | — | — | the unit was spent **by** the promotion and stays counted against it |
| `DELIVERY_CANCEL` | — | — | the same unit, back a bucket |
| `RETURN_PENDING` | — | — | still committed to the promotion |
| `RETURN_TO_STOCK` | **−1** | **−1** | it leaves the promotion for general stock; without this it is counted twice |
| `WRITE_OFF` | — | — | destroyed, but it was this promotion that consumed it |

**The four no-ops must be written as explicit branches, never as a fallthrough.**
`0047`'s `XX000` exists precisely so that a type arriving without a rule fails
loudly, and a silent no-op is the failure it was built to prevent.

`RETURN_TO_STOCK` decrementing both keeps `drawn <= linked` (0045's check) true
by construction.

---

## 6. The receipt

**The bucket** is private, named `delivery-receipts`, with RLS on
`storage.objects`: a caller may read an object whose first path segment is a
`company_id` they hold `promotions.view` at, and may write one only with
`winners.deliver`. Paths are `<company_id>/<winner_id>/<uuid><ext>`, so the
policy can decide from the path alone.

**The order of operations, and it follows from D1:**

1. `deliver_prize` — the delivery is recorded and the stock has moved;
2. the app uploads the object;
3. `attach_delivery_receipt(winner_id, path)` — the path is written on the row.

A failure at step 2 or 3 leaves a delivery with no receipt, which is exactly
what D1 says should happen. The reverse order would make storage a hard
dependency of recording a delivery, which D1 refuses.

`attach_delivery_receipt` requires `winners.deliver`, refuses a winner that is
not `DELIVERED`, and refuses a path whose first segment is not the winner's own
`company_id` — a caller cannot file a receipt into another Station's folder.

---

## 7. Erasure

`anonymize_member` (0034) gains, for every winner belonging to that member with
a `receipt_path`:

- `receipt_path := null`, `receipt_erased_at := now()`;
- one `storage_erasure_queue` row, **in the same transaction**, so the intent
  cannot survive without the instruction.

The worker's existing tick (`0064` → `/api/worker`) drains the queue: for each
unprocessed row it deletes the object through the storage API, stamps
`processed_at`, and on failure records `last_error` and increments `attempts`
for the next tick.

The queue is drained, never truncated, and a row that has failed repeatedly
stays visible — an erasure that quietly gave up is the one failure mode this
whole mechanism exists to avoid.

---

## 8. What breaks, and what it does

| Situation | Behaviour |
|---|---|
| Delivering a winner that is not `AWAITING_PICKUP` | Refused, `22023`, naming the status it is in. |
| Cancelling a delivery of a winner that is not `DELIVERED` | Refused, `22023`. |
| Returning a prize whose `allows_return_to_stock` is false | Refused, `22023`, naming the prize. Write-off is the only exit. |
| Returning or writing off a `DELIVERED` winner | Refused. Undo the delivery first, which is a decision somebody has to make on the record. |
| A blank reason on an undo, a return or a write-off | Refused, `22023`. A delivery's note may be empty. |
| Attaching a receipt to a winner that already has one | Refused, `22023`. The slot is cleared only by erasure. |
| Two operators acting on one winner at once | Serialised by `FOR UPDATE` on the winner; the loser sees the status the winner left behind and is refused by the transition table. |
| A receipt upload that fails | The delivery stands, with no receipt. D1. |
| An erasure whose object delete fails | The row stays queued and is retried on the next tick; `receipt_path` is already null, so nothing on screen shows it. |

---

## 9. Verification

- **pgTAP:** the transition table, each refusal on its own; the
  `allows_return_to_stock` refusal; the `receipt_erased_at` shape constraint;
  the four permission codes; the grants on both new tables; the per-promotion
  figures for each of the five movement types, `RETURN_TO_STOCK` especially.
- **Vitest:** the delivery screen's own rules, as pure functions.
- **Isolation:** every new table and the bucket driven across the real HTTP
  boundary as `service_role` and as a signed-in operator — Block 5a's lesson,
  and `storage.objects` policies are exactly the kind of thing pgTAP cannot see;
  two operators delivering one winner at once.
- **Mutation, required:** remove the `allows_return_to_stock` check and confirm
  only that case goes red; remove `RETURN_TO_STOCK`'s decrements and confirm the
  per-promotion figures test goes red.
- **Playwright:** an operator delivers a prize with a receipt and sees it on the
  winner; then undoes the delivery and sees the winner awaiting pickup again.
- **The erasure, end to end:** anonymise a member who has a receipt, run the
  worker tick, and assert the object is gone from the bucket — not merely that
  the row was queued. The queue is a mechanism, and the claim is about the file.

---

## 10. Out of scope — this is Block 6c

The deadline expiring; promoting a runner-up and re-arming its deadline;
`SUPERSEDED`; the cron that finds overdue winners; the notification to the
listener through `outbox_messages`.
