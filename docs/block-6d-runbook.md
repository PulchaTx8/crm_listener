# Block 6d — The clock that finds a missed pickup

**Audience:** whoever operates a Station, and whoever gets asked "did the
system forget about this prize?"

A pickup deadline (frozen at the draw, Block 6a) used to sit on the record
with nothing ever reading it. This block adds the clock: an hourly job that
notices an expired deadline, parks the prize, and two screens so an operator
can find and finish what the clock started.

---

## 1. Where it lives

**Promotions → Pickups**, or `/pickups` — every winner across every
promotion of a Station, soonest deadline first. This is where an operator
looks when a listener walks in and does not remember which promotion they
entered.

**Inventory → Movements**, or `/inventory/movements` — the Station's whole
stock ledger, newest first, append-only. This is where "what happened to
this prize" gets answered, including the row the clock itself wrote.

**Inventory → Stock** (`/inventory`, unchanged route) is now labelled
**Stock** rather than **Inventory** — the section heading one level up is
now **Inventory**, and having the section and its only item spell the same
word read as one link twice.

---

## 2. Confirming the schedule is installed

```sql
select jobname, schedule, command
from cron.job
where jobname = 'pickup-deadline-sweep';
```

A healthy install returns exactly one row:

| jobname | schedule | command |
|---|---|---|
| `pickup-deadline-sweep` | `0 * * * *` | ` call public.sweep_pickup_deadlines(); ` |

`0 * * * *` is standard five-field cron for "the top of every hour" — not the
`'1 hour'` interval form Block 5a's outbound-tick job uses, which needs
`pg_cron >= 1.5`. This schedule needs no version note.

No row at all means the migration that schedules it (`0094`) has not been
applied against this database, or something has since called
`cron.unschedule('pickup-deadline-sweep')`. Re-applying `0094` is idempotent —
it unschedules-if-exists before scheduling, the same shape Block 5a's own
tick job uses, specifically so a hosted redeploy or a local `db:reset` can
run it more than once without `cron` raising "job already exists."

---

## 3. Reading a run

```sql
select runid, status, return_message, start_time, end_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'pickup-deadline-sweep')
order by start_time desc
limit 20;
```

**What `status = 'succeeded'` tells you, and what it does not.** A clean run
with nothing due looks exactly like this (a real row from this local stack):

| runid | status | return_message |
|---|---|---|
| 381 | succeeded | `CALL` |

`return_message` here is the completion status of the `CALL` itself, nothing
more — it is **not** a summary of what happened inside the procedure.
`sweep_pickup_deadlines` writes its own notice — `pickup deadline sweep: N
expired, M failed` — with `raise notice`, and a `NOTICE` (like a `WARNING`)
never reaches `cron.job_run_details` at all. It lands in the **Postgres
server log**, not this table. Measured directly against this project's own
`pg_cron`: a disposable job that only raises a warning and a notice still
records `status = succeeded`.

**What `status = 'failed'` tells you.** `sweep_pickup_deadlines` raises an
exception at the very end of its loop whenever at least one winner's
transition failed — after every succeeding winner in that same run is
already committed, so a `failed` status never means the run undid anything.
It means: **at least one winner in this run could not be moved**, and the
name of that winner and the reason are in the server log, not in this table.
`return_message` for a failed run reads
`pickup deadline sweep: N of M due winner(s) failed -- see the server log
for which` — literally telling you where to look next.

**A `failed` status that repeats hour after hour is not N separate
incidents.** A winner whose movement can never succeed — the balance for its
prize is already wrong, say — stays `AWAITING_PICKUP` and overdue, so every
future run re-selects it, re-fails it, and re-raises. Seeing `failed` on ten
consecutive hourly runs most likely means **one** stuck winner, not ten.
Cross-check the winner from the server log against `/pickups` (its deadline
will still read overdue) before assuming there are several.

---

## 4. Running the sweep by hand

`sweep_pickup_deadlines` is `EXECUTE`d by nobody except the owner of the
migrations — not `authenticated`, not `service_role`. This is deliberate: the
chain it calls (`apply_winner_transition`, `apply_inventory_movement`) is
`SECURITY INVOKER` and none of it checks a permission, on the reasoning that
the caller is trusted to be the scheduler itself. A `service_role` call would
fail every winner (no `EXECUTE` on `apply_winner_transition`), have every
failure swallowed by the sweep's own handler, and still report success —
having done nothing.

So running it by hand means a direct connection as the same role that owns
the migrations — locally, `psql` or any Postgres client against
`supabase status`'s `DB_URL`, connected as `postgres`:

```sql
call public.sweep_pickup_deadlines();
```

It is safe to run more than once in the same hour, or after a week of
downtime: `apply_winner_transition` refuses any source that is not
`AWAITING_PICKUP`, so a winner already moved by an earlier run is simply
skipped by the next one, not double-processed.

**On a hosted deployment, this is only as safe as the role that applied the
migrations.** The whole argument for the sweep needing no permission check of
its own rests on `pg_cron` running a scheduled job as the role that called
`cron.schedule()` — the migration-running role. If a hosted deploy ever
applies migrations as some other, lower-privileged role, that role — not
`postgres` — is who the sweep runs as in production, and the argument has to
be re-checked against whatever that role can actually do.

