# Block 6c — Drawing over a list you filtered

**Audience:** whoever operates a Station and runs the draws, and whoever has to
answer a listener who was in the running last week and is not this week.

Block 6a made a draw a shuffle over **every** eligible entry in a promotion.
This is what changed: the draw now runs over the list an operator filtered and
looked at, nobody wins twice in the same promotion, and there are no runners-up.

---

## 1. Where it lives

**Audience → Participations**, or `/participations`. It moved out of the
Promotions section of the sidebar: it is the listing of the people taking part,
and it is where a draw is now run from.

The promotion's own draws screen — **Promotions → the promotion → Prizes tab →
"Draws of this promotion"** — is still there and still works. Drawing from there
draws over **everybody eligible**; drawing from Participations draws over
**what you filtered**. Both write the same kind of draw and both are checkable
the same way (`docs/block-6a-runbook.md` §4).

---

## 2. Running a filtered draw

1. Pick a **promotion**. Nothing about answers can be filtered until you do —
   a question belongs to one promotion, and so does a right answer. The filter
   row says so rather than showing controls that cannot work.
2. Narrow the list however you like: status, source, the dates somebody entered
   between, the listener's name, **Quiz answer**, **Chose**.
3. Press **Draw**.

The panel then **reads the list as it stands** and tells you what is in the hat:

> **12** entries in the hat, out of 15 matching these filters.
> Left out: 2 who already won in this promotion, 1 whose entry did not count.

That number is read **when the panel opens**, not when you press the button, and
that is deliberate. It means the set you approve is the set that goes in: an
entry recorded while you were reading cannot join a draw you never saw it in.
It also means the list can move under you — if it does, the draw is **refused**
with a sentence, and you open the panel again. See §6.

Then choose how many units of each prize, and press **Draw**. The winners are
named in the panel, with a link to the draw's own record.

**The list behind the panel does not re-read itself** after a draw. That is on
purpose — re-reading would throw away your place in a long list — so the "Won
here" column still shows what it did a moment ago. Refresh the page to see it
catch up.

---

## 3. What "answered correctly" means

The **Quiz answer** filter appears only when the promotion asks at least one
**Quiz** question. A poll has options and no right answer, so there is nothing
to be right about and the control does not render.

Somebody counts as having answered correctly when they got **every** Quiz
question of that promotion right.

**Not answering is not getting it right.** Somebody who answered one of two
questions correctly and left the other blank counts as **wrong**. That is the
rule, and it is the one most easily assumed the other way.

A promotion with **no** Quiz question: everybody counts as correct, because
there is nothing to miss. Nothing is refused for correctness there and no
permission is needed.

The **Chose** filter is separate and works on polls too — it lists the options
of the selected promotion, grouped by question, and matches whoever picked that
option.

**The two filters AND.** "Answered correctly" *and* "chose *The blue one*" means
both, not either. If that combination is empty, the list is empty, and that is
the true answer rather than a fault.

---

## 4. Why somebody disappears between rounds

**One person wins at most one prize per promotion.** Once somebody has won, they
are out of the hat for every later round of the same promotion — not just the
draw they won.

So the same filter can return five names today and four next week. The **Won
here** column is what makes that visible: it says *Yes* for a listener who has
already won in this promotion, so the person who vanishes from the hat is
accounted for rather than merely missing.

Two things it does **not** mean:

- **A cancelled draw un-wins its winners.** Cancel a draw and its winners are
  back in the hat, because the draw was undone and nothing was won.
- **What happened to the prize afterwards changes nothing.** A winner whose
  prize was returned to stock or written off has still won. They stay out.

Block 6a shipped this rule as one prize per **draw**, which let a second round
award the same listener again. That was corrected here.

### There are no runners-up

Withdrawn from the product on the owner's ruling (2026-08-02), together with
requirement N8 of the master spec. A draw awards prizes and nothing waits behind
them. A prize nobody collects is returned to stock or written off by an operator
— `docs/block-6b-runbook.md` — and nothing is promoted, because there is no
queue to promote from.

---

## 5. Drawing among people who answered wrongly

