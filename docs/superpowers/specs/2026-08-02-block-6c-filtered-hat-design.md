# Block 6c — The filtered hat — Design Spec

**Date:** 2026-08-02
**Status:** approved by the owner
**Corrects:** Block 6a (`docs/superpowers/specs/2026-08-02-block-6a-draw-design.md`)
**Depends on:** Block 4a (promotion questions), Block 4c (participations and their answers), Block 6a (the draw), Block 6b (delivery)

---

## 1. What this block is for

Two defects in Block 6a, both found by the owner asking what a runner-up is and
then describing how a draw is actually run.

**Defect one: the draw ignores the quiz.** `draw_eligible_participations` (0076)
builds the hat from `status = 'VALID'`, a live listener and no block, and never
reads an answer. On a promotion with a question, the bicycle can go to somebody
who answered wrong.

This was written down a whole block earlier and nobody read it back.
`0052_participations.sql:172`, on `participation_answers`:

> *"What the person answered, not whether they were right. **Block 6 derives
> correctness at draw time** by joining `promotion_question_options.is_correct`;
> storing a flag here would be a second place telling the same truth."*

Block 4c left Block 6 an instruction. Block 6a did not follow it, and neither the
spec, the plan, the plan's self-review nor six gates noticed, because every one
of them checked what had been written rather than what had been asked for.

**Defect two: "one person, one prize" only holds inside one draw.** 6a's D2 is
enforced by the walk and by `unique (draw_id, member_id)` — both per draw. Two
rounds on the same promotion can award the same listener twice. The owner's
description of the flow — *"posso continuar sorteando sobre os outros"* — expects
the opposite.

**And the shape the draw should have had.** A draw is not a promotion id and a
count. It is **a shuffle over a list the operator filtered and can see**.

---

## 2. Decisions

**D1 — The hat is sent explicitly, from the screen.** Owner's ruling. The
operator filters a list of participants, sees exactly who is in it, and draws
over that. `run_draw` receives the `participation_id`s rather than deciding for
itself.

The cost, accepted and mitigated in D2: the browser now proposes who is in the
hat. It cannot be trusted, so every id is checked.

**D2 — An id that fails validation refuses the whole draw.** Not silently
dropped. Dropping would produce a draw over a set the operator never approved,
while they would go on to say they drew among the forty-two they saw.

**D3 — A listener who has already won in this promotion is out.** Owner's
ruling, and it **revises 6a's D2**: one person, one prize is now per
**promotion**, not per draw. The rule lives in eligibility, which means the list
shrinks between rounds *and* a stale id is refused — one definition, both
effects. Building only the first would need two definitions of who is eligible,
which is the duplication this schema refuses everywhere else.

**D4 — Two filters on the participants list, and they add.** Owner's ruling.
*Correct / wrong / all*, and *answered option X to question Y*. They combine with
each other and with the four filters that screen already has (status, promotion,
listener, date range) as **AND**, because every other filter there already does
and a filter that sometimes widens the list is not a filter.

**D5 — "Correct" means every QUIZ question.** A participation answered correctly
when, for **all** questions of kind `QUIZ` in that promotion, it chose an option
with `is_correct`. **A question left unanswered is not correct** — not answering
is not getting it right. `MULTIPLE_CHOICE` and `ESSAY` do not count: `0041`
refuses `is_correct` on anything but a QUIZ, so they have no right answer to
miss.

**D6 — The permission is derived from the hat, never declared.** Owner's ruling,
resolving a collision between two of his own earlier answers. With the hat
supplied as ids (D1) there is no filter on the wire to gate on, and a label the
browser sends is not a gate — a caller could claim "all" and send only wrong
answerers. So `run_draw` asks the hat itself: does it contain anybody who
answered incorrectly? If yes, `draws.include_wrong_answers` is required.

The consequence, stated because it reverses an earlier answer of the owner's:
on a promotion with a quiz, drawing **without filtering** now needs that
permission too, because that hat contains wrong answerers.

**D7 — A round draws one prize.** Owner's ruling. The operator filters, picks the
prize, types how many, and draws. Another round can pick another prize and
another filter.

At the RPC this is `p_units` carrying exactly one entry, so the parameter does
not change. **The dialog does change:** 6a's run-draw dialog lists every linked
prize with a quantity each, which is a different gesture — one press spending
several prizes at once. It becomes a prize picker and one quantity. The
`validateDrawRequest` rules it already carries (never more than are available,
no fractional quantity, a runner-up count that is a whole number in range) all
still apply, to the one prize instead of to each.

**D8 — The operator's interface is in English.** Restating the owner's decision
of 2026-07-26. Blocks 6a and 6b shipped the only Portuguese screens in the
application and this block corrects them. The Portuguese in this product is what
a **listener** reads on WhatsApp, never what an operator reads on screen.

---

## 3. The data

### 3.1 `draws`, two new columns

| Column | Why |
|---|---|
| `offered_count integer not null` | how many participations the operator's list held. When the caller supplied no list, this equals `entry_count` — the operator offered everybody, so nothing was narrowed. It is NOT NULL for that reason: there is always an answer, and a null would mean "we did not record it" rather than "there was no filter". |
| `included_wrong_answers boolean not null default false` | whether this hat contained anybody who answered a QUIZ question incorrectly. Recorded so that six months later a reader knows which kind of draw this was without recomputing it. |

