# Block 6b — Handing a prize over, and taking it back

**Audience:** whoever operates a Station, and whoever has to answer a listener
asking what happened to their prize.

Block 6a ends at the moment somebody has won. This is everything an operator
does deliberately from there. What the **clock** does — a deadline expiring, a
runner-up being promoted — is Block 6c and does not exist yet.

---

## 1. The four actions, and when each is offered

A winner's row on **Promotions → the promotion → Prizes tab → "Sorteios desta
promoção"** offers only what its current state allows:

| The prize is | You may | You may not |
|---|---|---|
| **Aguardando retirada** (`AWAITING_PICKUP`) | Entregar · Devolver ao estoque · Dar baixa | Desfazer — there is nothing to undo |
| **Entregue** (`DELIVERED`) | Desfazer entrega | Devolver or dar baixa — undo the delivery first |
| **Devolvido** / **Baixado** | nothing | this is the end of the line |

Each needs its own permission: `winners.deliver`, `winners.deliver_cancel`,
`winners.return`, `winners.write_off`. Holding one grants none of the others —
recovering a prize and destroying one are different decisions, and so are doing
a thing and undoing it.

**A reason is mandatory** for undoing, returning and writing off. It is
**optional** for delivering: handing a prize to the person who won it is what
was supposed to happen.

---

## 2. Devolver ao estoque, or dar baixa?

- **Devolver ao estoque** puts the unit back in `available`, where it can be
  linked to another promotion. The promotion's own figures drop by one:
  a returned unit is no longer *Vinculado* or *Sorteado* for it.
- **Dar baixa** takes the unit out of stock for good. The promotion keeps
  counting it, because it was that promotion that consumed it.

**Some prizes offer only the write-off.** A prize registered with *"não volta ao
estoque"* — a personalised item, something perishable, a ticket to a date that
has passed — has its Devolver button hidden, and the system refuses it by name
if asked anyway. That flag is set when the prize is registered, by whoever knows
the answer.

---

## 3. Undoing a delivery

For the ordinary mistake: the operator clicked the wrong winner.

The unit goes back from *entregue* to *aguardando retirada*, the reason is
recorded with who gave it, and the winner is waiting again.

**Two things it deliberately does not do:**

- **It does not move the deadline.** The deadline was fixed at the draw. If it
  passed while the delivery stood, the winner comes back **already overdue** —
  which is true, and is what Block 6c will act on.
- **It does not delete the receipt.** A receipt is a photograph of a real
  handover; deleting it because somebody corrected a record would destroy
  evidence. It stays on the winner.

A consequence worth knowing: **a re-delivered prize cannot be given a second
receipt.** There is one slot, and the first one already shows the same person
receiving the same prize.

---

## 4. The receipt

**Optional, always.** A delivery is recorded whether or not a receipt is
attached, and the button to attach one appears **only after** the delivery is on
the record. That order is deliberate: a prize that has physically left your
hands must be recordable even if the upload fails.

The file lives in a **private bucket**. It is never a public link — the screen
shows it through a short-lived signed URL, and reading one needs
`promotions.view` at that Station.

**"sem recibo"** means none was attached. **"recibo apagado a pedido"** means
there was one and the listener asked to be erased. Those are different facts and
the screen says which.

---

## 5. When a listener asks to be erased

Erasing a listener (Block 3) now reaches their delivery receipts. The image goes;
the **delivery does not** — the movement, who recorded it and when survive,
because those are facts about stock rather than about a person.

**The part worth understanding, because it is not instantaneous:**
clearing the reference happens immediately, in the same transaction as the rest
of the erasure. **Deleting the file itself happens on the next worker tick**,
because a database cannot delete a file in object storage — removing the row
takes the metadata and leaves the bytes.

So: if the worker is not running, erasures are **recorded and not finished**, and
nothing on any screen will say so. To check the backlog:

```sql
select count(*) filter (where processed_at is null)  as still_queued,
       count(*) filter (where attempts > 0
                          and processed_at is null)  as failing,
       max(attempts)                                 as worst
from public.storage_erasure_queue;
```

`still_queued` should return to zero within a tick or two. A row with a high
`attempts` and a `last_error` is one the storage API keeps refusing — it is
retried for ever on purpose, because an erasure that quietly gave up is worse
than one that visibly has not finished.

---

## 6. "What happened to this prize?"

Every change is on the record, with who made it and why:

```sql
select h.changed_at, h.from_status, h.to_status, h.reason, h.changed_by
from public.winner_status_history h
where h.winner_id = '<winner id>'
order by h.changed_at;
```

A prize delivered, undone and delivered again shows all three rows. The stock
side of the same story is in `inventory_movements` for that promotion link, and
the two are written in the same transaction, so they cannot disagree.

---

## 7. Refusals you may meet

| Message | Cause |
|---|---|
| *this prize is already DELIVERED* | Somebody else got there first — refresh. |
| *a prize that is DELIVERED cannot be returned to stock* | Undo the delivery first; that is a decision somebody has to put on the record. |
| *the prize "…" is registered as one that cannot go back to stock* | Write it off instead. |
| *this change needs a reason* | Everything except a delivery needs one. |
| *this delivery already has a receipt* | One slot per winner. Only an erasure clears it. |
| *a receipt belongs in its own Station's folder* | The upload was aimed at another Station. Should not happen from the screen. |
| *permission denied: winners.… required* | The role lacks that specific code; the other three do not cover it. |
