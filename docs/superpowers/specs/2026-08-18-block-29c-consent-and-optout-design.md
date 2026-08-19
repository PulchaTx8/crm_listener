# Block 29c — consent and opt-out

**Date:** 2026-08-18
**Depends on:** nothing. Runs independently of 29b-1 (merged) and 29b-2 (not started).
**Blocks:** 29d, which cannot resolve an audience without the predicate §8 defines.
**Parent brief:** `docs/superpowers/specs/2026-08-17-block-29-messaging-brief.md`, §4.

---

## 1. What this delivers

Per-channel marketing consent for listeners, the ways it is collected, the ways
it is withdrawn, and the set-at-a-time predicate that answers "who may this
Station send to on this channel".

## 2. What this deliberately does not deliver

- **Campaigns.** No audience screen, no send, no queue. 29d.
- **Meta's native opt-out button** on marketing templates. It lives in template
  creation, which is 29b-2's.
- **Tags and groups.** Deferred with no ordering constraint (brief §5, D4).
- **A `communication_preferences` table.** The original request proposed one.
  `member_consents` (0032) already is one, better shaped: append-only, per
  Station, with `origin` and `recorded_by`. Nothing new is created for state
  that an existing log already holds.

---

## 3. Decisions, all settled with the owner on 2026-08-18

**D1 — The default absent any consent row is asymmetric by channel.**
`whatsapp_marketing` absent means NOT eligible; `email_marketing` absent means
eligible. Meta requires opt-in for marketing templates and enforces it through
number quality, so an opt-out posture there risks the WhatsApp Business account
itself. E-mail goes out on the existing relationship — the listener registered
in this Station's promotion — with one-click withdrawal, which is the standard
LGPD posture for legitimate interest. Consequence, accepted knowingly: e-mail
campaigns work on day one, WhatsApp campaigns start at an audience of zero and
grow only as listeners are asked.

**D2 — The question is asked in both doors, once per listener per Station.**
The WhatsApp conversation and the widget both gain it. Asked once: any existing
row for that `(member, company, whatsapp_marketing)` — granted true OR false —
suppresses the question forever after. Not bundled into the promotion's rules
acceptance, because LGPD treats bundled consent as weak and Meta does not read
it as explicit opt-in.

**D3 — A withdrawal is scoped to the Station that sent, with an explicit
group-wide second action.** `member_consents.company_id` is `not null`, so a
consent is a fact about one Station by construction. The unsubscribe page writes
one row for the sending Station — `email_marketing`, because the click was in an
e-mail — and offers "leave every Station in this group" as a separate,
deliberate action writing **two** rows per Station the listener is linked to,
one per marketing channel. Corrected here by the whole-branch review: the code
was always right and this sentence said "one row per Station". Somebody asking
to leave a whole group is not asking for half an exit, which is exactly why the
group action differs from the single-Station one on channels as well as on
scope.

**D4 — Stop words land in the engine now, not in 29b-2.** PARAR, CANCELAR and
DESCADASTRAR on WhatsApp inbound. Without them 29d would send marketing through
a channel with no exit, which is the scenario that produces complaints to Meta.

**D5 — `sponsor_communication` is left untouched.** It names a different thing
(a sponsor's communication, not the Station's campaigns), nothing has ever
collected it, and removing an enum value in PostgreSQL is not cheap. It is not
renamed, not deprecated, not mapped.

---

## 4. Data model

Two values on `member_consent_type`: `whatsapp_marketing`, `email_marketing`.
`ALTER TYPE … ADD VALUE` goes in a migration **of its own**, carrying nothing
else — it cannot share a transaction with statements that use the new value.

No new table. No new column on `members`.

## 5. Eligibility, in four layers

Evaluated in this order; the first "no" ends it.

1. `members.anonymized_at` — an absolute bar. An erased listener is never a
   recipient. This is erasure, not consent, and it is not overridable.
2. `member_blocks` with an active suspension. `members_blocked_bulk` (0036)
   already answers exactly this question set-at-a-time.
