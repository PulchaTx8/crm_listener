# Block 6c — The filtered hat, and no runners-up — Design Spec

**Date:** 2026-08-02
**Status:** approved by the owner
**Corrects:** Block 6a (`docs/superpowers/specs/2026-08-02-block-6a-draw-design.md`)
**Amends:** the master spec (`docs/superpowers/specs/2026-07-25-crm-radios-multitenant-design.md`) — requirement **N8 is withdrawn**
**Depends on:** Block 4a (promotion questions), Block 4c (participations and their answers), Block 6a (the draw), Block 6b (delivery)

---

## 1. What this block is for

Three corrections to Block 6a. All three came out of the owner being asked to
approve a design and answering with how a draw is actually run.

**One: the draw ignores the quiz.** `draw_eligible_participations` (0076) builds
the hat from `status = 'VALID'`, a live listener and no block, and never reads an
answer. On a promotion with a question, the bicycle can go to somebody who got it
wrong.

This was written down a block earlier and nobody read it back.
`0052_participations.sql:172`, on `participation_answers`:

> *"What the person answered, not whether they were right. **Block 6 derives
> correctness at draw time** by joining `promotion_question_options.is_correct`."*

Block 4c left Block 6 an instruction. Block 6a did not follow it, and neither the
spec, the plan, the plan's self-review nor six gates noticed — every one of them
checked what had been written rather than what had been asked for.

**Two: "one person, one prize" holds only inside one draw.** 6a's D2 is enforced
by the walk and by `unique (draw_id, member_id)`, both per draw. Two rounds on
one promotion can award the same listener twice.

**Three: there are no runners-up.** Owner's ruling, 2026-08-02. The concept comes
out of the system entirely.

**And the shape the draw should have had.** It is not a promotion id and a count.
It is **a shuffle over a list the operator filtered and can see.**

---

## 2. Decisions

**D1 — There are no runners-up. Requirement N8 is withdrawn.** Owner's ruling.
The operator filters a list, picks the prizes, and each prize goes to one person
in that list. If a winner does not collect, the prize follows the **pickup
deadline** rules — returned to stock or written off, which Block 6b already
built. Nothing is promoted, because there is no queue to promote from.

This is an amendment to the master spec, not only to 6a. N8 named an explicit
"promote runner-up" flow and the Block 6 acceptance criteria required it. The
master spec is edited to say the requirement was withdrawn on 2026-08-02 and
why — striking it silently would leave the next reader hunting for an N8 that
had simply vanished.

What goes with it: `draw_runners_up`, `draws.runner_up_count`,
`run_draw`'s `p_runner_up_count`, the queue in `get_draw` and on the screen, the
`runnersUp` half of the TypeScript verifier, and **`winner_status.SUPERSEDED`** —
which existed for exactly one purpose, a winner whose prize went to a runner-up,
and now means nothing.

Because 6a is unmerged, its migrations are edited in place rather than undone by
a later one. A feature that never reached a production database does not deserve
archaeology, and `supabase db reset` is the proof. Block 6b is branched on top
and its reads (`0080`, `0088`) carry the queue too, so they are edited with it.

**D2 — The hat is sent explicitly, from the screen.** Owner's ruling. The
operator filters, sees exactly who is in the list, and draws over it. `run_draw`
receives the `participation_id`s rather than deciding for itself. The cost — the
browser now proposes the hat — is met by D3.

**D3 — An id that fails validation refuses the whole draw.** Not silently
dropped. Dropping would draw over a set the operator never approved while they
went on saying they drew among the forty-two they saw.

**D4 — A listener who has already won in this promotion is out.** Owner's
ruling, **revising 6a's D2**: one person, one prize is now per **promotion**. The
rule lives in eligibility, so the list shrinks between rounds *and* a stale id is
refused — one definition, both effects. Building only the first would need two
definitions of who is eligible, which is the duplication this schema refuses
everywhere.

