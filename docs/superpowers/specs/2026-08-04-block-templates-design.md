# Block Templates — the copy, the approved-template door, and the pickup reminder — Design Spec

**Date:** 2026-08-04
**Status:** approved by the owner
**Amends:** the 2026-08-03 Templates decision — the block ships **two** screens, not three, and the WhatsApp music-request templates leave with the flow that would have justified them
**Depends on:** Block 5a (the WhatsApp spine), Block 5b (the conversation engine), Block 6d (the deadline clock this finally lets speak)

---

## 1. What this block is for

Two things the system cannot do today.

**It cannot say anything in a Station's own words.** Every sentence the bot speaks is a constant in `src/lib/conversation/engine.ts` — the same Portuguese for every Station of every Organization. A group with five radios has five different voices and one script.

**It cannot start a conversation.** Every message the system has ever sent is a reply, inside WhatsApp's 24-hour customer-service window. Meta accepts a Station-initiated message only as an **approved template**, and that path does not exist. Block 5a foresaw it in writing, in `src/lib/integrations/whatsapp/graph.ts`:

> Block 6's first Station-initiated message — a draw result — will need a template, and this method is not it.

Block 6d then shipped a deadline clock that moves prize stock in silence, and recorded the consequence in its own report §5.1: *"Nothing notifies anybody."* A winner's prize returns to stock without the winner ever being told the clock was running. **That is what this block ends.**

---

## 2. Decisions

### D1 — Two screens, not three. The Interaction Templates screen does not ship.

The 2026-08-03 decision named three: System, Interaction and Meta. Interaction had two halves — the promotion copy, which already exists, and the music-request flow, which does not.

The music half was already deferred: that flow is its own block, and the owner ruled on 2026-08-04 that Templates would not wait for it.

What is left of Interaction is a screen over `promotion_questions.prompt`, the menu title, the button labels, the call to action and the art — **every one of which is already editable on the promotion itself**, through the record dialog Block 3c established and Block 4a filled. A second screen would be a second write path onto one set of fields, with no new capability, and two doors onto one field is how the two start disagreeing.

So the screen ships when the music flow gives it something only it can configure. Recorded here rather than silently dropped.

**Rejected:** building it now as a consolidated per-promotion copy view, for an operator maintaining several promotions at once. Real, but it buys convenience at the price of a second write path onto fields whose single editor is currently unambiguous — and the moment the music flow lands, the screen has to be rebuilt around content this version would not have.

### D2 — System Templates override per text, and an absent row means the code's own default

`station_message_templates` carries **one row per overridden text**, not one row per Station.

Ten texts, all from `engine.ts`: `REFUSAL_MESSAGE`, `ABANDON_MESSAGE`, and the eight `FIELD_PROMPTS`.

Three consequences, each of them the reason:

- **Override is per text.** Changing one field prompt does not require retyping the other seven, and does not silently freeze them at whatever the code said the day the row was written.
- **A new Station works before anybody configures it.** No backfill migration, no seed step in provisioning, no Station that exists but cannot speak.
- **The bot can never go mute.** A missing row is a valid state that resolves to the constant. The alternative — required rows — makes a `null` body a silence a listener experiences and nobody sees.

The constants stay in `engine.ts` as the defaults. `engine.ts`'s own comment says they are constants "because the owner called them copy, changeable without a migration"; that reasoning is not overturned, it is completed — they remain changeable without a migration, and now without a deploy.

### D3 — Only the text of what exists. The four missing behaviours are named, not built.

The legacy screen the owner showed also carried **"Inatividade", "Aguarde", "Rejeita Áudio", "Rejeita Ligação"**, an inactivity timeout and two auto-reply checkboxes. None of it exists in this system — **neither the text nor the behaviour**.

Rejecting audio and calls are ingestion rules nobody has written: the webhook does not recognise those message types today. Inactivity needs a clock over parked conversations that does not exist.

This block ships no field that pretends to configure something. Each of the four is recorded in the report with what it would cost, for the owner to price separately.

### D4 — The Meta registry records what was approved. It does not submit.

The operator creates and submits the template in Meta's own console. This system records what came back approved: the name, the language, the body with its `{{n}}` placeholders, and what each variable position means.

**Rejected: submitting through the Graph API.** It needs management permission over the WABA — strictly more than sending needs — and the approval still takes Meta days. What it saves is typing, not waiting, and it widens the credential this system holds for a convenience.