Sometimes you want to. Nobody got it right; the promotion was a formality; the
Station decided the quiz was too hard. It is allowed, and it needs its own
permission.

**`draws.include_wrong_answers`** — *"Draw among wrong answers"* in the role
editor. It is asked for **only when the hat actually contains somebody who
answered wrongly**, which is decided by looking at the hat rather than by any
box the operator ticks. So:

| The hat | What is needed |
|---|---|
| only people who answered correctly | `draws.execute` |
| anybody who answered wrongly, or left a Quiz question blank | `draws.execute` **and** `draws.include_wrong_answers` |
| a promotion with no Quiz question at all | `draws.execute` |

What it does **not** cover: it is not a general override. It does not let
anybody draw a blocked listener, an erased one, an entry that did not count, or
somebody who has already won here. Those are refused whoever asks.

Every draw records what it did. `draws.included_wrong_answers` is `true` for a
draw whose hat held a wrong answer, and it is written by the same look at the
hat that decided the permission — not by a claim from the screen.

---

## 6. Refusals you may meet

| Message | What happened | What to do |
|---|---|---|
| *N of the M listed participations can no longer be drawn; the list has moved, open it again* | Between the panel reading the list and you pressing the button, somebody in it stopped being eligible: blocked, erased, or awarded in another draw. The whole draw is refused rather than run over a set you did not approve. | Close the panel and open it again. The summary will show the new number. |
| *this list includes listeners who answered the quiz wrongly; that needs draws.include_wrong_answers* | The hat holds somebody who did not get every Quiz question right. | Filter to **Answered correctly**, or ask for the permission (§5). |
| *nobody is eligible for this draw* | Nothing in this promotion can be drawn — everybody has won, or is blocked, or no entry counted. | Nothing is wrong; there is nobody left. |
| *Nobody in this list can be drawn. Widen the filters and open this again.* | The filters matched rows, but every one of them had already won or did not count. Said by the screen before anything is sent. | Widen the filters. |
| *These filters match more than 5000 entries…* | One hat cannot name more than five thousand participations. | Narrow the list, or draw among everybody from the promotion's own draws screen, which has no such limit. |
| *this promotion does not have that many units still to draw: link …* | Somebody drew, linked or unlinked units since the panel opened. | Open the panel again and read the fresh balances. |
| *this promotion is cancelled and cannot be drawn* | Exactly that. | — |
| *permission denied: draws.execute required* | The role cannot run draws at this Station. | — |
| *permission denied: participations.view and promotions.view required* | The list itself needs **both**. Reading entries without being able to see the promotions behind them was never allowed; it now says so instead of showing an empty screen. | — |

---

## 7. Checking a filtered draw afterwards

Everything in `docs/block-6a-runbook.md` §4 still applies: the seed, the
algorithm version, the frozen hat in `draw_entries`, and the recipe for
recomputing the winners by hand. A filtered draw is checked exactly like any
other, because the filtering happened **before** the hat was frozen — what
`draw_entries` holds is the hat, whatever chose it.

Each draw carries three columns worth reading:

```sql
select entry_count, offered_count, included_wrong_answers
from public.draws
where id = '<draw id>';
```

- `entry_count` — how many entries were in the hat.
- `offered_count` — how many participations the operator's screen sent.
- `included_wrong_answers` — whether the hat reached past the right answers,
  which is also the thing that made `draws.include_wrong_answers` necessary.

**`offered_count` will always equal `entry_count`, and cannot tell you a draw
was filtered.** Every id an operator sends has to be eligible or the whole draw
is refused (§6), so the number sent and the number that went in the hat are the
same number by construction. Read it as a second witness to `entry_count`, not
as a signal.

So the honest answer to "was this draw filtered?" is: **the database does not
say.** A draw over twelve of fifteen entries and a draw over a promotion that
only ever had twelve are identical rows. What is recorded, exactly and for ever,
is *who was in the hat* — `draw_entries` — and that is what a listener asking
"was I in it?" actually needs. Nothing records *why* those twelve and not the
other three; if that matters for a particular promotion, write it down yourself.