3. The **latest** `member_consents` row for `(member_id, company_id,
   consent_type)`. A withdrawal is a new row with `granted = false`; the most
   recent row wins.
4. The channel default from D1, when no row exists at all.

**The latest-row resolution needs an explicit tiebreak: `granted_at desc, id
desc`.** `granted_at` defaults to `now()`, which is constant within a
transaction, so two rows written in one transaction tie and the "latest" would
otherwise be the planner's choice. Block 29b-1's whole-branch review found the
same defect one layer up, in a grid ordered by a column that was null for every
row.

## 6. Collection

**Not a `promotion_requested_field`.** Requested fields are what a *promotion*
asks and an operator picks from. Marketing consent is not the promotion's
business: as a field, whether the product asks at all would depend on each
operator remembering to tick a box. It is a **step of the engine**.

**In the conversation** — a choice-shaped step, Sim/Não buttons, the same shape
the gender field landed in Block 29's gender pass:

- Runs once per listener per Station (D2).
- Runs **after the participation is recorded**, never before. A listener who
  abandons at the consent question must still be entered in the promotion;
  charging consent as a toll would cost entries and would be coercion.
- Its text and the stop-word confirmation are `system_message_key` values, like
  everything else the conversation says.

**In the widget** — a checkbox on the participation form, **unchecked by
default**. A pre-checked box is not affirmative consent under LGPD.

**Both doors collect `whatsapp_marketing` only, and neither collects
`email_marketing`.** This follows from D1 and is stated because the opposite
reading is available: e-mail is eligible by default, so there is nothing for an
opt-in to add, and a second checkbox asking permission the product does not
require would be a question whose only possible effect is a "no". E-mail consent
rows are therefore written by exactly two things — the unsubscribe route (§7),
always `granted = false`, and an operator recording something by hand (§9).
The widget's checkbox is asked of a listener who may have given no telephone
number at all; that is fine and is not a special case, because a consent is a
fact about a channel and not about whether the listener is currently reachable
on it.

Both write through `record_member_consent` (0034), which already refuses a
Station the caller cannot reach, with `origin` naming the door
(`conversation` / `widget`).

## 7. Withdrawal

### The unsubscribe token

Mirrors `widget_link_tokens` (0178, retention sweep in 0183): random, stored
**hashed**, never an internal id in the URL, with its own expiry and its own
sweep. It carries listener, Station, and campaign — the last so the consent
row's `origin` can name what the listener was reading when they left.

**Expiry: one year**, aligned with the retention sweep. The asymmetry is
deliberate: the token grants exactly one capability, stopping mail. Leaked, it
lets somebody unsubscribe another person — low harm, reversible. A short expiry
instead means a listener who opens the mail a fortnight later cannot leave,
which is the path to a formal complaint rather than a quiet unsubscribe.

### The route

Lands in `(public)`. **The GET must not write.** Corporate mail filters and
antivirus prefetch links; a route that acts on GET unsubscribes everyone whose
employer scans mail, silently and with nobody having clicked. The GET renders a
page with a button; the **POST** writes.

Rate limited through `src/lib/rate-limit`. Block 11c's trap applies: the limiter
must see the real client IP behind the proxy, or it limits the proxy as one
person.

**That limiter bounds the PAGE, and nothing else** — corrected here by the
whole-branch review, which found this section reading as though it bounded
spending a token. `consume_unsubscribe_token` is granted to `anon` and is
therefore reachable directly through PostgREST, with no page and no limiter in
front of it. That is accepted rather than closed: the token is 32 random bytes,
so guessing one is 256 bits of work, and a rate limiter is not what stands
between an attacker and a token — the token's own size is. What a limiter on
the page buys is protection against somebody hammering the page itself, which
is a different problem and the only one it solves.

Two actions on the page: leave this Station, and — separate and explicit —
leave every Station of this group the listener is linked to (D3).

### `List-Unsubscribe`

