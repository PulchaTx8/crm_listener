# Block 2 — Inventory & Prizes — Design

**Date:** 2026-07-27
**Depends on:** Block 1c (roles per Company). Every permission this block introduces
is composed into roles by the owner and assigned per Station; nothing here works
until that is on `main`.

---

## 1. What this block is, and what it deliberately is not

This is the first block with a business domain, and it is the one the spec calls the
critical core. Everything after it — promotions, draws, deliveries — moves numbers
that this block is responsible for keeping true.

It builds the **prize catalogue** and the **stock ledger**: what a Station has, how
much of it, and an account of every change that has ever been made. It is not the
promotion, the draw or the delivery. Those are Blocks 4 and 6, and they will move
stock through mechanisms this block puts in place but does not exercise.

The thing to get right is not the screens. It is that **the number on the screen is
the truth**, and that when it is not, the system says so instead of quietly
continuing.

## 2. Decisions taken

Fixed by the product owner on 2026-07-27, during the Block 1c brainstorming:

1. **A prize carries quantity only** — no unit value, no supplier, no sponsor. If
   money is needed later it arrives by migration without touching the ledger.
2. **Reservations are real**, and a reservation carries a **free-text note** saying
   what it is being held for. This was not obvious — a bucket nothing writes to is
   the defect Block 1b named — and the owner confirmed the use case: units
   committed to a sponsor or an event, not free to promise in a promotion.
3. **Manual work is:** register a prize, add quantity to stock, reserve with a note.
   Drawing and delivering belong to later blocks.
4. **The uncollected prize is derived from a date, not maintained by a cron.** When
   the pickup deadline passes, the prize leaves the awarded list and appears in the
   returned list *because the deadline is in the past* — no job runs, so no job can
   silently fail. The user then archives it or returns it to stock. **This replaces
   the deadline cron in spec §6** and is carried to Block 6, not built here.

## 3. The model: one ledger, two projections

- **`inventory_movements` is an immutable ledger.** Never updated, never deleted.
  A mistake is corrected by a new movement, the way a bank statement is corrected by
  a reversal rather than a rewrite. This is enforced by grants, not by convention:
  no role — including `service_role` — holds `UPDATE` or `DELETE` on it.
- **`inventory_balances` is a projection per `(company, prize)`**, maintained in the
  same transaction as the movement that changes it. It exists because summing the
  ledger on every screen render would be slow, and for no other reason: it must be
  reconstructible from the ledger at any moment, and §9 is how we check that it is.
- **`promotion_prize_balances`, the per-promotion projection, is Block 4's.** It
  cannot be built here — it needs `promotion_prizes`, which does not exist. What
  this block owes it is a ledger shaped so that adding it later is an addition, not
  a rewrite.

## 4. The buckets, and the equation

Physical stock is partitioned. A unit is in exactly one bucket, and every movement
is a transfer between two of them — or across the boundary, in or out of the
Station altogether.

```
physical = available + reserved + linked + awaiting_pickup + pending_return
usable   = available          -- reserved does NOT count as usable
outside  = delivered, written_off
```

`delivered` and `written_off` are cumulative counters, not part of physical stock.
They are on the balance row because reconciliation needs them to close the ledger,
and they are commented as such so nobody adds them to a physical total.

Every bucket carries `CHECK (... >= 0)`. That constraint is the last line of
defence, not the first — the RPCs check the source bucket before moving — but it is
the one that cannot be forgotten by a future function.

## 5. What ships now, and what does not

The **movement vocabulary and the bucket columns ship complete**, because the ledger
is immutable and its shape must account from the first row for transitions later
blocks will make. Adding a bucket column later means backfilling a projection from a
ledger that never recorded the distinction.

The **RPCs ship only for movements this block can prove end to end**:

