# Block 4b — Prize linking, and the surgery on the ledger — Design

The second of Block 4's three passes. **4a** shipped the promotion and its quiz
(PR #15, merged). **4b** is this. **4c** is participations, import and the
per-person limit.

This pass is separated from the other two because it is **surgery on the
accounting core Block 2 built**, not a use of it. The ledger is append-only and
already holds rows; the projection it feeds is the one screens read stock from;
and the invariant being added — "do not unlink below what has been drawn" —
spans two tables that do not know about each other yet.

---

## 1. What Block 2 left half-built, and what 4a added to the debt

`PROMOTION_LINK` (available → linked) and `PROMOTION_UNLINK` (linked →
available) are in the `inventory_movement_type` enum and are legal transitions
in `inventory_movements_legal_transition` (`0026`, lines 48–51). **No RPC issues
either one**, so both are unreachable. `inventory_movements` carries **no
promotion reference at all**, and `promotion_prize_balances` — the
per-promotion projection the design document calls H1 — does not exist.

4a added one more debt of its own: **`cancel_promotion` (`0042`) knows nothing
about prizes**, because prizes did not exist when it was written. D1 below is
what settles that, and it means 4b **recreates that function body**.

---

## 2. Decisions taken with the owner

**D1 — Cancelling a promotion returns its prizes to stock, in the same
transaction.** Every unit still linked and not yet drawn goes back to
`available`, each as its own `PROMOTION_UNLINK` movement carrying the
cancellation as its note. **What has been drawn does not come back** — those
units are in `awaiting_pickup` and belong to a winner.

Without this rule a cancelled promotion strands its prizes: out of `available`,
counted in the balance, inside a record nobody will open again.

**Archiving returns them too, and that is a correction to this spec rather than
an extension of it.** The paragraph that stood here reasoned that archiving
already refuses while a promotion is accepting entries, so anything archivable
had been cancelled first and D1 was enough on its own. That is not what 4a
shipped: `archive_promotion` refuses only *inside* the window, and
`cancel_promotion` refuses a promotion that has already *ended*. An ended,
never-cancelled promotion was therefore archivable with its prizes still linked
— the exact stranding this decision exists to prevent, reachable by doing
nothing at all. The owner's call was that archiving should hand the units back
itself rather than grow a new refusal, so archiving now moves stock, which it
did not before. Both paths share one helper (`return_promotion_prizes`, 0050).

**D2 — Linking always takes a quantity.** A prize is not linked to a promotion;
*N units of it* are. This matches the owner's current screen, whose Prêmios tab
shows `Vinculados` as a count.

**D3 — Prizes may be added while the promotion is running.** The operator can
link another prize, or more units of one already linked, at any point in the
promotion's life.

**D4 — Prizes may be unlinked while the promotion is running, down to what has
been drawn.** With 5 linked and 2 drawn, up to 3 may be returned; a fourth is
refused naming the two. This covers the real case of having linked too many and
needing the units for another action, and the floor is the design document's
own invariant.

---

## 3. Data model

### 3.1 `promotion_prizes`

The link itself: `id`, `promotion_id`, `prize_id`, `organization_id`,
`company_id`, `created_by`, timestamps, `deleted_at`.

One row per `(promotion, prize)` pair while live — a partial unique index, the
project's N5 idiom — so linking more units of a prize already linked adds to
the count rather than creating a second row.

Composite foreign keys to both parents prove the Station on each side:
`(promotion_id, company_id)` against `promotions (id, company_id)` and
`(prize_id, company_id)` against `prizes (id, company_id)`. A prize from one
Station cannot be linked to a promotion in another, and that is structural
rather than checked.

### 3.2 `promotion_prize_balances`

The H1 projection, keyed on `promotion_prize_id`:

```
linked     units currently committed to this promotion
drawn      units drawn from it (Block 6 writes this; 4b only reads and guards)
```

**No `delivered` column here, deliberately.** The design document's §5 lists one
on this projection, and it cannot be written in this block: a `DELIVERY`
movement may not carry `promotion_prize_id` until Block 6 widens the ledger
check (§3.3), so nothing could ever increment it. A column whose only writer
does not exist yet is the same shape as a guard that can never fire, and this
project has shipped five of those. **Block 6 adds it**, with the movement that
fills it.

`Resto` — the third column on the owner's screen — is `linked − drawn`,
computed, never stored: a stored total is one more thing that can disagree with
its parts.

`drawn` has no writer in this block, so D4's floor has no fixture reachable
through any RPC. `setPromotionPrizeDrawnDirectly` in the isolation harness is
the escape hatch, the same shape `corruptBalanceDirectly` opened for the
per-prize projection and with the same warning attached: a row set that way is a
genuine divergence and reconciliation reports it.

Every bucket carries `check (… >= 0)`, and `drawn <= linked` is a table check.
That last one is what makes D4's floor structural: an unlink that would push
`linked` below `drawn` cannot be written, whether or not the RPC checks first.

### 3.3 The ledger

`inventory_movements` gains **`promotion_prize_id uuid`, nullable**, with a
check that ties it to the movement types that name a promotion:

```sql
check (
  (movement_type in ('PROMOTION_LINK','PROMOTION_UNLINK') and promotion_prize_id is not null)
  or (movement_type not in ('PROMOTION_LINK','PROMOTION_UNLINK') and promotion_prize_id is null)
)
```

Nullable and additive, so every row Block 2 already wrote stays legal. Required
for exactly the two types that are meaningless without it — a `PROMOTION_LINK`
that cannot say which promotion is a row nobody can reconcile.

`DRAW`, `DELIVERY` and the return types will need the same reference in Block 6.
They are deliberately **not** included here: this block has no way to write one,
and a check admitting a column no caller can fill is a rule that cannot be
tested. Block 6 widens the check; this spec says so where Block 6 will look.

### 3.4 `apply_inventory_movement`

Gains `p_promotion_prize_id`, and writes **both** projections inside the
transaction that appends the movement. Recreated in place, the way `0030`
recreated it before — same file idiom, same reason: the ledger's single writer
must stay single.

`reconcile_inventory` (`0028`) is extended to recompute the per-promotion
projection from the ledger too, and to report a divergence per
`promotion_prize` alongside the per-prize ones it already reports. A projection
nothing reconciles is a projection that drifts silently.

---

## 4. RPCs and permissions

| RPC | Does |
| --- | --- |
| `link_prize_to_promotion(p_promotion_id, p_prize_id, p_quantity, p_note)` | Creates the link row if absent, appends `PROMOTION_LINK`, moves `available → linked` |
| `unlink_prize_from_promotion(p_promotion_id, p_prize_id, p_quantity, p_note)` | Appends `PROMOTION_UNLINK`, moves `linked → available`, refused below `drawn` |
| `cancel_promotion` (recreated) | D1: unlinks every remaining undrawn unit before marking the cancellation |

Both new functions take `for update` on the promotion row before reading the
balance they decide on, so two concurrent links cannot both pass the
"available" check. This is the shape `archive_prize` uses and the reason its
own comment gives.

**Refusals that are part of the contract**, each with an isolation case:
linking to a cancelled or archived promotion; linking more than `available`;
unlinking more than `linked − drawn`; linking a prize from another Station;
a non-positive quantity.

**A promotion whose window has closed still accepts links, and that is not an
oversight.** The draw happens *after* entries close (Block 6), so a promotion
that has ended is exactly when its prizes are most likely to be adjusted. Only
cancellation and archiving close the door — which is consistent with D1, where
cancelling is the thing that hands the units back.

**New permission code: `promotions.prizes`.** Linking moves stock, so gating it
on `promotions.edit` alone would let somebody who may reword a promotion also
commit inventory. Reusing `inventory.reserve` is the other candidate and reads
wrongly — a reservation is not a promotion link. Proposed as its own code, and
the owner can collapse it into `promotions.edit` at review, exactly as with 4a's
five.

---

## 5. Screen

The record dialog gains its fourth tab, **Prêmios**, matching the owner's
current screen: one row per linked prize with **Vinculados / Sorteados / Resto**,
a control to link (prize picker plus quantity), and a control to unlink
(quantity, bounded by Resto).

The tab is part of the record read, so it costs no extra round trip on open.
Every write inside it re-reads this one record — never the list — which is the
rule the whole pattern rests on and which 4a's own actions file states in a
banner comment.

The inventory screen's prize record gains nothing here: which promotions hold a
prize's stock is a question worth answering, and it is not this block's.

---

## 6. Verification

Every gate at real defaults, as always. Specifically:

**pgTAP** for each constraint: the ledger's new check both ways, `drawn <=
linked`, the non-negative buckets, the composite keys refusing a cross-Station
link, and the partial unique index allowing a relink after a soft delete.

**Isolation** under a non-owner delegate, covering every refusal in §4 plus the
two that matter most: **cancelling a promotion returns exactly the undrawn
units and leaves the drawn ones alone** (D1), and **reconciliation reports zero
divergence after a link/unlink round trip** — the second projection recomputed
from the ledger must equal what the RPCs wrote.

**Mutation, planned in advance:** remove `drawn` from the unlink floor and the
D4 case must go red; drop the per-promotion write from
`apply_inventory_movement` and reconciliation must report the divergence. Both
are assertions that would otherwise pass while the thing they guard was gone.

---

## 7. Open

- **`DRAW`/`DELIVERY` do not carry the promotion reference yet** (§3.3). Block 6.
- **Whether `promotions.prizes` should be its own code** (§4) — the owner's call
  at review.
- The inventory screen still cannot answer "which promotions hold this prize's
  stock" (§5).
- **Archiving moves stock now** (§2 D1). It is the only operation in the project
  whose name suggests filing a record away and which also touches a balance;
  that was the owner's choice over a new refusal, and it is worth revisiting if
  Block 6's draw gives an ended promotion another way to let go of its prizes.
- **`list_linkable_prizes` caps at 50** and the picker says so. A Station with
  hundreds of prizes has a search box and nothing else; whether that is enough
  is a question for the first operator who has one.