---

## 5. What an operator sees when a deadline expires

**Nothing, for up to an hour.** The sweep runs on the hour, not the instant a
deadline passes. Between the deadline passing and the next run, the winner's
row is still `AWAITING_PICKUP` with a deadline in the past — and the
`/pickups` screen tells the truth about that window: the Deadline column
reads **"overdue by X"** from the date itself, regardless of what the Status
column still says, because a screen that waited for the status to catch up
would tell an operator a prize is fine for the whole hour it is not.

Once the sweep has run, the row's status becomes **Return pending** and its
prize's unit is recorded in the `/inventory/movements` ledger as a
`RETURN_PENDING` movement — from `awaiting_pickup` to a new bucket,
`pending_return`, where it rests. Nobody caused this: `auth.uid()` is null
under `pg_cron`, so the movement's actor is null, and both screens render
that as **"(deadline)"** rather than as an empty name or a guess.

**Nothing is sent to the listener.** No message, no reminder — see the block
report (`docs/block-6d-report.md`) §5.1 for why, and where that reminder
actually lands (the Templates block).

---

## 6. Reopening a deadline

For the listener who turns up after the clock has already parked their
prize — the ordinary case this whole block exists for.

On `/pickups`, a **Return pending** row offers a small form beside the usual
actions: a new deadline (typed in the Station's own timezone) and a mandatory
reason. Submitting it:

- moves the winner back to **Awaiting pickup**;
- moves the unit back from `pending_return` to `awaiting_pickup`, recorded as
  a `RETURN_PENDING_CANCEL` movement — the exact inverse of the sweep's own
  `RETURN_PENDING`, the same relationship `DELIVERY_CANCEL` has to `DELIVERY`;
- sets `deadline_at` to the date given, which is the **only** path in this
  schema that changes a deadline after the draw. 6a's freeze on `deadline_at`
  was never about forbidding a deliberate second chance — it was about a
  promotion's own configuration silently drifting into rows it was never
  agreed for. Naming a person, an actor and a reason on the record is the
  opposite of drift.

From there the prize is handed over exactly as any other `Awaiting pickup`
winner (Block 6b's own path) — **Reopen** does not skip to `Delivered`
directly, on purpose: a winner who missed the deadline and one who never did
would otherwise end at the same button, and the deadline would stop meaning
anything.

**Its own permission**, `winners.reopen_deadline` — not folded into
`winners.return`. Recovering a prize and giving someone a second chance at
one are different decisions, and holding one does not grant the other.

**What it records, and what it does not.** `winner_status_history` gets a row
(`RETURN_PENDING → AWAITING_PICKUP`, the reason, who did it, when), and the
movements ledger gets the `RETURN_PENDING_CANCEL` row above. What is **not**
separately recorded is the deadline's own old value — `winners.deadline_at`
is overwritten in place, so the extension granted is not itself recoverable
from the audit trail; only that a reopen happened and why. This is a known
gap, not an oversight, and it is the owner's to decide whether it is worth
closing.

**Refused, mandatory reason and a future deadline both:** the RPC behind this
form (`reopen_pickup_deadline`) will not accept a blank reason or a deadline
at or before the moment it runs — both come back before anything is written.

---

## 7. Refusals you may meet

| Message | Cause |
|---|---|
| *permission denied: winners.reopen_deadline required* | Answered for **both** an unknown winner id and a Station the caller holds no role in — deliberately, unlike `return_prize`/`write_off_prize`, which answer differently for the two (see the block report §5.3). A typo in an id reads the same as lacking the permission. |
| *reopening a deadline needs a reason* | The reason field was blank. |
| *the new deadline must be in the future* | The date chosen is at or before now. |
| *a prize that is AWAITING_PICKUP cannot have its deadline expire* (or similar, from `apply_winner_transition`) | Something other than the sweep tried to move a winner into `RETURN_PENDING` from a status that is not `AWAITING_PICKUP` — should not happen from either screen. |
| *permission denied: promotions.view required* | `/pickups` and `list_pickups` both need this at the Station, and answer with a refusal rather than an empty page. |
| *permission denied: inventory.view required* | The same shape, for `/inventory/movements` and `list_movements`. |

---

## 8. "Was this listener's name visible to whoever looked?"

`/pickups` shows a winner's name and phone only to a caller who also holds
`members.view` — without it, the row still appears, with those two fields
blank. This is **not** the same rule `get_draw` uses for one draw's own
winners (which shows the name to anyone holding `promotions.view` alone,
Block 6a/6c's own ruling) — the two are deliberately different, because a
wide list with a search box is a different question from one narrow draw the
caller already reached. Searching by listener, specifically, needs
`members.view` too: without it the search box is visible but disabled, and a
caller without the permission who bypasses the screen entirely gets **no**
rows back for a search term, not a widened list — searching a name you may
not read would otherwise answer "is there a listener called X here?" to
someone who is not supposed to know.
