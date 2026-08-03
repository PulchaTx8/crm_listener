# Block 6a — The draw, and the deadline it freezes — Design Spec

**Date:** 2026-08-02
**Status:** approved by the owner
**Master spec:** `docs/superpowers/specs/2026-07-25-crm-radios-multitenant-design.md` §6, §17, §18
**Depends on:** Block 2 (inventory ledger), Block 4b (`promotion_prizes`), Block 4c (`participations`), Block 3 (`member_blocks`)

---

## 1. What this block is for

A promotion closes. Somebody has to pick the winners, and then be able to prove
how they were picked — to the listener who did not win, to the Station's own
staff, and to whoever asks six months later.

This block is the picking and the proving. It ends at the moment a winner
exists, a prize has moved in the inventory, and a deadline is running. What
happens next — handing the prize over, taking it back, promoting a runner-up —
is **Block 6b**.

Block 6 was split in two on the owner's ruling of 2026-08-02: five subsystems in
one pass would produce a diff nobody can review, and Blocks 3, 4 and 5 were each
split for less.

---

## 2. Decisions

**D1 — One entry per VALID participation, not per person.** Somebody with three
valid entries in a repeatable promotion has three chances. Owner's ruling. It is
what a listener expects when a Station says "participe quantas vezes quiser",
and it is what makes `min_hours_between_entries` and `max_entries_per_member`
(Block 4) mean something: both exist to bound an advantage that only exists if
entries are weighted.

**D2 — One person wins at most one prize per draw.** Owner's ruling. When a
prize is awarded, every remaining entry belonging to that listener leaves the
hat. The consequence, stated because it shapes everything below: a draw is not
one draw, it is **N draws in sequence over a shrinking hat**, inside one
transaction — and the record has to say so or the reproduction will not match.

**D3 — The draw is reproducible from a stored seed.** Owner's ruling, choosing
against a pure CSPRNG whose only audit trail is its own record. The system
generates a seed, stores it with the algorithm's version and the exact frozen
list of entries, and the outcome is a deterministic function of the three.
Anyone holding the record can recompute the winners and get the same names.

The cost, accepted: **the algorithm is a contract.** It is versioned per draw
(`algorithm_version`), so changing it later does not invalidate the
verifiability of draws already run — it only means old draws are verified with
the old rule.

The seed is generated **inside** the function and is never an argument. A seed a
caller could choose is a seed a caller could shop for.

**D4 — Runners-up: a count chosen at draw time, in one ordered queue.**
Default three. Drawn in the same pass, from the same hat, under the same
one-prize-per-person rule. **One queue for the draw, not one per prize** — with
D2 in force, per-prize queues would cross and the same listener would sit in
several of them.

**D5 — The deadline is frozen at the moment of the draw.** A default on the
prize, an override on the promotion, both in days; `winners.deadline_at` is
written once, at the draw. Editing the prize's default in September must not
shorten the deadline of somebody who won in August.

**D6 — A blocked listener is not eligible, and that means both kinds of block.**
`draw_ban` obviously; `suspension` too, on the owner's ruling — somebody
suspended is not eligible for anything. `is_member_blocked` (0032) already
answers this and is the only place that answers it.

**D7 — A cancelled draw is kept, whole.** Cancelling reverses the inventory and
marks the draw, and deletes nothing: the hat, the seed and the winners stay,
because the record of a cancelled draw is the evidence that it was cancelled and
who cancelled it. A reason is mandatory.

**D8 — The operator chooses how many units to draw, defaulting to everything
still linked.** A Station with ten units may draw three now and seven next
month. Owner's ruling.

---

## 3. The data

Four new tables. The boundary between this block and 6b is a row in `winners`.

### 3.1 `draws`

One row per draw of one promotion.

| Column | Why |
|---|---|
| `promotion_id`, `company_id`, `organization_id` | tenancy, composite keys as everywhere in this schema |
| `seed text` | 64 hex characters. See §4.1 |
| `algorithm_version integer` | the contract's version, per draw |
| `runner_up_count integer` | what the operator asked for |
| `entry_count integer` | how many entries were in the hat, denormalised so a report does not have to count |
| `status` | `COMPLETED` or `CANCELLED` |
| `drawn_at`, `drawn_by` | when, and who |
| `cancelled_at`, `cancelled_by`, `cancellation_reason` | all three together or all three null — the shape rule this schema uses everywhere |

### 3.2 `draw_entries` — the hat, frozen

One row per eligible participation **at the instant of the draw**, carrying
`participation_id`, `member_id` and `position` (1..N, the order defined in
§4.1).

This table is the reason the draw is verifiable. Participations keep arriving
after the draw; without a frozen list, a reproduction run tomorrow would use a
different hat and disagree for a reason that has nothing to do with the
algorithm.

### 3.3 `winners`

`draw_id`, `promotion_prize_id` (which prize — this is the chain M4 the master
spec requires, and it is how 6b's delivery decrements the right promotion's
counter), `member_id`, `participation_id` (the entry that won), `awarded_rank`
(the order within the draw), `deadline_at`, and `status`.

`winner_status` is created with the full set 6b will use —
`AWAITING_PICKUP`, `DELIVERED`, `RETURNED`, `WRITTEN_OFF`, `SUPERSEDED` — and
this block writes only `AWAITING_PICKUP`. Declaring them all now costs nothing
and means 6b adds behaviour rather than re-shaping a column other rows already
hold.

### 3.4 `draw_runners_up`

`draw_id`, `position` (1..N), `member_id`, `participation_id`. The queue 6b
walks.

---

## 4. The algorithm

### 4.1 Version 1, stated as a contract

1. **The hat.** Every eligible participation (§5), ordered by
   `(participated_at, id)` and numbered from 1. Recorded in `draw_entries`; the
   number is `position`.