**The cost of the manual step, stated:** a hand-typed registry can disagree with what Meta actually approved, and the disagreement surfaces as a rejected send. The runbook covers the copy step, and the send error names the field. A verification call against the Graph was considered and left out for the same reason as submission — it is a second external dependency for a check the first send already performs.

### D5 — The registry is per Station

`company_id` and `organization_id`, like the catalogue (Block 7 D1) and unlike members. Block 10 gives each Station its own WABA; a template is approved against a WABA, so a template approved for one Station is not a fact about another.

### D6 — The outbox stores the rendered text as well as the template

`outbox_messages.body` is `not null` and is deliberately **not pruned** — 0059's own comment says it is what an operator asked *"what were they actually told?"* has left once the phone number is gone.

A template send has no free-form body, so the enqueue renders the approved text with its variables substituted and stores that in `body`, alongside the template name, language and variables in new columns.

**They must agree, and that is a test, not a hope.** A rendered body that drifts from the variables actually sent makes the audit trail confidently wrong — worse than absent, because somebody will believe it.

### D7 — The reminder sweep commits per winner

`sweep_pickup_reminders()` is a **procedure**, in the shape of `sweep_pickup_deadlines` (0094), committing per winner.

This is deliberately the opposite of Block 7b's merge, which is atomic — and for the opposite reason, which is the whole distinction: **an unattended sweep must not let one bad row stop every Station**, while one operator pressing one button must not get half a merge. Block 6d's own report records that a procedure doing this cannot be `SECURITY DEFINER`, because it commits; the same constraint applies here.

### D8 — Two days before the deadline, fixed in code

The reminder fires for a winner whose `deadline_at` is **in the future and no more than two days away** — `deadline_at > now() and deadline_at <= now() + interval '2 days'`.

Both halves are load-bearing. Without the lower bound the sweep would remind about deadlines that have already passed, which is the one moment the message is worse than silence: it tells somebody to collect a prize the clock has already returned to stock.

Fixed rather than configurable per Station: the owner ruled on 2026-08-04, and a second configurable clock beside `pickup_deadline_days` invites the two to be set into a combination that never sends — a three-day reminder on a two-day deadline is not an error the database can refuse, and the operator finds out by nobody being reminded.

For a promotion whose deadline is two days or less, the reminder fires alongside the result. **That is the correct behaviour, not a degenerate case:** a short deadline is exactly when a listener most needs telling, and the two messages say different things.

### D9 — Idempotency comes from the outbox, not a new column

`dedupe_key = 'pickup-reminder:' || winner_id`, against the existing `unique (provider, dedupe_key)`.

No `reminded_at` column on `winners`. A column would be a second record of the same fact, updated by the same sweep that enqueues — so a crash between the two leaves them disagreeing, and whichever is read first wins. The constraint already refuses the second enqueue, and refuses it in the same transaction that would have created it.

Unlike the confirmation keys 0059 describes, this value needs no hashing: a winner id is not a phone number, and `dedupe_key` is never pruned.

---

## 3. The data

### 3.1 `station_message_templates`

```
organization_id, company_id      per Station, composite FK as every table since 0025
key      public.system_message_key    the ten texts, an enum
body     text, not blank
created_by, created_at, updated_at, deleted_at
unique (company_id, key) where deleted_at is null
```

`key` is an enum rather than free text so that a typo cannot create a row that overrides nothing and reports success. The enum's ten values mirror `RequestedField` plus the two standalone messages; adding a ninth requested field will fail to compile against `FIELD_PROMPTS`'s total record and fail to insert here — both, on purpose.

### 3.2 `message_templates`

```
organization_id, company_id      per Station (D5)
name        text, not blank      the name registered with Meta
language    text, not blank      Meta's code, e.g. 'pt_BR'
body        text, not blank      the approved text, with {{1}}…{{n}}
variables   jsonb                ordered: what each position means
purpose     public.template_purpose   PICKUP_REMINDER, and nothing else yet
created_by, created_at, updated_at, deleted_at
unique (company_id, purpose) where deleted_at is null
```

`purpose` is what lets code reference a template without an environment variable: the reminder asks for this Station's `PICKUP_REMINDER` row. One approved template per purpose per Station, which is why the uniqueness sits there rather than on the name.

**Deliberately absent: a status column.** This system does not know whether Meta still approves a template — it records what the operator was told at registration. A `status` here would look like live truth and be a memory. The first rejected send is what discovers a revocation, and the runbook says so.

