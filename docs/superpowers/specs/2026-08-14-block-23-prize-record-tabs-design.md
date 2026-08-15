# Block 23 — The prize record grows five tabs, and stock gains a paper trail

**Status:** design agreed with the owner, 2026-08-14.
**Scope:** the owner's list of 2026-08-14 with five reference layouts — the prize
record dialog on `/inventory` becomes five tabs, entries carry invoice data,
entries and exits can be reversed, and reservations gain an owner and an
identity.
**Depends on:** Block 2 (`prizes`, `inventory_movements`, the bucket vocabulary
and the enumerated bucket-transition constraint), Block 4b (`promotion_prizes`
and the promotion link), Block 6 (`list_movements`, which already resolves the
actor's name), Block 18 (`shows`, the programmes a reservation can name).

---

## 1. What this is for

The prize record has two tabs today: the record itself, and a Movements tab
where four forms — entry, exit, reservation, adjustment — sit side by side above
one undifferentiated ledger. It is a developer's arrangement: everything that
writes to the ledger, in one place, because that is how the ledger is built.

It is not how the work is done. Buying prizes is a purchasing job with an
invoice, a unit price and a total. Sending prizes to another station is a
different job by a different person on a different day. Holding stock back for
next month's promotion is a third. Each has its own history worth reading on its
own, and the operator asking "what did we buy in July" should not have to read
past reservations and draws to find out.

So the record grows five tabs — the record, entries, exits, reservations, and
one unified chronological view — and each of the three writing tabs carries the
history of its own kind beneath its form.

Two things the ledger cannot do today are added because the tabs make their
absence obvious: an entry cannot record what it cost, and nothing can be undone.

---

## 2. What already exists and is reused

Stated first because it is most of the block, and because the risk here is
rebuilding what is already built.

- **The four forms** — `stock-entry-form.tsx`, `stock-exit-form.tsx`,
  `reservation-forms.tsx`, `adjustment-form.tsx` — move into the new tabs. They
  are not rewritten.
- **The doors** — `record_stock_entry`, `record_stock_exit`, `adjust_stock`,
  `reserve_stock`, `release_reservation` (`0027`) — are widened where this block
  needs more, never replaced.
- **`list_movements` (`0096`) already returns `actor_id` and `actor_name`**,
  resolved through `profiles.full_name`. The owner's requirement that every
  history row name who did it costs a column in five grids and nothing at the
  database.
- **`apply_inventory_movement`** is the one writer every door goes through, and
  the enumerated `from_bucket`/`to_bucket` constraint on `inventory_movements` is
  what makes an illegal transition unrepresentable. Both are kept and extended.

---

## 3. Decisions

All taken with the owner on 2026-08-14.

**D1 — "Archive" is a reversal. Nothing is deleted and nothing is flagged out of
the sum.** `0025` states in writing that the ledger is immutable and every
balance on the screen is a sum over it. The owner chose the accounting answer:
archiving an entry of 123 writes a second movement of −123 that carries the same
invoice number, and both rows stay in the history — the original marked as
reversed, the reversal naming who made it and when. The balance corrects itself
by arithmetic rather than by a filter, which also means no existing balance
query has to learn a new exclusion.

The rejected alternative was a `cancelled_at` flag. It reads more simply in the
list and it moves the definition of "the balance" from one sum into every place
that computes one — including the reconciliation panel and the dashboards, which
would each have to be taught the same exception and would each be a place to
forget it.

**D2 — One reversal mechanism, not three.** A single nullable column,
`reverses_movement_id`, means "this movement undoes that one". It serves the
entry reversal, the exit reversal and the reservation release alike. A movement
can be reversed once; the second attempt is refused by a unique index rather
than by a check in application code.

**D3 — Invoice data lives on the entry movement, one prize per entry.** Number,
unit amount and total amount are columns on the movement. An invoice covering
three different prizes is three entries repeating its number — which is what the
owner chose over a document-with-items model, because the record dialog belongs
to one prize and is the wrong place to enter another prize's line.

`invoice_number` is indexed anyway. Grouping several entries under one invoice
later is then a screen someone writes, not a migration that moves data.

**D4 — Permuta and Envio para outra emissora are vocabulary, not free text.**
Two new values of `inventory_movement_type`: `BARTER_ENTRY` and `TRANSFER_EXIT`.
The owner was explicit that the list is fixed and not editable by the operator.
The cost is that every place translating a movement type gains two entries, and
the bucket-transition constraint gains two branches; the gain is that "how much
came in by barter this year" is a sum rather than a search through notes.

**D5 — A reservation becomes a thing you can point at.** Today reserving is a
quantity into a bucket and releasing is a quantity out of it; there is no "that
reservation". The screen the owner drew lists reservations with an action on
each, which is not expressible over anonymous quantities. So the `RESERVATION`
movement row *is* the reservation: releases carry `reverses_movement_id` naming
it, and a reservation's remaining quantity is its own quantity minus the
releases pointing at it.

**D6 — "Vincular Promoção" calls the door the Promotions screen already
calls.** It creates the same `promotion_prizes` row and writes the same
`PROMOTION_LINK` movement. A second door would be a second set of rules to keep
in step, and the first time they diverged the prize would be linked on one
screen and not the other.

**D7 — A programme reservation is a reservation with an owner.** The owner's
ruling: linking a prize to a programme separates it and labels it, and nothing
else happens on its own — someone from that programme writes it off through the
Exits tab when it is handed over. So it is bucket `reserved`, not `linked`, and
it needs no binding table, no delivery, no deadline. One nullable
`reserved_for_show_id` on the reservation movement carries it.

This is deliberately smaller than the promotion case. A promotion link makes a
prize drawable and is enforced by the draw; a programme has no draw to enforce
anything, and inventing delivery machinery for it would be building a feature
nobody asked for.

**D8 — Five tabs, and the record tab stops being a workbench.** `Dados do
prêmio` keeps the balance cards and the record form; the four movement forms
leave it for the tabs where their own history lives.

**D9 — The total is computed and still editable.** Quantity × unit price fills
it; the operator can overwrite it, because real invoices carry freight and
discounts. Computing it silently and locking it would make the screen disagree
with the paper.

**D10 — The Movimentação tab filters by period and by type.** The owner asked
for the period and the Consultar button. The type filter is this block's
addition: the unified view is every kind at once, and it is the one place where
"only entries, last month" is the natural question.

**D11 — Every history row names its actor.** Five grids, one column each,
`actor_name` from `list_movements`. Where `actor_name` is null the row still
shows something honest: `0096`'s own comment records that a null name means
either the clock (no actor) or an operator who never set a display name, and
that the two are told apart by `actor_id`, never by the name.

**D12 — The bucket-transition constraint is extended, never bypassed.** The two
new movement types and the reversal directions get their branches in the
enumerated check. That constraint is what makes a corrupt projection
unrepresentable rather than unlikely, and a block that widened the vocabulary
without widening it would be the first to be able to write a movement the
reconciliation panel cannot explain.

---

## 4. The data model — `0192` and `0193`

**The two new enum values need a migration of their own, and this is not
tidiness.** PostgreSQL refuses to *use* a value added by `ALTER TYPE … ADD
VALUE` in the same transaction that added it, and Supabase runs each migration
file in one transaction. A single file that adds `BARTER_ENTRY` and then writes
a check constraint mentioning `'BARTER_ENTRY'` fails with "unsafe use of new
value of enum type" — at `db:reset`, on every machine, every time.

So `0192` is two lines and nothing else:

```sql
alter type public.inventory_movement_type add value 'BARTER_ENTRY';
alter type public.inventory_movement_type add value 'TRANSFER_EXIT';
```

and `0193` is everything that reads them.

On `public.inventory_movements` (`0193`):

| Column | For | Rule |
|---|---|---|
| `invoice_number text` | entries | null for every other type |
| `unit_amount numeric(12,2)` | entries | null elsewhere; `>= 0` |
| `total_amount numeric(12,2)` | entries | null elsewhere; `>= 0` |
| `reserved_for_show_id uuid` | reservations | null elsewhere; composite FK to `shows (id, company_id)` |
| `reverses_movement_id uuid` | reversals and releases | null elsewhere; references `inventory_movements (id)` |

Three constraints, in the shape `0045` already established for
`promotion_prize_id`:

- the invoice trio is permitted only on `INITIAL_ENTRY`, `PURCHASE_ENTRY`,
  `MANUAL_ENTRY` and `BARTER_ENTRY`, and is null on everything else;
- `reserved_for_show_id` is permitted only on `RESERVATION`;
- `reverses_movement_id` is permitted only on the reversal types and on
  `RESERVATION_RELEASE`.

Plus the two that make D2 hold:

```sql
create unique index inventory_movements_reversal_unique
  on public.inventory_movements (reverses_movement_id)
  where reverses_movement_id is not null
    and movement_type <> 'RESERVATION_RELEASE';

create index inventory_movements_invoice_idx
  on public.inventory_movements (company_id, invoice_number)
  where invoice_number is not null;
```

The unique index excludes releases on purpose: one reservation is released in
several instalments, while one entry is reversed once or not at all.

The enumerated bucket-transition constraint is dropped and recreated with
`BARTER_ENTRY` following `PURCHASE_ENTRY`'s pair and `TRANSFER_EXIT` following
`MANUAL_EXIT`'s.

---

## 5. The doors — `0194`

**"Ajuste de estoque" in the Tipo lists is not an entry or an exit.** It is
`adjust_stock`, which exists, has its own permission and writes
`ADJUSTMENT_POSITIVE` / `ADJUSTMENT_NEGATIVE`. The two forms route to it when
that value is chosen and to the entry or exit door otherwise. Widening
`record_stock_entry` to also write adjustments would give this database two
doors that produce the same movement type under two different permissions,
which is the kind of pair that is discovered years later by the one that was
never fixed.

| Door | Change |
|---|---|
| `record_stock_entry` | gains `p_invoice_number`, `p_unit_amount`, `p_total_amount`, and an entry type so Compra and Permuta reach their own movement types |
| `record_stock_exit` | gains an exit type for Envio para outra emissora |
| `reserve_stock` | gains `p_show_id`, null for an anonymous hold |
| `release_reservation` | gains `p_reservation_id` — which reservation is being released — and refuses a quantity larger than what remains on it |
| `reverse_movement` | **new**: the single door behind every Arquivar button |

`reverse_movement(p_movement_id uuid, p_note text)` is where the block's
correctness lives:

- gated on the permission the ORIGINAL movement's kind required, so reversing an
  entry needs what recording one needs;
- refuses a movement already reversed (the unique index is the backstop, the
  check is the message);
- refuses reversing anything but an entry or an exit — a draw, a delivery or a
  promotion link is undone by its own screen's own door, and this door will not
  become a general-purpose eraser;
- **refuses when the stock is no longer there to take back.** Reversing an entry
  of 10 when only 4 remain available is refused rather than driving the bucket
  negative. This is the failure everyone will hit in practice and the message
  must name the number that is in the way;
- writes the mirror movement through `apply_inventory_movement`, with
  `reverses_movement_id` naming the original.

  **Corrected 2026-08-14, during Task 3.** This section first said the reversal
  should carry the original's `invoice_number` "so the pair reads as a pair".
  That contradicts §4 twice over: an entry's reversal is a `MANUAL_EXIT`, and the
  invoice trio is permitted only on entry types — so the row would be refused by
  its own constraint. And it would be wrong even if it were legal: a sum over
  `invoice_number` is how "what did we spend" gets answered, and a reversal
  repeating the number would double-count what it was supposed to cancel. The
  pair reads as a pair through `reverses_movement_id`, which is a pointer rather
  than a repeated string, and the read joins on it;
- writes an `audit_logs` row.

Reservations are released rather than reversed: `release_reservation` already
exists, already checks its own permission, and D5 gives it the reservation to
point at.

---

## 6. The reads — `0195`

`list_movements` is dropped and recreated — it `returns table`, so a replacement
cannot change its shape. **The body comes from `pg_get_functiondef` against the
live database, never from an older migration**; this repository has had a shipped
fix reverted exactly that way, and the discipline is recorded in
`copiar-corpo-de-funcao-para-frente`.

It gains: the invoice trio, `reserved_for_show_id` with the programme's name,
`reverses_movement_id`, a `reversed_at` for the original of a reversed pair, and
`remaining_quantity` for a reservation (its quantity minus the releases pointing
at it). New parameters: a movement-type filter, and the period the Movimentação
tab asks for.

One read serves all five tabs. The three writing tabs pass a type filter; the
Movimentação tab passes none.

---

## 7. The screen

`PRIZE_TABS` goes from `['data', 'movements']` to
`['data', 'entries', 'exits', 'reservations', 'movements']`. `record-params.ts`
records that this tuple is append-only because its first element is where an
unknown `tab=` lands; `data` stays first, so no existing link changes meaning.

**Dados do prêmio** — the balance cards and the record form, as today, with the
four movement forms gone.

**Entradas** — Tipo (Compra · Permuta · Ajuste de estoque), Quantidade, Nota
fiscal, Valor unitário, Valor total (computed, editable — D9), Anotação, and
`Adicionar estoque`. Beneath it, the entries for this prize: invoice number,
date, actor, quantity, value, and an Arquivar action on each. A reversed row is
struck through and names its reversal.

**Saídas** — Tipo (Envio para outra emissora · Ajuste de estoque), Quantidade,
Anotação, `Registrar saída`, and the exits beneath with the same Arquivar.

**Reservas** — Tipo with three values, and the second control follows it:

| Tipo | Second control | What it writes |
|---|---|---|
| Reservar | none | `RESERVATION`, bucket `reserved`, no owner |
| Vincular Programa | Programas — active or starting in the future | `RESERVATION` with `reserved_for_show_id` |
| Vincular Promoção | Promoções — active or starting in the future | the existing promotion link (D6), bucket `linked` |

The history beneath shows each reservation with its remaining quantity (D5) and
an action that releases it. A promotion link is undone by unlinking, which is the
promotion door's business, so that row's action says so rather than offering a
release that would not apply.

**Movimentação** — De, Até, an all-kinds type filter (D10), `Consultar`, and the
unified chronological history.

All five grids carry the actor column (D11). The layouts in the owner's images
are the arrangement; the typography, spacing and colour come from the product's
own tokens, not from the mock-ups.

---

## 8. Permissions

Unchanged, and each tab renders only what its holder may use: `inventory.entry`
for Entradas, `inventory.exit` for Saídas, `inventory.reserve` for Reservas,
`inventory.catalogue` for the record form. Reading the histories is
`inventory.view`, which is what the record dialog already requires. A caller
holding none of the write codes sees five tabs of history and no forms — which is
a useful screen rather than a broken one.

`reverse_movement` deliberately borrows the original movement's permission
rather than inventing an `inventory.reverse`: undoing a purchase entry is the
same authority as making one, and a separate code would be a role nobody has
until somebody remembers to grant it.

---

## 9. What this block does not do

- **No invoice document.** One prize per entry, the number repeated (D3).
- **No delivery for programmes.** A programme reservation is a labelled hold
  (D7).
- **No new dashboard figure.** The invoice amounts are stored and shown on this
  screen; "how much did we spend on prizes" is a report someone asks for later,
  and `unit_amount`/`total_amount` are there when they do.
- **The reconciliation panel is untouched.** It sums the ledger; reversals are
  ledger rows; it keeps working without knowing this block happened, which is
  the whole argument for D1.

---

## 10. Verification

The eight gates in the order `portoes-e-banco-local-sujo` records: typecheck,
lint, unit, `db:reset`, `db:test`, `seed:branding`, e2e, isolation — `db:test`
after the reset and never after an e2e run.

pgTAP carries the weight, and the assertions that matter are the ones about
reversal, because that is where this block can corrupt a balance:

- an entry reversed once succeeds and the balance returns to where it was;
- the same entry reversed twice is refused;
- an entry whose stock has since left is refused, and the refusal names the
  shortfall;
- a reversal of a draw, a delivery or a promotion link is refused;
- the two new movement types write the bucket pairs the constraint expects, and
  a wrong pair is rejected by the constraint rather than accepted;
- the invoice trio is rejected on a non-entry type;
- `reserved_for_show_id` is rejected on anything but a reservation;
- a reservation released in two instalments reports the right remaining quantity,
  and a release larger than the remainder is refused.

Isolation proves the doors stop at the Station boundary — `reverse_movement`
most of all, since it takes a movement id rather than a prize id and is the one
door in this block whose argument does not name a Station.

The e2e journey is one prize through its own record: enter stock with an
invoice, see it in Entradas and in Movimentação, reverse it, watch the balance
return, reserve for a programme, and find the reservation with its owner. One
journey, because the five tabs share one read and one dialog.

---

## 11. Sequence

One block, four tasks, one PR.

- **23a** — `0192` (the two enum values, alone, for the reason §4 gives) and
  `0193`: the columns, the constraints, the indexes, the widened
  bucket-transition check, and the pgTAP for all of it.
- **23b** — `0194`: the widened doors and `reverse_movement`, with its pgTAP and
  the isolation cases.
- **23c** — `0195` and the service layer: the recreated `list_movements`, the
  types, and the reads the five tabs need.
- **23d** — the screen: five tabs, the forms moved, the three histories, the
  actor column, the copy in three languages, and the e2e journey.

---

## 12. After this block

- **Grouping entries by invoice.** D3 leaves the number indexed for exactly this;
  it is a screen, not a migration.
- **A prize-spend report.** The amounts are stored from this block onward, so the
  figure exists for whoever asks — for entries recorded after it ships, and not
  before.