**D5 — Two filters on the participants list, and they add.** Owner's ruling.
*Correct / wrong / all*, and *answered option X to question Y*. They combine with
each other and with that screen's existing four (status, promotion, listener,
date range) as **AND** — every other filter there already does, and a filter that
sometimes widens the list is not a filter.

**D6 — "Correct" means every QUIZ question.** A participation answered correctly
when, for **all** questions of kind `QUIZ` in that promotion, it chose an option
with `is_correct`. **A question left unanswered is not correct.**
`MULTIPLE_CHOICE` and `ESSAY` do not count: `0041` refuses `is_correct` on
anything but a QUIZ, so they have no right answer to miss.

**D7 — The permission is derived from the hat, never declared.** Owner's ruling,
resolving a collision between two of his own earlier answers. With the hat
supplied as ids (D2) there is no filter on the wire to gate on, and a label the
browser sends is not a gate — a caller could claim "all" and send only wrong
answerers. So `run_draw` asks the hat: does it contain anybody who answered
incorrectly? If so, `draws.include_wrong_answers` is required.

The consequence, stated because it reverses an earlier answer of the owner's: on
a promotion with a quiz, drawing **without filtering** needs that permission too,
because that hat contains wrong answerers.

**D8 — A round draws one or more prizes, and the operator picks them.** Owner's
ruling. He selects the prizes to draw and how many units of each; **each unit
goes to one person** from the filtered list. With D4 in force, three units means
three different people. This is `p_units` unchanged — what changes is that the
operator chooses which links are in it rather than the system defaulting to all
of them.

**D9 — The operator's interface is in English.** Restating the owner's decision
of 2026-07-26. Blocks 6a and 6b shipped the only Portuguese screens in the
application; this block corrects them. The Portuguese in this product is what a
**listener** reads on WhatsApp, never what an operator reads on screen.

---

## 3. The data

### 3.1 Removed

| What | Where |
|---|---|
| `draw_runners_up` | `0075` |
| `draws.runner_up_count` | `0075` |
| `winner_status.SUPERSEDED` | `0075` |
| `p_runner_up_count` | `0078` |
| the queue in `get_draw` | `0080`, `0088` |

### 3.2 `draws`, two new columns

| Column | Why |
|---|---|
| `offered_count integer not null` | how many participations the operator's list held. When no list was supplied this equals `entry_count` — the operator offered everybody, so nothing was narrowed. NOT NULL because there is always an answer, and a null would say "not recorded" rather than "not filtered". |
| `included_wrong_answers boolean not null default false` | whether the hat held anybody who answered a QUIZ question incorrectly. Recorded so a reader six months later knows which kind of draw this was without recomputing it. |

### 3.3 `promotion_participation_correctness`

```sql
public.promotion_participation_correctness(p_promotion_id uuid)
  returns table (participation_id uuid, answered_correctly boolean)
```

`SECURITY INVOKER`, `stable`, EXECUTE to nobody. **The one home of D6.** Read by
the participants list to filter and by `run_draw` to decide whether the
permission is needed — two readers, one definition, the discipline
`participation_status_for` (0069) already holds for the entry rules.

A promotion with no QUIZ question returns `true` for every participation: there
was nothing to get wrong, and the alternative would make every such draw demand
the permission.

### 3.4 `draw_eligible_participations`, one term added

The existing terms stay: `VALID`, listener not soft-deleted, not anonymised, not
blocked. Added: **the listener has not already won in this promotion.**

Winners of a **cancelled** draw do not count — the draw was undone, so nothing
was won. Winners whose prize was returned or written off **do** count: they won,
and what happened next is a different fact.

### 3.5 The permission

`draws.include_wrong_answers`, in `permissions` like every other. The owner
composes a role and grants it.

---

## 4. Running a round

`run_draw` is **dropped and recreated**: it loses a parameter and gains one, and
`create or replace` cannot change an argument list. Leaving the old overload
alive would make existing calls ambiguous and raise `42725` at call time — the
trap `0047` documented and `02_permissions.test.sql` counts `pg_proc` rows to
catch.

