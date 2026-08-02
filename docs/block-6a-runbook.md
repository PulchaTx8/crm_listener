# Block 6a — Running a draw, and checking one

**Audience:** whoever operates a Station, and whoever has to answer a listener
who did not win.

---

## 1. What the operator is choosing

The draws of a promotion live at **Promotions → open the promotion → Prizes tab
→ "Sorteios desta promoção"**, or directly at
`/promotions/<promotion id>/draws`.

Running a draw asks two questions and nothing else:

| Choice | Default | What it means |
|---|---|---|
| How many units of each prize | everything still available | `linked − drawn` for each live link. A Station with ten units may draw three now and seven next month (D8). |
| How many runners-up | 3 | One ordered queue for the whole draw, not one per prize (D4). |

Pressing **Sortear** does all of this in a single transaction: the eligible
entries are frozen, the winners are picked, one unit per winner moves from
`linked` to `awaiting_pickup` in the inventory, and each winner's deadline is
written. If any part of it fails, none of it happened.

**Who may press it:** `draws.execute`. Cancelling is a separate permission,
`draws.cancel`, and holding one does not imply the other.

---

## 2. Who is in the hat

One entry per **VALID participation**, not per person (D1). Somebody who entered
three times has three chances.

A participation is in the hat when all of these hold:

- its status is `VALID` — `DUPLICATE`, `TOO_SOON` and `OVER_LIMIT` are records
  of an attempt, not entries;
- the listener is not archived and not erased;
- the listener is **not blocked** — both a `draw_ban` and a `suspension`
  exclude (D6).

A person wins **at most one prize per draw** (D2). Once they win, their
remaining entries leave the hat, and they cannot also appear in the runner-up
queue.

**If nobody is eligible, the draw is refused** rather than recorded as an empty
draw. Nothing happened, and a row saying it did is worse than none.

**If there are fewer people than prizes,** the draw awards what it can and says
so. That is not an error.

---

## 3. The deadline

Two settings, both in days:

- `prizes.default_pickup_deadline_days` — the prize's own default;
- `promotions.pickup_deadline_days` — overrides it for this promotion.

At the draw, each winner's `deadline_at` is written once as
`drawn_at + coalesce(promotion, prize) days`. **Editing either setting later
does not move a deadline that has already been written** — somebody who won in
August keeps the rule that applied in August (D5).

**When neither is set, the winner has no deadline** and the screen says *sem
prazo*. That is deliberate: a Station that has not configured a deadline has
not agreed to one, and inventing thirty days would start a clock nobody set.

---

## 4. How somebody outside the company re-checks a draw

This is the point of the block. A draw is not "trust the system" — it is a
deterministic function of three things the record holds: the **seed**, the
**frozen entry list**, and the **algorithm version**. All three are on the draw
screen and in the database.

### 4.1 What to collect

```sql
-- The seed and the contract version.
select seed, algorithm_version, entry_count, runner_up_count, drawn_at
from public.draws
where id = '<draw id>';

-- The hat, exactly as it was frozen. The order matters.
select position, participation_id, member_id
from public.draw_entries
where draw_id = '<draw id>'
order by position;

-- What the draw claims happened.
select awarded_rank, participation_id, member_id, promotion_prize_id
from public.winners
where draw_id = '<draw id>'
order by awarded_rank;

select position, participation_id, member_id
from public.draw_runners_up
where draw_id = '<draw id>'
order by position;
```

### 4.2 The recipe (algorithm version 1)

1. For every entry, compute the ranking value

   ```
   sha256( seed || ':' || participation_id )
   ```

   over the **UTF-8 bytes** of that string. The `participation_id` is the
   ordinary lowercase hyphenated UUID text.

2. Sort the entries by that value **ascending, compared as bytes**. Where two
   values tie, the lower `position` comes first. (A tie is astronomically
   unlikely and is defined anyway, because "unlikely" is not a rule a
   reproduction can follow.)

3. Build the unit sequence: for each `(promotion_prize_id, quantity)` the
   operator drew, expand it to unit 1..quantity, and order the whole sequence
   by `promotion_prize_id`, then unit index. Its positions are `awarded_rank`
   1, 2, 3…

4. Walk the sorted entries from the top. For each unit in turn, take the next
   entry whose **listener has not already been awarded** in this draw. Stop when
   the entries run out.

