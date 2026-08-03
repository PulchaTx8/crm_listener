# Block 6d — The clock, the pile it makes, and the way back — Design Spec

**Date:** 2026-08-03
**Status:** approved by the owner
**Amends:** Block 6b (`docs/superpowers/specs/2026-08-02-block-6b-delivery-design.md`) — `winner_status` gains a value 6b argued it would never need
**Amends:** the master spec (`docs/superpowers/specs/2026-07-25-crm-radios-multitenant-design.md`) — §6's deadline cron ships without its notification, which moves to the Templates block
**Depends on:** Block 2 (the ledger and its buckets), Block 6a (the frozen deadline), Block 6b (the winner state machine), Block 6c (the draw the winners come from)

---

## 1. What this block is for

Block 6a froze a pickup deadline onto every winner and nothing has ever read it.
Block 6b built the two ways a prize leaves a winner's hands — returned to stock
or written off — and both need an operator to press something. Between the two
there is a prize sitting on a shelf whose deadline passed in July, that no query
asks about and no screen shows.

This block is the clock that notices, the pile it makes, and the way back out of
that pile when somebody turns up late.

It also gives winners a home. Until now a winner exists only inside the draw
that produced it, on `/promotions/[id]/draws`. Nobody can ask "what is waiting
to be collected in this Station" — which is the question the person behind the
counter has when a listener walks in and does not remember which promotion they
entered.

**What it does not do: notify anybody.** See §8.

---

## 2. Decisions

### D1 — An expired deadline moves the stock, and rests in `pending_return`

The master spec §6 says the deadline cron processes expired deadlines →
`RETURN_PENDING`. Block 6b built `winner_status` without that value and wrote
the reason into `apply_winner_transition`'s comment (`0085_return_prize.sql`):

> A return emits TWO movements, because the ledger has no shortcut from
> `awaiting_pickup` to `available` and `pending_return` is a bucket this passes
> THROUGH rather than rests in — **which is what lets `winner_status` have no
> `RETURN_PENDING`**.

The owner's ruling of 2026-08-03 restores the master spec's reading: when the
deadline passes, the clock moves the winner to `RETURN_PENDING` and the unit
from `awaiting_pickup` to `pending_return`, where it rests. The operator then
finishes — to stock, or written off.

The alternative considered and rejected was deriving "overdue" from
`deadline_at < now()` and leaving both the status and the stock alone. It is
cheaper and it is what 6b's code already assumes. It was rejected because a
prize whose deadline has passed is not in the same commercial state as one
awaiting collection, and a bucket that says so is worth more than a date
comparison repeated in every query that cares.