| Movement | Transition | Ships in |
|---|---|---|
| `INITIAL_ENTRY`, `PURCHASE_ENTRY`, `MANUAL_ENTRY` | outside → available | **Block 2** |
| `MANUAL_EXIT` | available → outside | **Block 2** |
| `ADJUSTMENT_POSITIVE` / `ADJUSTMENT_NEGATIVE` | outside ↔ available | **Block 2** |
| `RESERVATION` / `RESERVATION_RELEASE` | available ↔ reserved | **Block 2** |
| `PROMOTION_LINK` / `PROMOTION_UNLINK` | available ↔ linked | Block 4 |
| `DRAW` / `DRAW_CANCEL` | linked ↔ awaiting_pickup | Block 6 |
| `DELIVERY` | awaiting_pickup → delivered | Block 6 |
| `RETURN_PENDING` | awaiting_pickup → pending_return | Block 6 |
| `RETURN_TO_STOCK` | pending_return → available | Block 6 |
| `WRITE_OFF` | pending_return \| awaiting_pickup → written_off | Block 6 |

Writing a `DELIVERY` RPC now would mean inventing the contract of `winners` and
`deliveries` blind. Block 1c's lesson is the opposite of that: the defects that cost
most were the ones written against a shape nobody had yet met.

## 6. Data model

**`prize_categories`** — `id`, `organization_id`, `company_id`, `name`, timestamps,
`deleted_at`. Flat, not a tree: nobody has asked for nesting and a self-referencing
hierarchy is a screen and a cycle-check nobody needs yet.

**`prizes`** — `id`, `organization_id`, `company_id`, `category_id`, `name`,
`internal_code`, `description`, `allows_return_to_stock boolean not null default
true`, timestamps, `deleted_at`.

- Partial unique index on `(company_id, lower(internal_code)) where deleted_at is
  null and internal_code is not null` — spec N5. The code is optional; two prizes
  without one do not collide.
- `allows_return_to_stock` is spec N11 and is read by **Block 6**, not here. It is
  included anyway because it is a property of the prize, set when the prize is
  registered, by the person who knows the answer. It is the one field in this block
  that nothing yet reads, and that is stated in its `comment on column` so the next
  reader does not mistake it for dead weight.
- **No default pickup deadline column.** The spec allows one, Block 6 needs one, and
  a column set by a form that nothing reads is exactly the defect Block 1b named. It
  arrives with the flow that uses it.

**`inventory_movements`** — the ledger.

```
id, organization_id, company_id, prize_id,
movement_type   inventory_movement_type not null,
quantity        integer not null check (quantity > 0),
from_bucket     inventory_bucket,          -- null = from outside the Station
to_bucket       inventory_bucket,          -- null = to outside the Station
note            text,
idempotency_key text,
actor_id        uuid references auth.users (id),
created_at      timestamptz not null default now()
```

Quantity is always positive; direction lives in the buckets. A signed quantity would
make "did this add or remove" a matter of reading a sign correctly in every query
that ever touches the table.

Storing `from_bucket`/`to_bucket` rather than deriving them from `movement_type`
makes the ledger self-describing: reconciliation sums the ledger without a lookup
table living in application code, and a movement type added in Block 6 does not
require §9's function to learn about it.

No `updated_at`, no `deleted_at` — both would be lies on an immutable table.

**`inventory_balances`** — the projection.

```
company_id, prize_id      -- composite primary key
organization_id
available, reserved, linked, awaiting_pickup, pending_return  -- physical
delivered, written_off                                        -- cumulative, outside physical
updated_at
```

Every column `not null default 0` with `check (>= 0)`.

Cross-tenant integrity uses Block 1c's mechanism: composite foreign keys sharing
`organization_id`, so a prize of one Organization cannot be given a balance under
another. Block 1c proved that shape works and proved, twice, that a runtime check
alone is what gets forgotten.

## 7. Operations

Every one is a `SECURITY DEFINER` function that resolves the Organization from the
row it was given — never from a caller-supplied id — re-checks the caller with
`has_permission`, writes to `audit_logs`, and on denial uses `RAISE LOG` followed by
`RAISE EXCEPTION`, because an audit insert before a raise never commits.