### 3.2 `promotion_participation_correctness`

```sql
public.promotion_participation_correctness(p_promotion_id uuid)
  returns table (participation_id uuid, answered_correctly boolean)
```

`SECURITY INVOKER`, `stable`, EXECUTE to nobody. **The one home of D5.** Read by
the participants list to filter, and by `run_draw` to decide whether the
permission is needed. Two readers, one definition — the same discipline
`participation_status_for` (0069) holds for the entry rules.

A promotion with no QUIZ question returns `answered_correctly = true` for every
participation: there was nothing to get wrong, and the alternative would make
every such draw require the permission.

### 3.3 `draw_eligible_participations`, one term added

The existing terms stay: `VALID`, listener not soft-deleted, not anonymised, not
blocked. Added: **the listener has not already won in this promotion**, which is
`not exists (select 1 from winners w join draws d ... where d.promotion_id = … and w.member_id = m.id)`.

Winners of a **cancelled** draw do not count — the draw was undone, so nothing
was won. Winners whose prize was returned or written off **do** count: they won,
and what happened afterwards is a different fact.

### 3.4 The permission

`draws.include_wrong_answers`, in `permissions` like every other. The owner
composes a role — "Chefe dos sorteios" — and grants it.

---

## 4. Running a round

`run_draw` is **dropped and recreated** with one new parameter — `create or
replace` cannot change an argument list, and leaving the old overload alive
would make every existing call ambiguous and raise `42725` at call time, which
is the trap 0047 documented and 02_permissions.test.sql counts `pg_proc` rows to
catch.

```sql
public.run_draw(
  p_promotion_id      uuid,
  p_units             jsonb   default null,
  p_runner_up_count   integer default 3,
  p_participation_ids uuid[]  default null
) returns uuid
```

`p_participation_ids` null or empty keeps 6a's behaviour — every eligible
participation — which is what the draws screen does today and what 6a's tests
assert.

When supplied, before anything is drawn:

1. resolve the eligible set for the promotion (§3.3);
2. **every supplied id must be in it.** Any that is not refuses with `22023`,
   saying how many were rejected and why the likely cause is a list that has
   moved (D2);
3. ask `promotion_participation_correctness` whether any supplied participation
   answered incorrectly. If so and the caller lacks
   `draws.include_wrong_answers`, refuse with `42501` (D6);
4. the hat is exactly the supplied set. Everything after that is 6a's: the seed,
   the ranking, the walk, the frozen `draw_entries`.

`offered_count` records the size of the supplied list; `included_wrong_answers`
records the answer from step 3.

---

## 5. The screen

**`/participations` moves from the Promotions section of the sidebar to
Audience**, beside Members. It is the listing of people taking part, and that is
where the owner looks for it.

It gains:

- the **correct / wrong / all** filter, hidden entirely when the promotion has no
  QUIZ question, because there is nothing to be right about;
- the **question + option** filter, which works for `MULTIPLE_CHOICE` too;
- a column saying **who has already won in this promotion**, so the people who
  vanish from the list between rounds are accounted for rather than merely
  missing;
- a **Draw** button, which opens the existing run-draw dialog with the prize and
  the quantity, and sends the filtered ids.

Both new filters need a promotion selected — a question belongs to one promotion,
and "correct" has no meaning across several. The filter row says so rather than
rendering controls that cannot work.

---

## 6. What breaks, and what it does

| Situation | Behaviour |
|---|---|
| A supplied id belongs to another promotion, is not `VALID`, or its listener is blocked or erased | Refused, `22023`, with the count. |
| A supplied id belongs to somebody who already won in this promotion | Refused the same way — the list moved under the operator. |
| The hat contains a wrong answerer and the caller lacks the permission | Refused, `42501`. |
| The hat contains a wrong answerer and the caller holds it | Drawn, and `included_wrong_answers` records it. |
| `p_participation_ids` is null | Every eligible participation, exactly as 6a behaves today. |
| A promotion with no QUIZ question | Nothing is ever refused for correctness; the filter does not render. |
| Every eligible listener has already won | The draw is refused for want of anybody eligible, which is 6a's existing refusal. |

---

## 7. Verification

- **pgTAP:** correctness for a promotion with one QUIZ question, with two, with
  an unanswered question, and with none; the already-won exclusion, including
  that a cancelled draw's winner is eligible again; each refusal in §6 on its
  own; the permission required and not required.
- **Vitest:** the participants filter's own rules as a pure function.
- **Isolation:** the whole round across the HTTP boundary as a signed-in
  operator — filter, draw, and a second round proving the first round's winner
  is gone from the list; and the permission refusal for a hat with wrong
  answerers.
- **Mutation, required:** remove the already-won term and confirm only the
  second-round case goes red; remove the correctness derivation from `run_draw`
  and confirm the permission case goes red.
- **Playwright:** an operator filters to correct answerers, draws one prize, sees
  the winner, then runs a second round and does not see the first winner in the
  list.

---

## 8. Out of scope — this is Block 6d

Everything the clock does: the deadline expiring, promoting a runner-up and
re-arming its deadline, `SUPERSEDED`, the cron that finds overdue winners, and
the notification through `outbox_messages`.