**Consequence:** 6b's comment is not amended, it is rewritten. The through-
traversal it describes still exists (§4, the operator's early return), but it
stopped being the only thing that happens in that bucket, and a comment whose
justification has been withdrawn is worse than no comment.

### D2 — There is a way back, and it is the deadline that reopens

The ledger admits no arm out of `pending_return` except `available` and
`written_off`. So under D1 alone, a listener arriving two days late — with the
prize still on the shelf — could not be given it, in a system where today that
just works.

The way back is `RETURN_PENDING → AWAITING_PICKUP`, with a new deadline the
operator supplies and a mandatory reason. Delivery is then the ordinary 6b path.

Rejected: `RETURN_PENDING → DELIVERED` directly. It is fewer clicks and it costs
the deadline its meaning — a winner who missed it and one who did not would end
in the same place by the same button, and `DELIVERY` would gain a second legal
source bucket, which every 6b test currently pins to one.

### D3 — Reopening is the one thing that may write `deadline_at`

`apply_winner_transition` states that it NEVER touches `deadline_at`, and 6a's
D5 froze the column at the draw. D2 requires touching it. The two are
compatible and the distinction must be stated where the code is:

6a's D5 protects against **the promotion's configuration being edited in
September and shortening the deadline of somebody who won in August** — a value
leaking into rows it was never agreed for. Granting one named person more time,
deliberately, with an actor and a reason on the history row, is the opposite of
that. The freeze is against drift, not against decisions.

### D4 — Reopening is its own permission

`winners.reopen_deadline`, not folded into `winners.return`. Returning a prize
to stock closes a matter; reopening a deadline grants somebody a second chance
at a prize the Station had recovered. Whoever may do one should not acquire the
other by implication.

### D5 — The clock is SQL, scheduled directly, with no application in the path

`pg_cron` calling `CALL public.sweep_pickup_deadlines()` hourly. Not an HTTP
endpoint, and not folded into the WhatsApp worker's tick.

The whole job is SQL: move a status, emit a movement. `0064` reaches the
application over HTTP because the WhatsApp worker must talk to Meta and
therefore lives in TypeScript; that reason does not apply here. Going through
HTTP would add a URL and a secret to configure — and `docs/block-5a-runbook.md`
has a section on what happens when they are wrong, which is
`net._http_response` filling with failures that describe the environment rather
than the work.

Folding it into the existing ten-second tick (what `0072` did for conversation
sweeping) was rejected for a different reason: it would make prize deadlines in
a Station with no WhatsApp integration depend on the WhatsApp worker running.

Hourly, against day-grained data, bounds the latency at an hour and costs 24
index scans a day instead of 8,640.

### D6 — One poisoned winner must not stop every Station

The sweep is global. If it were one transaction, a single winner whose movement
is refused — an inconsistent `awaiting_pickup` balance for that prize, say —
would roll back every other Station's expirations, every hour, for ever.

So: a procedure, not a function — only a procedure may `commit`. Collect the
candidate ids, then iterate, each winner in its own block with its own exception
handler, `commit` after each. Failures are raised as warnings naming the winner
and the `SQLERRM`.

A procedure cannot return a row, so the run's totals are **raised as a notice**
at the end — `expired`, `skipped`, `failed` — rather than returned. That is not
a workaround: nothing calls this but the scheduler, and the scheduler stores
output, not result sets.

Catching every exception is a smell and it is the price of a sweep that cannot
stop. What makes it acceptable is that the failure is counted and named rather
than swallowed, and that `cron.job_run_details` keeps it — which is where Block
11's §31 alert will read from, alongside the retention cron's (N7). Building
that alerting here would be building it twice.

> **Amended during execution (Task 4).** Measured directly against this
> project's own `pg_cron`, not assumed: `cron.job_run_details` does not
> capture a `WARNING` at all — a disposable job that only raises a warning
> and a notice still records `status=succeeded, return_message='CALL'`. So
> the per-winner detail this paragraph describes — the winner id and the
> `SQLERRM`, raised as a warning inside the loop — reaches the Postgres
> server log and nothing else; it never reaches `cron.job_run_details`. What
> does reach `cron.job_run_details` is only the run's own aggregate outcome,
> and only because Task 4 added an end-of-loop `raise exception` whenever
> any winner failed, after every succeeding winner is already committed:
> without that raise, a run in which every winner failed still recorded
> `succeeded`; with it, such a run now records `failed`. So the aggregate
> failure fact does survive to where the scheduler can see it — the detail
> does not. Block 11's §31 alert will have to read the run-failed-or-not fact
> from `cron.job_run_details` and the per-winner detail — which winner,
> which error — from the server log; it is not all in one place, the way
> this paragraph as first written implied. See `docs/block-6d-report.md`
> §5.5 and §5.6, and `0094_sweep_pickup_deadlines.sql`'s own header and
> exception-handler comments, for the measurement. The broad `exception when
> others` remains justified regardless: the aggregate failure is now visible
> to the scheduler and the detail is recoverable from the server log, which
> is what a sweep that must not stop needs.

Collecting the ids before acting leaves the list microseconds stale, and that is
safe by construction rather than by care: `apply_winner_transition` re-reads and
locks the row and refuses any source that is not `AWAITING_PICKUP`. A winner
delivered between the collect and the act raises and is counted as skipped.

### D7 — Both new lists are `SECURITY DEFINER`, and both re-state every rule

`winners` has a working select policy (`winners_select_by_promotion_view`), so
the winners themselves need no function. The listener's **name** does: it lives
in `members`, behind `members.view`, and a plain join would return null for a
caller holding `promotions.view` without it — indistinguishable from
`members.full_name` being null, which is a real and different thing.

Two shipped decisions disagree about what to do next, and this block follows the
newer and stricter one.

Block 6a's `get_draw` returns the name to anyone holding `promotions.view` —
*whoever may see a draw may see who won it* — and calls itself a narrow door:
the winners of one draw the caller may already see.

Block 6c's `list_participations` ruled the opposite way for a wide list, and
argued it in the migration: name, phone and document **only** to a caller
holding `members.view`; without it the list still lists, with those columns
null; and **a search without `members.view` returns nothing at all**, because
searching a field you may not read is an oracle.

Pickups is a wide list with a search box, so it takes 6c's rule:

- gated on `promotions.view` at the Station, or `42501` — never an empty page;
- the listener's name and phone only with `members.view`, and the list still
  lists without it;
- a search term with no `members.view` returns nothing.

Recorded rather than inherited, because the two precedents point in opposite
directions and picking the looser one by accident would have widened audience
exposure across every promotion in the Station.

**Left open:** `get_draw` is now the odd one out. It is narrow, it shipped, the
owner ruled on it, and nothing here changes it — but a reader comparing the two
functions will find them disagreeing, and the disagreement is real rather than
an oversight.

`list_movements` is `SECURITY DEFINER` for the mirror-image reason:
`inventory_movements.promotion_prize_id` is nullable **with meaning** (a
purchase entry or an adjustment belongs to no promotion), so a promotion name
withheld for lack of `promotions.view` would be indistinguishable from a
movement that has none. Gated on `inventory.view`, it returns the name
unconditionally.

**The trap this decision walks into is documented and this block pays it up
front.** Block 6c's report: a `SECURITY DEFINER` function that replaces a query
under RLS inherits NOTHING. `list_participations` became a function and lost the
rule hiding participations of archived promotions, for five commits, seen by
neither pgTAP (which tests the function's own filters) nor `tsc` nor ESLint nor
Playwright (which used a live promotion). Only the isolation suite found it.

So both functions re-implement, in writing: Station scope per permission (a
caller may hold `promotions.view` in one Station and not another), the archived
-promotion rule, and what happens to a blocked or anonymized listener — which
is that they still appear, because they still won. And `npm run test:isolation`
runs **in the same task that writes each function**, not at the end of the
block.

### D8 — `decodeCursor` is fixed here, because this block is what makes it worse

Carried open since Block 3b and named in Block 6c's report as the owner's to
scope: `decodeCursor` accepts any non-empty string as a cursor id, so a
hand-edited `?after=` reaches Postgres as `id.lt."abc"` and returns `22P02`,
which at least one screen renders verbatim.

Four screens share that door today. Pickups and Movements make it six. The owner
ruled on 2026-08-03 to fix it in this block rather than let the block enlarge a
known hole.

The fix is the one the code already names: a uuid check inside `decodeCursor`,
returning null — its existing contract, *"a bad cursor means start over, never
an error page"*. Safe for all five current callers, which put a uuid primary key
in `cursorFor` without exception, and for both new ones.

The comments describing the hole (`participations/page.tsx`,
`participations/errors.ts`, `participations/list-params.ts`,
`services/participations.ts`) are updated in the same change. A comment that
explains a live defect becomes a lie the moment the defect is fixed.

---

## 3. The data

### 3.1 Two enum values, alone in their own migration

```sql
alter type public.winner_status         add value 'RETURN_PENDING'
  after 'AWAITING_PICKUP';
alter type public.inventory_movement_type add value 'RETURN_PENDING_CANCEL'
  after 'RETURN_PENDING';
```

Alone, because `0082_delivery_movement_type.sql` already hit and documented the
reason: a value added by `ALTER TYPE ... ADD VALUE` cannot be **used** in the
same transaction, and the ledger's CHECK constraint names it as a literal.
Together in one file it fails with `unsafe use of new value`, which reads like a
mystery and is not one.

`RETURN_PENDING_CANCEL` takes its name from the house vocabulary: it is the
inverse of `RETURN_PENDING` exactly as `DELIVERY_CANCEL` is the inverse of
`DELIVERY`.

### 3.2 The ledger gains one arm

`inventory_movements_legal_transition` is dropped and recreated — the surgery
`0083_delivery_ledger.sql` already performed once — with one branch added:

```sql
or (movement_type = 'RETURN_PENDING_CANCEL'
      and from_bucket = 'pending_return' and to_bucket = 'awaiting_pickup')
```

No other arm changes. `pending_return → available`, `pending_return →
written_off` and the two-step traversal from `awaiting_pickup` all stay exactly
as they are.

### 3.3 No new columns on `winners`

Deliberately. The reminder's columns (`reminder_days_before` on prize and
promotion, frozen onto the winner) belong with the mechanism that sends the
reminder, and that mechanism is not in this block (§8). A column with no reader
is debt, and freezing a value at the draw is only meaningful when something
consumes it.

---

## 4. The state machine

```
                    ┌──────────────────────────────────────┐
                    │                                      │
   DELIVERED ◄────────── AWAITING_PICKUP ──────────────┐   │
       │   delivery      │      ▲    │                 │   │
       └─────────────────┘      │    │                 │   │
        deliver_cancel          │    │                 ▼   ▼
             ┌──────────────────┘    │           RETURNED  WRITTEN_OFF
             │    reopen (D2)        │             ▲          ▲
             │    new deadline       │  clock (D1) │          │
             │                       ▼             │          │
             └──────────────────  RETURN_PENDING ──┴──────────┘
```

| transition | movement | buckets | new |
|---|---|---|---|
| `AWAITING_PICKUP → DELIVERED` | `DELIVERY` | `awaiting_pickup → delivered` | |
| `DELIVERED → AWAITING_PICKUP` | `DELIVERY_CANCEL` | `delivered → awaiting_pickup` | |
| `AWAITING_PICKUP → RETURNED` | `RETURN_PENDING` + `RETURN_TO_STOCK` | `awaiting_pickup → pending_return → available` | |
| `AWAITING_PICKUP → WRITTEN_OFF` | `WRITE_OFF` | `awaiting_pickup → written_off` | |
| `AWAITING_PICKUP → RETURN_PENDING` | `RETURN_PENDING` | `awaiting_pickup → pending_return` | ● |
| `RETURN_PENDING → AWAITING_PICKUP` | `RETURN_PENDING_CANCEL` | `pending_return → awaiting_pickup` | ● |
| `RETURN_PENDING → RETURNED` | `RETURN_TO_STOCK` | `pending_return → available` | ● |
| `RETURN_PENDING → WRITTEN_OFF` | `WRITE_OFF` | `pending_return → written_off` | ● |

The two transitions 6b already had out of `AWAITING_PICKUP` **stay**. An
operator returning a prize before its deadline — the listener declined it, or
said they cannot come — is legitimate and must not have to wait for a clock.

`RETURN_PENDING → RETURNED` honours `prizes.allows_return_to_stock` exactly as
the existing path does; the refusal lives in `apply_winner_transition` because
it is a fact about the prize, not about the caller.

### 4.1 The door for reopening

```
reopen_pickup_deadline(p_winner_id uuid, p_deadline_at timestamptz, p_reason text)
```

`SECURITY DEFINER`, and it **deliberately does not mirror its 6b siblings.**
`return_prize` and `write_off_prize` read the winner, raise `P0002` if it is
missing, and only then check the permission — which is the existence leak this
block promised not to extend (§7.2). Since the winner id is the function's only
input, the Station cannot be named by the caller the way `list_participations`
has it named, so the resolution is one query that is already gated:

```sql
select company_id into v_company
  from public.winners
 where id = p_winner_id
   and public.has_permission('winners.reopen_deadline', company_id);
if not found then
  raise exception 'permission denied: winners.reopen_deadline required'
    using errcode = '42501';
end if;
```

An unknown id and an unauthorised Station answer identically. A legitimate
operator with a mistyped id is told "permission denied", which is the cost, and
it is smaller than the alternative. This does not fix the eight that came
before; it declines to become the ninth.

Then it refuses with `22023`, naming the case:

- a source status that is not `RETURN_PENDING`
- `p_deadline_at` at or before `now()` — granting an already-expired deadline
  grants nothing
- an empty reason — mandatory for the same reason the write-off's is: it is the
  only thing that explains, six months later, why that prize became live again

It is the only caller permitted to pass a new `deadline_at` through
`apply_winner_transition` (D3).

---

## 5. The clock

```
sweep_pickup_deadlines()   -- procedure, SECURITY DEFINER
```

> **Amended during execution (Task 4).** The shipped procedure is
> deliberately **not** `SECURITY DEFINER`, and cannot be: Postgres refuses
> `COMMIT` inside a procedure carrying either `security definer` or any
> function-level `SET` clause — both raise `ERROR: invalid transaction
> termination` on the first `COMMIT`, independent of what the loop body does.
> Proved by bisecting the two attributes in isolated, disposable probe
> procedures before this file was written that way; the full argument is
> written out in `supabase/migrations/0094_sweep_pickup_deadlines.sql`'s own
> header comment. Dropping both is safe here for two independent reasons: the
> whole call chain below it (`apply_winner_transition`, then
> `apply_inventory_movement`) is already `SECURITY INVOKER` and checks no
> permission of its own, and `pg_cron` runs a scheduled job as the role that
> called `cron.schedule()` — the migration-owning role, already the owner of
> that chain — so `SECURITY INVOKER` carries exactly the privilege the loop
> body needs. The procedure ships `SECURITY INVOKER`, with `EXECUTE` revoked
> from `public` and granted to nobody else. See `docs/block-6d-report.md`
> §5.7 and the runbook §4 for the operational condition (a hosted deploy
> applying migrations as some role other than the owner) that argument
> depends on.

scheduled by `cron.schedule('pickup-deadline-sweep', '0 * * * *', 'CALL ...')`,
unscheduled-if-exists first, exactly as `0064` does, so `db:reset` and a hosted
redeploy can both re-run the migration.

**Standard five-field cron syntax, not `'1 hour'`.** `0064` uses an interval
and had to document that second-level schedules need `pg_cron >= 1.5`, with a
fallback for older installs. Hourly work has no such requirement: `'0 * * * *'`
is understood by every version, so this schedule carries no version note and
needs no fallback.

The candidate query is the one `winners_deadline_idx` (`0075:178`) was built
for and has never served:

```sql
select id from public.winners
 where status = 'AWAITING_PICKUP'
   and deadline_at is not null
   and deadline_at <= now()
```

**`deadline_at is not null` is not defensive typing.** `0075` wrote the rule
down: null means this winner has NO deadline, because neither the promotion nor
the prize set one, and *"a Station that has not configured one has not agreed to
a rule"*. A sweep that treated null as zero would start clocks nobody agreed to.

Then, per D6: iterate the collected ids, each in its own sub-block, calling

```sql
apply_winner_transition(v_id, 'RETURN_PENDING', 'pickup deadline expired')
```

and committing after each.

**Who did it: nobody.** `auth.uid()` is null under `pg_cron`, and all three
columns that record an actor are nullable — `winner_status_history.changed_by`,
`inventory_movements.actor_id`, `audit_logs.actor_id`. The null is recorded
honestly and the screens render it as *(deadline)* rather than as an empty name.
`apply_inventory_movement` does not gate on permission — the gates live in the
door functions — so nothing in the chain needs a caller.

**Re-running is safe, and not because the sweep is careful.**
`apply_winner_transition` refuses any source that is not `AWAITING_PICKUP`.
Twice in one hour, or once after a week of downtime, produce the same result.

---

## 6. The screens

### 6.1 Navigation

```
Inventory                          Promotions
  Stock      /inventory              Promotions  /promotions
  Movements  /inventory/movements    Pickups     /pickups
```

The existing item changes label only — `Inventory → Stock` — and keeps its
route, so no existing link breaks.

### 6.2 Pickups

One row per winner across every promotion of the Station, keyset paginated on
`(deadline_at, id)` ascending per the Block 3b pattern, read through
`list_pickups` (D7). Soonest first, because the row that needs attention is the
one about to expire.

**Nulls last, and the ordering and the filter must agree on it** —
`keysetFilter`'s contract says so in as many words. `deadline_at` is nullable
and the null means a winner with no deadline at all (§5), so those rows are a
terminal region the paging has to be able to reach: they sit after every dated
row, and both the `order by` and the cursor filter are built `nullsLast`.

Filters: status (`awaiting pickup` / `return pending` / `delivered` /
`returned` / `written off` / all), free-text search on the listener, promotion.

Columns: listener, prize, promotion, status, deadline.

Actions are 6b's plus D4's, each permission-gated and each offered only where it
is legal — deliver from `AWAITING_PICKUP`; undo delivery from `DELIVERED`;
return and write off from either open status; reopen only from
`RETURN_PENDING`. `src/components/draws/winner-actions.tsx` already exists and
is reused rather than reimplemented.

**The deadline column tells the truth about the clock.** Up to an hour passes
between a deadline expiring and the sweep running, and in that window the row is
still `AWAITING_PICKUP` with a deadline in the past. The column renders "overdue
by X" from the date regardless of status, so the screen never claims a prize is
fine because the cron has not been round yet.

### 6.3 Movements

The whole Station's ledger, newest first, keyset paginated on `(created_at, id)`,
read through `list_movements` (D7).

Filters: movement type, prize, promotion, period.

Columns: date, type, prize, quantity, `from → to`, promotion, actor, note.

**No actions.** The ledger is append-only by grant — no role holds UPDATE or
DELETE on `inventory_movements` — and a mistake is corrected by a new movement,
the way a bank statement is corrected by a reversal. A screen offering to edit
a row would be offering something the database refuses.

The actor column renders *(deadline)* when `actor_id` is null on a movement the
sweep produced.

---

## 7. Verification

The standing gates: Vitest, pgTAP, the isolation suite, Playwright,
`lint`/`typecheck`/`build`.

**pgTAP — the state machine.** Every new arc emits the right movement between
the right buckets; every illegal arc is refused. Reopening writes `deadline_at`
**and nothing else** — a test asserting only the status would pass a
transition that zeroed the deadline. Reopening refuses a past date, an empty
reason and a non-`RETURN_PENDING` source. `RETURN_PENDING → RETURNED` honours
`allows_return_to_stock`. The ledger CHECK admits `RETURN_PENDING_CANCEL` in one
direction and refuses the reverse.

**pgTAP — the clock.** It expires what is due; it **skips a null
`deadline_at`**; it skips a winner no longer `AWAITING_PICKUP`; two runs equal
one run.

And the one that needs setting up: **a poisoned winner does not stop the
others.** Force one winner's movement to fail, assert the rest expired and the
failure count rose. Without it, D6's commit-per-winner is an intention living in
a comment.

**Isolation.** `list_pickups` and `list_movements` under a real user's JWT:
another Station is refused, an archived promotion does not leak, and the
permission gate answers before existence does. Run in the task that writes each
function (D7).

**Vitest.** Filter and cursor parsing for both screens; the map of which action
is offered from which status; `decodeCursor` rejecting a non-uuid id and
returning null (D8).

**Playwright.** The full way round: a winner whose deadline is already past, the
sweep called directly rather than waited for, the row appearing as overdue, the
reopen giving the prize back, and delivery working afterwards.

### 7.1 Migrations

```
0091  the two enum values, and nothing else
0092  the ledger arm + apply_winner_transition with the four new arcs
0093  the winners.reopen_deadline permission + reopen_pickup_deadline
0094  sweep_pickup_deadlines() + cron.schedule
0095  list_pickups
0096  list_movements
```

One migration per reviewable unit rather than per theme: `0092` rewrites a
function every delivery already depends on, and `0095`/`0096` each carry the
`SECURITY DEFINER` re-statement of D7. Bundling them would make the diff that
matters unreadable.

`0092` also corrects a comment that is already wrong: the `RETURNED` branch says
the traversal is what *"lets `winner_status` keep the **five** values 6a froze"*.
The enum has had four since 6c withdrew `SUPERSEDED`.

> **Amended during execution (Task 5, Task 12).** A seventh migration,
> `0097_cancelled_draw_awards_nothing.sql`, was added mid-block, after this
> spec was approved — this list was never updated to include it. It was added
> on the owner's ruling of 2026-08-03, after a review reproduced a live stock
> theft: `cancel_draw` (0079) leaves a cancelled draw's winners
> `AWAITING_PICKUP` on purpose while returning their unit to `linked`, and
> `apply_winner_transition` never consulted `draws.status` — so a cancelled
> draw's phantom winner could be delivered (or expired, or returned) and
> silently consume a genuinely live winner's unit of the same prize, with no
> error anywhere. `0097` makes `apply_winner_transition` refuse every
> transition on a cancelled draw's winner, in the core function rather than in
> any one door, so a screen or caller that forgets to check `draws.status` is
> merely inconvenienced rather than able to move somebody else's prize. See
> `docs/block-6d-report.md` §4 and `0097`'s own header for the reproduction.

### 7.2 Inherited, unchanged

The error-code existence leak (`P0002`/`42501` answered before the permission
gate) stands at eight migrations. This block's four add no ninth instance: every
new function checks permission before it reveals whether a row exists.

> **Amended during execution (Task 3, Task 11).** "Eight migrations" was never
> a counted figure — it originated in the 6c report and was repeated here
> unchecked. This block counted it properly, twice, independently (once per
> task, matching exactly): **45** currently-defined functions raise `P0002`
> for a missing row before any permission check in the same body; **5** check
> permission first; **9** raise `P0002` with no permission check in the same
> body at all (private helpers called from an already-gated caller, or
> self-scoped operations with no caller-supplied target). See
> `docs/block-6d-report.md` §5.3 for the method and the full per-function
> lists. Neither "eight" nor this block's own rough interim guess of "twenty"
> survived being counted; the new functions this block added to that
> census — `list_pickups`, `list_movements` and `reopen_pickup_deadline` —
> add no new instance either way. `apply_winner_transition` (0092, superseded
> by 0097) and `sweep_pickup_deadlines` (0094) are both `SECURITY INVOKER`
> and check no permission of their own, so neither is a permission-gated door
> and neither belongs to this count in the first place.

The Block 4b isolation flake remains live and uncaused. It did not appear in 6c.

---

## 8. Out of scope — this is the Templates block

**No notification is sent.** The clock moves the stock in silence and the
operator finds out from the Pickups screen.

The owner chose (2026-08-03) a single notification for the deadline: a
**reminder before it expires**, not an announcement after — telling somebody
they have lost a prize is noise without an action, and the person who needs to
act is the operator.

That reminder cannot be built here. It is sent days after the draw, on the
Station's initiative, outside WhatsApp's 24-hour customer service window, and
Meta accepts such a message **only as an approved template**. Block 5a foresaw
this precisely, in `src/lib/integrations/whatsapp/graph.ts`:

> Block 6's first Station-initiated message — a draw result — will need a
> template, and this method is not it.

Building that path means a `template` column on `outbox_messages` with its shape
constraint, a third rewrite of `claim_outbox_messages`, a `parseTemplate` and
`buildTemplatePayload` mirroring `interactive.ts`, `sendTemplate` on the
transport and its interface, a dispatch branch in `drainOutbox`, an extra
argument on `enqueue_whatsapp_outbound` (a DROP and recreate — `0047`'s trap),
template name and language in the environment, and a runbook for registering and
getting it approved. Roughly the size of this whole block, and it is a platform
door rather than a deadline feature: the same one that will carry draw results,
delivery confirmations, and Block 10's per-Station WABA.

It belongs to the **Templates block**, agreed with the owner on 2026-08-03: a
new sidebar section with three screens —

- **System Templates** — what is hardcoded in `src/lib/conversation/engine.ts`
  today (`REFUSAL_MESSAGE`, `ABANDON_MESSAGE`, the eight `FIELD_PROMPTS`), made
  per-Station, **plus behaviour that does not exist yet**: an inactivity
  timeout, auto-reply toggles, and refusals for audio and for calls.
- **Interaction Templates** — the conversation's own texts. Partly live already
  as per-promotion data (`promotion_questions.prompt`, menu titles, button
  labels, call to action); the rest is the music-request flow, which has nothing
  to configure until Block 7.
- **Meta Templates** — the approved-template registry and the sending path
  above. **The pickup reminder ships here.**

Its position in the sequence is undecided and is the owner's to set when this
block closes; the music half cannot precede Block 7.

Also still out of scope, and unchanged from 6c: the `offered_count` column that
does not measure what §3.2 of the 6c spec wanted it to.