The campaign mail carries `List-Unsubscribe` and `List-Unsubscribe-Post`
headers. Two lines in the mailer; without them Gmail and Outlook treat the
sender as one with no exit. This is deliverability, not decoration.

### Stop words

PARAR, CANCELAR, DESCADASTRAR on WhatsApp inbound, compared without accents and
without case. They write `granted = false` for `whatsapp_marketing` on that
Station and answer with a short confirmation.

**They apply outside a promotion flow only.** A listener mid-flow answering
"which city" who types PARAR is stopping the conversation, not withdrawing
marketing consent; treating both as one would convert an abandonment into a
withdrawal nobody asked for. "SAIR" is deliberately **not** a stop word: the
widget has carried a "Sair" since Block 19b meaning end-the-session, and two
things sharing a name while doing different things is a defect waiting for a
maintainer.

## 8. What 29d consumes

A set-at-a-time function shaped like `members_blocked_bulk` (0036): given a
Station and a channel, it returns the eligible listeners, applying §5's four
layers in one pass. `stable`, and — **corrected by the whole-branch review
(F29)** — **`security definer` with the same three-arm caller guard 0036 has**,
plus a `member_company_links` check so a listener with no relationship to the
Station is never named a recipient.

This paragraph originally said `security invoker`, reasoning that "who may I
reach" must respect the RLS of whoever asks and that there was no privilege to
lend, only a filtered read. That was wrong, and specifically: two of §5's layers
are phrased as the ABSENCE of a row (no active suspension; no consent row, so
the channel default). RLS does not answer "there is no such row" — it answers
"you cannot see one", in the same shape. The filter therefore only ever ADDED
recipients: a caller who could not read a Station's `member_consents` and
`member_blocks` was told every listener there was eligible, an unsubscribed one
and a suspended one included. A filtered read is safe only when the filter can
do nothing but remove; here it could not.

The consequence for 29d is now a refusal rather than an empty result: a send
loop with no `auth.uid()` gets `42501` on the first call instead of an audience
of zero it cannot tell from "nobody consented".

## 9. Operator surface

The Member sheet's existing consent form is driven by the enum, so the two new
types appear once their labels exist in all three catalogues.

An operator **may** record marketing consent by hand. `member_consents` carries
`recorded_by`, and that column is exactly what makes a consent given by
telephone or at a counter defensible. What is not possible is a row that does
not say who created it, and the table already forbids that.

## 10. Tests

| Proof | Where | What it catches that the others cannot |
|---|---|---|
| The channel-default asymmetry (no row: WhatsApp out, e-mail in) | pgTAP | The decision of D1, in the layer that enforces it |
| Latest row beats earlier; tiebreak with two rows at one instant | pgTAP | The planner-order defect §5 names |
| The three bars: anonymised, suspended, withdrawn | pgTAP | Each independently, so a passing suite cannot hide one |
| The set function's grants | pgTAP | It is a new callable surface |
| Token of another Station, expired token, spent token | isolation | Real sessions, two tenants — a tenancy hole no unit test reaches |
| "Leave every Station" hits exactly the listener's links | isolation | Over-reach across an Organization |
| Widget checkbox defaults unchecked | e2e | A pre-checked box is the LGPD failure |
| A second, unticked participation writes no second row and does not revoke the first | e2e | The silent revocation F23 closed. It does **not** prove D2's "once": the widget's box is still re-rendered on every entry, so what is suppressed is the write, not the question |
| Unsubscribe effects on POST, and **the GET changes nothing** | e2e | Pins §7's decision against a later "simplification" |

## 11. Traps carried in from earlier blocks

- `system_message_key` gains two values. Adding a value to an enum does not break
  compilation in four places (see the project's own note on this) and moves
  hand-written counts no compiler holds.
- `create or replace` preserves a function's ACL; `drop` + `create` destroys it.
  Any function recreated here is recreated from its **live** definition, never
  from the migration that first created it.
- pgTAP `plan(N)` is the file's running total, not this block's addition.
- A migration adding an enum value ships alone.