| Function | Requires | Notes |
|---|---|---|
| `create_prize_category(company, name)` | `inventory.catalogue` | |
| `create_prize(company, category, name, code, description, allows_return)` | `inventory.catalogue` | |
| `update_prize(prize_id, …)` | `inventory.catalogue` | Never touches balances. |
| `archive_prize(prize_id)` | `inventory.catalogue` | **Refused while any physical bucket is non-zero.** Archiving stock that exists would strand it: the balance row survives, nothing displays it, and reconciliation still counts it. Move it out first, the same shape as `delete_role` refusing a role in use. |
| `record_stock_entry(company, prize, quantity, type, note, idem)` | `inventory.entry` | `type` restricted to the three entry kinds. |
| `record_stock_exit(company, prize, quantity, note, idem)` | `inventory.exit` | Note mandatory — an exit with no reason is an unexplained loss. |
| `adjust_stock(company, prize, counted_quantity, note, idem)` | `inventory.adjust` | Takes the **counted figure**, not a delta, and derives the sign itself. Someone reconciling with a shelf counts what is there; making them compute a difference is how the sign gets inverted. Note mandatory. |
| `reserve_stock(company, prize, quantity, note, idem)` | `inventory.reserve` | Note mandatory — the note is the reservation's whole purpose. |
| `release_reservation(company, prize, quantity, note, idem)` | `inventory.reserve` | |
| `reconcile_inventory(company)` | `inventory.view` | §9. Read-only. |

All the movement functions funnel into one private routine that takes the balance
row's lock, validates the source bucket, appends the ledger row and updates the
projection — one place where the mechanics live, with the permission check staying
in each public function where a reader looking for "who may do this" will find it.
That private routine holds `EXECUTE` for nobody.

## 8. Idempotency

Every movement RPC accepts an optional `idempotency_key`. A partial unique index on
`(company_id, idempotency_key) where idempotency_key is not null` makes a replay a
constraint violation rather than a second movement, and the RPC turns that into a
success that returns the original movement's id.

**No generic `idempotency_keys` table.** Spec §4.3 plans one for use across webhooks
and Server Actions; this block needs it for one table and would be introducing a
shared mechanism with one caller. It arrives when the second caller does.

## 9. Reconciliation

`reconcile_inventory(company_id)` recomputes every balance for the Station from the
ledger and returns the rows that disagree — prize, bucket, stored value, computed
value.

**It reports; it does not repair.** A projection that silently self-heals converts a
bug in a movement RPC into a number that is briefly wrong and then quietly right,
which is the hardest kind to find. If reconciliation finds a divergence, something
is broken and a person needs to know.

It runs on demand from a screen, not on a schedule: `pg_cron` arrives with the
WhatsApp worker in Block 5, and a cron that nobody has wired an alert to is a job
that fails in silence.

## 10. Permissions

New codes, `module = 'inventory'`, `scope = 'company'` — so they are held per
Station, which is what Block 1c built:

| Code | Label in the role editor |
|---|---|
| `inventory.view` | See prizes and stock |
| `inventory.catalogue` | Register, edit and archive prizes and categories |
| `inventory.entry` | Add stock |
| `inventory.exit` | Record a manual exit |
| `inventory.adjust` | Adjust stock to match a count |
| `inventory.reserve` | Reserve stock and release a reservation |

`inventory.adjust` is separated from the rest deliberately. Entry and exit have a
physical counterpart — something arrived, something left. An adjustment does not: it
is the only way a number can be created or destroyed with nothing behind it, and it
is what someone reaches for when they cannot make the system agree with the shelf.
Whoever composes roles should have to decide about it on its own.

These codes appear in the role editor without that screen being touched. If they do
not, Block 1c's catalogue was built wrong, and this block is where we find out.

## 11. Screens

**Inventory** (`/inventory`) — the Station's prizes with their balances, filterable
by category and searchable by name or code. The accounting view: every bucket, per
prize, and the physical total.

**Prize detail** — the balance broken out, and the movement history, newest first,
with who did it and why. The ledger is the feature here, not a debug view: "why does
this say 47" is the question the screen exists to answer.

**Registration and movement forms** — register a prize, add quantity, record an
exit, adjust to a counted figure, reserve with a note, release a reservation. Each
one gated on its own permission, each one refusing in the database as well.

**Reconciliation** — a button and a result. Either "no divergence" with the time it
was checked, or the rows that disagree.