```sql
public.run_draw(
  p_promotion_id      uuid,
  p_units             jsonb  default null,
  p_participation_ids uuid[] default null
) returns uuid
```

`p_participation_ids` null or empty keeps 6a's behaviour — every eligible
participation.

When supplied, before anything is drawn:

1. resolve the eligible set for the promotion (§3.4);
2. **every supplied id must be in it.** Any that is not refuses with `22023`,
   saying how many were rejected and that the likely cause is a list that has
   moved (D3);
3. ask `promotion_participation_correctness` whether any supplied participation
   answered incorrectly; if so and the caller lacks
   `draws.include_wrong_answers`, refuse with `42501` (D7);
4. the hat is exactly the supplied set. Everything after is 6a's — the seed, the
   ranking, the walk, the frozen `draw_entries` — minus the runner-up
   continuation, which no longer exists.

---

## 5. The screen

**`/participations` moves from the sidebar's Promotions section to Audience**,
beside Members. It is the listing of people taking part, and that is where the
owner looks for it.

It gains:

- the **correct / wrong / all** filter, hidden when the promotion has no QUIZ
  question, because there is nothing to be right about;
- the **question + option** filter, which works for `MULTIPLE_CHOICE` too;
- a column saying **who has already won in this promotion**, so the people who
  vanish between rounds are accounted for rather than merely missing;
- a **Draw** button opening a dialog that picks the prizes and their quantities
  and sends the filtered ids.

Both new filters need a promotion selected — a question belongs to one promotion
and "correct" has no meaning across several. The filter row says so rather than
rendering controls that cannot work.

The draw detail screen loses its runner-up section. `validateDrawRequest` loses
its runner-up rules; everything else it checks still applies.

---

## 6. What breaks, and what it does

| Situation | Behaviour |
|---|---|
| A supplied id belongs to another promotion, is not `VALID`, or its listener is blocked or erased | Refused, `22023`, with the count. |
| A supplied id belongs to somebody who already won in this promotion | Refused the same way — the list moved under the operator. |
| The hat holds a wrong answerer and the caller lacks the permission | Refused, `42501`. |
| The hat holds a wrong answerer and the caller holds it | Drawn, and `included_wrong_answers` records it. |
| `p_participation_ids` is null | Every eligible participation, as 6a behaves today. |
| A promotion with no QUIZ question | Nothing is refused for correctness; the filter does not render. |
| Every eligible listener has already won | Refused for want of anybody eligible — 6a's existing refusal, now reachable a second way. |

---

## 7. Verification

- **pgTAP:** correctness for a promotion with one QUIZ question, with two, with
  an unanswered question, and with none; the already-won exclusion, including
  that a cancelled draw's winner is eligible again; each refusal in §6 on its
  own; the permission required and not required; and that `draw_runners_up`,
  `runner_up_count` and `SUPERSEDED` are **gone** — a removal nothing asserts is
  a removal somebody re-adds.
- **Vitest:** the participants filter's rules as a pure function; the verifier
  without its runner-up half.
- **Isolation:** a whole round across the HTTP boundary as a signed-in operator
  — filter, draw, then a second round proving the first winner is gone from the
  list; and the permission refusal for a hat holding wrong answerers.
- **Mutation, required:** remove the already-won term and confirm only the
  second-round case goes red; remove the correctness derivation from `run_draw`
  and confirm only the permission case goes red.
- **Playwright:** an operator filters to correct answerers, draws a prize, sees
  the winner, runs a second round and does not see the first winner in the list.

---

## 8. Out of scope — this is Block 6d

What the clock does: the deadline expiring, the cron that finds overdue winners,
and the notification through `outbox_messages`. The master spec's own words for
it survive N8's withdrawal unchanged — *"processes expired deadlines →
`RETURN_PENDING` + notifies"* — because that never depended on a runner-up.

What an overdue winner then becomes is already built: returned to stock or
written off, by an operator, in Block 6b.