2. **The seed.** Two `gen_random_uuid()` values, hyphens stripped, concatenated:
   64 hex characters, 244 bits of entropy (each v4 uuid fixes 6 bits for version
   and variant). No extension required, and Postgres' uuid generator is
   CSPRNG-backed. Generated inside the function.
3. **The ranking value.** For each entry,
   `sha256(convert_to(seed || ':' || participation_id::text, 'UTF8'))`.
4. **The order.** Ascending by that value; ties broken by `position` ascending.
   A tie is astronomically unlikely and is defined anyway, because "unlikely" is
   not a rule a reproduction can follow.
5. **The prize units.** A `promotion_prizes` row carries a QUANTITY, not one
   row per unit, so "unit" here means an index: a link of quantity three, with
   the operator asking for two of them, contributes units 1 and 2. The sequence
   drawn for is every `(promotion_prize_id, unit_index)` pair the operator asked
   for, ordered by `promotion_prize_id` then `unit_index`. Deterministic, so a
   reproduction consumes them in the same order — and recorded on each winner as
   `awarded_rank`, its position in exactly this sequence.
6. **The walk.** For each unit in turn, take the next entry in the order whose
   `member_id` has not yet been awarded a prize **in this draw**. If the hat runs
   out first, the draw awards fewer prizes than units and records that.
7. **The runners-up.** Continue the same walk, same skip rule, for
   `runner_up_count` more entries.

**One keyed sort and a walk.** There is no sequential state to describe, which
is what makes the reproduction five lines in any language and the SQL a single
ordered scan.

### 4.2 Where it runs

In plpgsql, inside the transaction that writes the inventory movement. The hat
must be read and frozen in the same transaction that consumes the units, or two
concurrent draws over one promotion could both read the same available stock.

---

## 4.3 Who may draw, and who may undo one

Two permission codes, not one:

- **`draws.execute`** — running a draw.
- **`draws.cancel`** — cancelling one.

Separate for the reason `promotions.prizes` is separate from `promotions.edit`
(0049): cancelling a draw un-awards prizes somebody has already been told they
won, and whoever may run a draw is not thereby somebody who may undo one. Both
are per-Station, checked with `has_permission` against the promotion's
`company_id`, like every other write in this schema.

---

## 5. Who is in the hat

A participation is eligible when **all** of:

- its `status` is `VALID` — the other three are records of an attempt, not
  entries;
- it belongs to the promotion being drawn;
- its listener is not soft-deleted and not anonymised;
- its listener is not blocked, by `is_member_blocked` (0032), which covers
  `draw_ban` and `suspension` (D6).

An excluded participation is **not** recorded in `draw_entries`: the hat is what
was drawn from, and a row that could never have been picked would make the
reproduction disagree.

---

## 6. Inventory, and the deadline

**The movement.** One `DRAW` movement per awarded unit, `linked` →
`awaiting_pickup`, through `apply_inventory_movement` — the ledger's single
writer, as every other block does it. Both `DRAW` and `DRAW_CANCEL` already
exist as movement types with their bucket rules (0026); this block is their
first caller.

**The deadline.** Two new columns, both in days:
`prizes.default_pickup_deadline_days` and
`promotions.pickup_deadline_days` (the override). At the draw,
`deadline_at = drawn_at + coalesce(promotion, prize) days`. When neither is set
the winner has **no deadline** (`deadline_at` null) — a Station that has not
configured one has not agreed to a rule, and inventing thirty days for them
would start a clock they never set. 6b's cron simply skips a null.

---

## 7. What breaks, and what it does

| Situation | Behaviour |
|---|---|
| No eligible participation at all | The draw is refused, not recorded as an empty draw: nothing happened, and a row saying it did is worse than none. |
| Fewer entries than units asked for | Draws what it can, awards fewer prizes, records `entry_count`. Not an error. |
| Fewer entries than `runner_up_count` | Same: as many runners-up as there are people. |
| A second draw while one is running | Serialised on the promotion row, the same `FOR UPDATE` shape `link_prize_to_promotion` (0049) already uses. The loser sees the units the winner consumed. |
| Cancelling a draw with a delivery against it | Refused. 6a has no deliveries, and the guard exists from the start so 6b cannot introduce the hole by forgetting it. |
| Cancelling a cancelled draw | Refused, with the reason. |
| A promotion still open | Allowed. The owner may draw before the window closes; the hat is whatever is valid at that instant, and the record says when. |

---

## 8. Verification

- **Vitest, no database:** the algorithm as a pure function — same seed and same
  hat give the same winners; a different seed gives different ones; the
  one-prize-per-person skip actually skips; a hat smaller than the prize count
  awards what it can. This is the block's central claim and it belongs where it
  can be run a thousand times in a second.
- **pgTAP:** eligibility (each exclusion on its own), the frozen deadline, the
  cancel path and its refusals, the grants and the private cores.
- **Isolation:** a whole draw as `service_role` and as a real signed-in operator
  across the HTTP boundary — the seam that hid three defects in Block 5a and five
  in 5b — and **two concurrent draws on one promotion**, which must not both
  consume the same unit.
- **A reproduction test:** take a completed draw's stored seed and entries, run
  the algorithm again from the TypeScript side, and assert the same winners. If
  the SQL and the TypeScript ever disagree, the audit claim is void, and nothing
  else in this suite would notice.

---

## 9. Out of scope — this is Block 6b

Delivery and its receipt in a private bucket; the `DELIVERY` movement; return to
stock and write-off, honouring `prizes.allows_return_to_stock`; promoting a
runner-up and re-arming its deadline; `winner_status_history`; the deadline cron
and its notification.