Every control is a courtesy; the boundary is the RPC.

## 12. RLS

All four tables: RLS enabled, `revoke all from anon, authenticated`, explicit grants,
explicit `service_role` grant. `select` for `authenticated` gated on
`has_permission('inventory.view', company_id)`.

**No write grant to anyone on any of them**, including `service_role`. Every write
goes through a `SECURITY DEFINER` RPC that re-checks the caller, takes the row lock
and writes the audit entry. On `inventory_movements` this is stronger than
convention: without `UPDATE` and `DELETE` grants, the ledger's immutability is
enforced by the database rather than promised by a comment.

## 13. Testing

**pgTAP** — the bucket `CHECK` constraints exist and bite; the composite foreign keys
reject a prize from another Organization; no role holds `UPDATE` or `DELETE` on the
ledger; the partial unique indexes are present; the new permission codes are seeded
with `module = 'inventory'`.

**Isolation, under real JWTs** — this is where the block is proved:

- A movement cannot drive any bucket below zero, attempted through the RPC.
- Each operation is refused without its own permission and allowed with it —
  including `inventory.adjust` held alone, and every other code held without it.
- A replayed `idempotency_key` produces one movement, not two, and returns the same id.
- A holder of `inventory.entry` in Station A cannot add stock in Station B.
- Reconciliation reports zero divergence after a sequence of movements, and reports
  the exact divergence after a balance row is corrupted directly.
- Archiving a prize with a non-zero bucket is refused.

**End to end** — a non-owner holding a composed inventory role registers a prize,
adds stock, reserves part of it with a note, and sees the movement history explain
the number. **The operator is not the owner.** Block 1c shipped two defects that
thirteen reviews missed because every screen scenario had the owner driving, and the
owner's bypass hid the delegate's failure.

## 14. Definition of done

| Criterion | Evidence |
|---|---|
| A negative balance is impossible, attempted through the RPC and directly | isolation, pgTAP |
| Every bucket transition checks its source bucket before moving | isolation |
| The ledger cannot be updated or deleted by any role | pgTAP |
| A replayed movement is one movement | isolation |
| Each operation is refused without its permission and allowed with it | isolation |
| A permission held in one Station does not act in another | isolation |
| Reconciliation finds no divergence after a real sequence, and finds a planted one | isolation |
| The inventory permissions appear in the role editor without it being modified | e2e |
| A non-owner delegate completes the journey end to end | e2e |
| A prize with stock cannot be archived | isolation |
| lint, typecheck, unit, pgTAP, isolation, e2e and `docker build` all pass | CI |

## 15. Out of scope

Per-promotion balances and the linking RPCs (Block 4). Draws, deliveries, returns
and write-offs (Block 6). Locations and transfers (spec M1, out of v1). Monetary
value, suppliers and sponsors. The default pickup deadline. Scheduled reconciliation.
Import of an opening balance from the legacy system — that is Block 9's ETL, which
will use `INITIAL_ENTRY`.

## 16. Open risks

1. **The projection is a second source of truth.** It is maintained transactionally
   and reconstructible, which is why §9 exists — but every future block that moves
   stock must go through the RPCs. A single direct `UPDATE` on `inventory_balances`
   from a later block breaks the invariant silently. The absence of write grants is
   what stops it; that absence must survive every future migration.
2. **`from_bucket`/`to_bucket` can disagree with `movement_type`** if a future RPC
   writes them inconsistently. Reconciliation reads the buckets, so a wrong pair
   corrupts the projection *and* its check in the same direction. A `CHECK`
   constraint enumerating the legal pairs per movement type closes it, and it is
   worth writing even though the enumeration is long.
3. **Concurrency is proved only sequentially.** The row lock is the mechanism, and
   this project has no `pg_isolation_tester`. Block 1c accepted the same limit for
   `delete_role`; the same reasoning applies, and the same honesty is owed in the
   report.
4. **`allows_return_to_stock` is written here and read in Block 6.** Between the two
   it is a field the UI collects and nothing consumes. Stated in the column comment
   so it is a known debt rather than a discovered one.