5. Keep walking, same skip rule, for `runner_up_count` more entries. Those are
   the runners-up, in order.

The names you get must match `winners` and `draw_runners_up` exactly, in order.

### 4.3 Doing it in SQL, against the live record

```sql
with ordered as (
  select e.participation_id,
         e.member_id,
         e.position,
         sha256(convert_to(d.seed || ':' || e.participation_id::text, 'UTF8')) as rank_value
  from public.draw_entries e
  join public.draws d on d.id = e.draw_id
  where e.draw_id = '<draw id>'
),
best as (
  -- each listener's best entry: the first time they appear in rank order,
  -- which is exactly the entry the walk would stop on
  select distinct on (member_id) participation_id, member_id, position, rank_value
  from ordered
  order by member_id, rank_value, position
)
select row_number() over (order by rank_value, position) as place,
       participation_id, member_id
from best
order by place;
```

`place` 1..N are the winners in `awarded_rank` order, and the places after them
are the runner-up queue in order.

### 4.4 Doing it in any language

`src/lib/draw/algorithm.ts` is a complete, dependency-free implementation of the
same contract, written independently of the SQL one. It is roughly forty lines
and can be transliterated into anything.

**Why two implementations exist:** everywhere else this project insists a rule
has exactly one home. Here two are the point — a verifier that shared code with
the executor would prove only that the code equals itself.
`tests/isolation/draw.test.ts` runs a real draw in Postgres and recomputes it in
TypeScript from nothing but the stored seed and the frozen hat, and requires the
two lists to match in order.

### 4.5 "Was I in it?"

```sql
select e.position, e.participation_id
from public.draw_entries e
join public.members m on m.id = e.member_id
where e.draw_id = '<draw id>'
  and m.id = '<member id>';
```

No rows means that listener was not in the hat. The reasons are the list in §2 —
most often the participation was not `VALID`, or the listener was blocked. An
excluded participation is deliberately **not** recorded in `draw_entries`: the
hat is what was drawn from, and an entry that could never have been picked would
make the reproduction disagree.

---

## 5. Cancelling a draw

**Who:** `draws.cancel`, which is not implied by `draws.execute`. Cancelling
un-awards prizes somebody has already been told they won.

**What it does:** every awarded unit goes back from `awaiting_pickup` to
`linked`, one ledger movement per winner, and the draw is marked `CANCELLED`
with the time, the person and a **mandatory reason**.

**What it does not do:** delete anything. The hat, the seed and the winners all
survive, and the draw stays reproducible — the record of a cancelled draw is the
evidence that it was cancelled and by whom (D7).

**When it is refused:**

| Situation | Why |
|---|---|
| Already cancelled | Cancelling twice would return the units twice. |
| Blank reason | A cancellation that does not say why is the one thing a cancelled draw must say. |
| Any winner no longer `AWAITING_PICKUP` | Putting a prize somebody already collected back into `linked` would invent stock the Station does not have. Block 6a cannot produce such a winner; the guard is here so 6b cannot open the hole by forgetting it. |

There is no un-cancel. Run a new draw.

---

## 6. Refusals you may meet, and what they mean

| Message | Cause |
|---|---|
| *nobody is eligible for this draw* | No `VALID` participation from an unblocked, live listener. |
| *this promotion does not have that many units still to draw* | Asked for more than `linked − drawn`. Someone may have drawn since the screen loaded. |
| *this promotion has no units left to draw* | Nothing linked, or everything already drawn. |
| *this promotion is cancelled and cannot be drawn* | A cancelled promotion awards prizes for something that is not happening. |
| *promotion not found* | Archived, or not at a Station you can reach. |
| *permission denied: draws.execute required* | The role lacks the code. |

---

## 7. Two things worth knowing

**Drawing while the promotion is still open is allowed.** The hat is whatever
was valid at that instant, and the record says when. Entries that arrive
afterwards are simply not in that draw.

**Whoever may see a draw sees who won it.** The names of winners and
runners-up come back to anybody holding `promotions.view` — no `members.view`
required, so the operator who runs a draw can tell the winner they won without
also being given the audience.

Worth knowing when handing out roles: this is the one place where
`promotions.view` alone reveals a listener's name. It is limited to the winners
and the queue of a draw that person may already see — never the audience list,
and never a phone number, an e-mail or a note.

A blank name on the screen means the listener has no name on record — an erased
one, most likely — and never that you are not allowed to see it.