### 3.3 `outbox_messages`, extended

`template_name`, `template_language`, `template_variables jsonb` — nullable, and null together. A row is a text send, an interactive send, or a template send.

These hold the **resolved** name and language, not a purpose. The outbox row has to stay sendable on its own: a worker draining it days later must not have to re-resolve a registry row that may since have been edited, or the message sent would differ from the message enqueued and audited.

This mirrors `0067_outbox_interactive.sql` exactly, which added `interactive` and redefined `claim_outbox_batch` in the same file. This will be that function's **third** definition.

---

## 4. The send path

`enqueue_whatsapp_outbound` gains **one** template argument — `p_template_purpose`, not a name — and does the resolution itself:

1. reads this Station's live `message_templates` row for that purpose;
2. renders its `body` with the caller's variables and stores the result in `outbox_messages.body`;
3. stores the resolved `template_name`, `template_language` and `template_variables` beside it.

Resolving here rather than in the caller is what makes D6's agreement structural: one function reads the approved text and writes both the rendered body and the variables, so they cannot be produced from different sources. It is also what lets the refusal below happen at the only moment an operator is still watching.

- **DROP and recreate**, not `create or replace` — that cannot change an argument list, the trap `0047` hit for `apply_inventory_movement` and `0092` for `apply_winner_transition`.
- It refuses a purpose with no live registry row for that Station **at enqueue**, not at send. The operator finds out on the screen that queued it, not in a worker log days later.
- It refuses a variable count that disagrees with the approved body's highest `{{n}}`. Meta rejects that send anyway; refusing it here turns a delivery failure nobody watches into a validation error somebody reads.
- `buildTemplatePayload` / `parseTemplate` in `src/lib/integrations/whatsapp/template.ts`, mirroring `interactive.ts`'s pair.
- `sendTemplate` on the `WhatsAppTransport` interface, in `graph.ts` and in `fake.ts`. The fake matters: it is what every test that is not a live send runs against.
- A dispatch branch in the outbox drain, beside text and interactive.

---

## 5. The screens

```
Templates
  Messages    /templates/messages     the ten system texts, per Station
  WhatsApp    /templates/whatsapp     the approved-template registry
```

A new sidebar section, visible to every member — the courtesy every section extends, with the boundary in the database.

**Messages** shows all ten texts whether overridden or not, each marked as the Station's own wording or the system default, with the default visible while overriding. An operator has to be able to see what they are replacing. Clearing a field removes the row and returns to the default; that is a real action with a real button, not an empty save.

**WhatsApp** lists the registry and edits a row against Meta's console. It shows the body with its placeholders and the variables in order, so the person can compare against what they submitted.

**Two permission codes: `templates.view` to read, `templates.manage` to write.** Not the three-way split Block 7 needed — nothing here destroys the way a merge does. Removing an override falls back to a default the code still holds; removing a registry row stops a future reminder rather than losing a past one. So there is no third code, and the report should say that was a decision rather than an omission.

---

## 6. Verification

The standing gates. **The proofs that are not obvious:**

*The rendered body and the sent variables agree.* Enqueue a template message and assert the stored `body` is the registry's text with those variables substituted — not merely that both are non-null (D6).

*The reminder does not send twice.* Run the sweep twice over the same winner and assert one outbox row. Proved by running it, not by reading the constraint.

*The reminder skips what it must.* A cancelled draw's winner, an already-delivered prize, a deadline outside the window, and a Station with no registered template — each excluded, each for its own reason, each asserted separately. The cancelled-draw case is the one Blocks 6c and 6d each lost once.

*An unregistered template is refused at enqueue.* The whole point of D4's cost being acceptable.

*A Station's override reaches the listener, and its absence reaches the default.* The engine resolves per Station; a test with two Stations, one overriding and one not, is what proves the fallback is per text rather than per Station.

*The tenant boundary on both tables* — isolation suite, real JWTs, as every block since 6c.

---

## 7. Out of scope, and what other blocks inherit

**The four missing behaviours** (D3) — inactivity, wait, audio rejection, call rejection. Named in the report with their cost.

**The Interaction Templates screen** (D1) — ships with the WhatsApp music-request block.

**Other Station-initiated messages.** This block builds the door and walks one message through it. The draw result, the delivery confirmation and Block 10's per-Station WABA all use the same path; each adds a `purpose` and a registry row, not a mechanism.

**Block 10** inherits the per-Station registry (D5), which is already shaped for a WABA per Station.
