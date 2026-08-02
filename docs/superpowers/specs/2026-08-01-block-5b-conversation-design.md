# Block 5b — The conversation — Design

Date: 2026-08-01 · Follows Block 5a (PR #18, merged `1e99ab2`).

One sentence: the bot holds a short conversation — consent, the listener details
the promotion asks for, and the promotion's questions — and enters the listener
only when it completes.

Block 5a is the spine: a listener texts a hashtag and is entered by that single
message. 5b is everything the promotion's tab 2 configures beyond the hashtag,
and it is the first block in this project where the bot has to remember
something between messages.

---

## 1. What 5a left for this one

5a shipped the transport and deliberately read none of the conversation's
inputs. All of these are already modelled and untouched:

- `promotions.use_art` / `art_url`, `call_to_action`, `yes_button_label` /
  `no_button_label` — the consent step.
- `promotions.requested_fields`, an array of `promotion_requested_field`
  (`full_name, address, city, neighbourhood, age, cpf, passport,
  discovery_source`) — eight of the eleven checkboxes on the owner's screen;
  the other three were dropped by decision D5 of the 4a spec.
- `promotion_questions` and `promotion_question_options`, with `menu_title` and
  `button_label` described in 0041 as *"the two fields of a WhatsApp interactive
  list message"*.

And the mechanics 5b writes through:

- `apply_participation` (0054) already takes an answers array and writes
  `participation_answers` from it. 5a passes `'[]'`; 5b fills it. **No change to
  that function is needed for the answers.**
- `ingest_whatsapp_event` (0062) resolves integration → promotion → listener and
  writes the entry. 5b changes *when* the entry is written, not how.
- `outbox_messages` and the worker drain every outbound message.

---

## 2. Decisions taken with the owner

**D1 — Data validity is set per promotion, in months.** A new column beside
`requested_fields`: how old a value on the listener's record may be and still be
accepted for this promotion. The owner's example: `#EUQUERO` accepts data
validated **three months or less** ago. Empty means no requirement; `0` means
always ask again.

The rule, per requested field:

| The field on the record | The bot |
|---|---|
| Empty | **asks** — validity does not enter into it |
| Filled, confirmed within the window | **skips** |
| Filled, confirmed longer ago | **asks and updates** |

**D2 — The confirmation timestamp is per field, not per record.** A single
timestamp on `members` breaks for exactly the listener who uses the system most:
somebody who enters weekly through promotions that ask only for `city` refreshes
that one timestamp every week, and their **address is never asked again**, at any
age. The feature switches itself off for the heaviest participant. Per-field
confirmations keyed on the same `promotion_requested_field` enum the promotion
already uses mean the two sides cannot drift.

**D3 — Data an operator typed counts as confirmed when it was typed.** Not "only
the listener validates". For records that already exist, each filled field is
backfilled with `members.created_at` — **not** `updated_at`, which would let a
2024 record whose phone was corrected yesterday report a fresh address.
`created_at` never claims a field is newer than can be proved, and it errs
toward asking.

**D4 — Pressing NO ends the conversation and the refusal is recorded.** Not as a
participation: in its own table. Block 4c's reasoning applies unchanged — a
fifth `participation_status` would let the draw's "VALID only" filter go on
looking complete while hiding a different kind of fact. A refusal is not a bad
entry; it is another thing entirely, and recording it is what lets the Station
measure refusal against abandonment and avoid pestering somebody who said no.

**D5 — A conversation resumes inside a window and is discarded after it.** While
it lives, any message continues at the step it stopped on. Once the window
passes it is gone and the next hashtag starts from the beginning. **Window: 30
minutes of silence.** This is the state a TTL store holds well, and it is why
the owner asked for the spine first.

**D6 — The state lives behind an interface: Postgres by default, Redis
optional.** The same shape Block 0 gave `RateLimiter`: `ConversationStore` with
a Postgres implementation as the default and a Redis driver switched on by an
environment variable. The application boots without Redis, so CI and development
need no new service, and the owner can turn it on when volume justifies it.

**D7 — The step list is computed once, at the start, and stored.** When the
hashtag arrives the bot resolves the whole list — which fields are empty or
stale, which questions exist — and then walks it with a cursor. The rejected
alternatives: recomputing the next step on every message costs a database round
trip per turn and lets a field that was fresh at the start expire mid-conversation;
a named state machine is the same cursor with ceremony, since its states are
only ever "position in the list". Computing once also means **editing the
promotion mid-conversation does not change the conversation somebody is already
having**.

**D8 — The rules are checked at the start and the participation is written at the
end.** It cannot be written at the start, as 5a does: somebody who presses NO
did not participate, and neither did somebody who abandoned. But checking only
at the end is cruel — a listener would answer five questions before hearing they
had already used their chances. So: a read-only pre-check when the hashtag
arrives, and the authoritative write when the conversation completes. **The two
can disagree** if the listener enters by another route in between; the final
write is the truth and the reply says what actually happened.

**D9 — The webhook route triggers a tick; `pg_cron` remains the safety net.**
The worker runs every ten seconds and drains the outbox in the same tick, so
without a trigger each turn waits up to ten seconds and a six-step conversation
accumulates half a minute of silence. The route fires a tick after storing,
without awaiting it. This is safe here specifically because the application runs
as a long-lived Node process in a container (EasyPanel), not on a serverless
platform that freezes after the response — the same correction the 5a fix wave
applied to comments that named the wrong runtime.

**D10 — Silence after the window, a re-prompt inside it.** 5a's D4 keeps the bot
silent for text that matches no promotion, so the Station's number cannot be
turned into a paid loudspeaker. That rule holds here: once the state is gone,
there is nothing distinguishing that person from a stranger, so a stray message
gets silence. **While the state is alive it is different** — the bot knows this
person is mid-conversation, so an unusable answer gets a re-prompt.

---

## 3. Data model

### 3.1 `promotions` gains one column

```sql
alter table public.promotions
  add column data_validity_months integer
    check (data_validity_months is null or data_validity_months >= 0);
```

Null means no freshness requirement; a filled field is never re-asked. Zero
means every requested field is asked every time. It pairs with
`requested_fields`, which says *which* fields — this one says *how old they may
be*.

### 3.2 `member_field_confirmations`

```sql
create table public.member_field_confirmations (
  member_id       uuid not null,
  organization_id uuid not null references public.organizations (id),
  field           public.promotion_requested_field not null,
  confirmed_at    timestamptz not null default now(),
  primary key (member_id, field),
  constraint member_field_confirmations_member_org_fk
    foreign key (member_id, organization_id)
    references public.members (id, organization_id)
);
```

One row per field per listener, always the most recent confirmation. The `field`
column is the **same enum the promotion marks**, so the two sides cannot name
different things.

Backfilled from `members.created_at` for every field already filled (D3).

RLS follows `members`: the operator's screens will eventually show when a field
was last confirmed, so this is not a system-only table like `webhook_events`.
The policy mirrors `members_select_reachable`.

### 3.3 `promotion_refusals`

```sql
create table public.promotion_refusals (
  id              uuid primary key default gen_random_uuid(),
  promotion_id    uuid not null,
  member_id       uuid not null,
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  refused_at      timestamptz not null default now(),
  source          public.participation_source not null,
  constraint promotion_refusals_promotion_fk
    foreign key (promotion_id, company_id)
    references public.promotions (id, company_id),
  constraint promotion_refusals_member_org_fk
    foreign key (member_id, organization_id)
    references public.members (id, organization_id),
  constraint promotion_refusals_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
);
```

Note the composite foreign keys: the tenancy pattern this schema uses
everywhere, and the one whose absence was an Important finding in 5a.

**A refusal implies a listener record exists.** The bot resolves or creates the
listener before the consent step, exactly as 5a does, so somebody who presses NO
has a record. That is deliberate and consistent: they contacted the Station,
which is the consent evidence Block 3 records write-once in
`first_contact_at`/`first_contact_origin`, and the record is what lets the
Station know not to pester them.

---

## 4. The conversation

### 4.1 The step list

Computed once when the hashtag arrives, in this order:

1. **Consent — one composed message, not three.** The owner specified its
   contents on 2026-08-01:

   > **banner → promotion name → call to action → the two buttons**

   That is exactly the Cloud API's interactive-button shape: an image header
   carrying `art_url` when `use_art` is set, a text body, and the action. The
   **name and the call to action both live in the body**, the name first,
   separated by a blank line. It is a single send — the bot does not post the
   art, then the text, then the buttons.

   **Consent is always present**, even when the promotion configures none of
   those three. It is the only step that can produce a NO, and a listener who
   cannot decline is a listener the block has no honest record for. When
   `call_to_action` is empty the body is the name alone; when `use_art` is false
   there is no header and the message begins at the body; when the button labels
   are empty the bot uses **Quero!** and **Agora não**. Those defaults are copy,
   changeable without a migration.

   The consequence, stated rather than discovered: **every promotion that exists
   today takes one more message than it did.** A hashtag no longer enters
   anybody directly — it opens a conversation whose first step is this message.
2. **One step per requested field** that is empty, or whose confirmation is
   older than `data_validity_months`, in the enum's own order — the order D6 of
   the 4a spec fixed when the owner said a field would never need settings of
   its own.
3. **One step per promotion question**, in `position` order, rendered as an
   interactive list using `menu_title` and `button_label` for `QUIZ` and
   `MULTIPLE_CHOICE`, and as free text for `ESSAY`.

If no field is stale and the promotion has no questions, the list is consent
alone — which is the shortest honest conversation, not a special case.

### 4.2 What is written, and when

**Nothing until the end.** Each turn stores the answer in the conversation
state; the record is not touched. A conversation that is abandoned or expires
writes nothing, which is what makes an incomplete confirmation not count.

On the final step, **one transaction**:

1. the collected values onto `members`
2. a `member_field_confirmations` row per field the listener actually answered,
   with `confirmed_at = now()`
3. `apply_participation(promotion, member, final_message_timestamp, 'WHATSAPP',
   answers)` — the answers array it has always accepted
4. the outbox row carrying the reply

and then, once that transaction has committed, **the conversation state is
cleared** — outside it, because the state may not live in Postgres at all
(§4.3, amended 2026-08-02). An earlier version of this list counted the clear as
a fifth write inside the transaction; it cannot be one for the same reason the
lock could not be an advisory lock. A clear that fails leaves the state on the
final step and the listener's next message re-runs the turn, where
`apply_participation` answers `DUPLICATE` — the at-least-once §4.3 already
commits to, and the reason the four writes above are the ones that have to be
atomic.

**Which timestamp, and it matters.** The conversation spans several messages, so
"the message timestamp" is ambiguous. The entry is judged by the **last** one —
the moment the listener completed — not by the hashtag that opened the
conversation. Somebody who starts at 14:00 and finishes at 14:20 on a promotion
that closed at 14:10 is refused, which is the behaviour §5 already commits to.
Using the opening timestamp would let a conversation begun in time complete out
of time, and would make the closing moment mean nothing.

It is the message timestamp rather than `now()` for the same reason 5a judges
everything by it: a turn processed late must be decided as of when the person
wrote, not when the worker got to it.

A listener created during the conversation keeps the **opening** timestamp in
`first_contact_at`, because that is when they contacted the Station — the fact
that column records.

**On NO at the consent step:** the refusal row, the state cleared, the goodbye
enqueued. No participation.

### 4.3 The lock, and why it lives in Postgres

Two messages from one person arriving close together must not both advance the
cursor from the same index — one answer would be lost in silence, and people
double-send constantly.

**Amended 2026-08-02, on the owner's ruling, before Task 7 was written.** What
this section used to say: the turn is processed inside the ingest transaction,
so an advisory lock on `(integration, phone)` taken there serialises turns
regardless of where the state lives — one mechanism, both drivers, the same
`pg_advisory_xact_lock` shape `apply_participation` uses for
`(promotion, member)`.

**It does not serialise them, and the reason is structural: the engine is
TypeScript.** A turn is `load → advance → write`, and the middle step runs in
Node. `pg_advisory_xact_lock` is released when the transaction that took it
commits, which happens *before* the state is read and *before* the write goes
back — so the lock covers neither end of the read-modify-write it was supposed
to protect. Two overlapping ticks can read one conversation at the same cursor,
and one listener's answer is lost. **The ticks overlap by design**: `pg_cron`
fires every ten seconds whether or not the previous one returned — the comment on
`drainOutbox` in `src/services/whatsapp.ts` says exactly that about the outbound
half — and D9 adds a tick fired by the webhook on top of it.

**What replaces it: a lease, in Postgres, held for the whole turn.** One row per
`(integration, phone)`, claimed before the state is read and released after it is
written, and taken over by the next claimer once it goes stale. That is the
claim/reclaim shape `claim_outbox_batch` and `reclaim_stale_whatsapp_claims`
(0063) already use, adopted here for the same reason they exist: *a claim that
has to outlive its transaction cannot be a lock.* It keeps the property the
advisory lock was chosen for — **one mechanism, in Postgres, working whichever
driver holds the state** — and adds the one it could not have: it spans Node's
part of the turn.

A turn that cannot claim the lease neither waits nor drops the message: the event
is left for the next tick, which is what 5a's `deferEvent` already does with an
event it could not decide. Waiting would hold a worker for the length of somebody
else's HTTPS call to Meta.

**The state is written after the turn's database work, never before.**
Non-final turns have no database work, so the state write is the only write. The
final turn commits everything and then clears the state; if that commit fails,
the state stays on the final step and the listener's next message re-runs it —
at-least-once on the last answer, with `apply_participation` returning
`DUPLICATE` if it genuinely ran twice.

### 4.4 The state, and its store

The state is deliberately small — a list, a cursor and the answers so far:

```ts
interface Conversation {
  integrationId: string;
  phone: string;          // as WhatsApp delivered it
  promotionId: string;
  memberId: string;
  steps: Step[];
  cursor: number;
  answers: { fields: Partial<Record<RequestedField, string>>; questions: Answer[] };
  reprompts: number;
  expiresAt: string;
}
```

Keyed on `(integrationId, phone)` — **not** on the listener, because the key has
to work before anybody has been resolved.

```ts
interface ConversationStore {
  load(key: ConversationKey): Promise<Conversation | null>;
  save(key: ConversationKey, value: Conversation): Promise<void>;
  clear(key: ConversationKey): Promise<void>;
}
```

No compare-and-set in the interface: the lease in §4.3 is what serialises
writers, and putting a second concurrency mechanism in the store would be two
answers to one question. The Postgres implementation is a table with an
`expires_at` column, swept by the worker that already runs every ten seconds;
the Redis implementation is `SET` with a TTL and nothing to sweep.

**The store is the only writer of the state — amended 2026-08-02.** Not
`start_whatsapp_conversation`, not `complete_whatsapp_conversation`: SQL
computes the step list and returns it, and Node writes it through whichever
driver is configured. An implementation plan that had the two RPCs insert into
and delete from `whatsapp_conversations` directly would work perfectly with the
default driver and leave the Redis one **starting conversations in one store and
looking for them in the other** — the bot going silent after the consent message,
in precisely the deployment the Station turns Redis on for. A driver that cannot
be reached is worse than one that does not exist, because it looks like a choice.

**Order of work, on the owner's ruling of 2026-08-02:** the Redis driver is
built *after* the conversation is wired end to end, so that the first thing it
does is run against a path that actually uses it.

---

## 5. What breaks, and what it does

| Situation | Behaviour |
|---|---|
| Answer that does not fit the step | Re-prompt without advancing, **capped at three per step** — the counter resets when a step is answered, so a long conversation is not ended by three mistakes spread across it. On the fourth failure at one step the conversation ends with a message. Without the cap a confused listener burns paid messages indefinitely. |
| Window expires, then a message arrives | Silence (D10). The state is gone and that person is indistinguishable from a stranger. |
| A different valid hashtag mid-conversation | The old conversation is discarded and the new one starts. That is what the person meant. |
| The promotion closes mid-conversation | The final write refuses and the reply says so. The listener answered in good faith and deserves the reason. |
| The listener is over the limit at the end but was not at the start | The final write is the truth (D8); the reply carries the real status. |
| Two messages at once | Serialised by the advisory lock (§4.3). |
| A field answered with something unusable for its type (a date, a CPF) | Validated per field kind before it is stored; a bad value is a re-prompt, not a stored value. |

---

## 6. Verification

The conversation is a **pure function** of the step list, the answers so far and
the inbound message, returning the next outbound message and the new state. That
is the point of computing the list once (D7): the whole conversation is testable
with no database and no WhatsApp.

- **Unit, no I/O:** every step kind, every re-prompt path, the cap, the NO
  branch, the ESSAY/QUIZ/MULTIPLE_CHOICE renderings.
- **Against the database, in a rolled-back transaction:** the step list itself —
  a field empty, a field fresh, a field one day past the window, a field one day
  inside it, `data_validity_months` null, and `0`.
- **The final write is all-or-nothing:** a forced failure in the middle leaves no
  member update, no confirmation, no participation and no outbox row.
- **The window:** a conversation resumed at 29 minutes continues; at 31 minutes
  it is gone and the message is met with silence.
- **Double-send, in rounds** — twelve, matching `participations.test.ts` and for
  the reason 4c paid for: one green run does not prove a probabilistic detector.
- **One contract suite, both drivers.** The Postgres and Redis implementations of
  `ConversationStore` pass the same tests. This is what stops them diverging
  silently, and it is the only way the optional driver stays trustworthy.
- **The boundary**, per 5a's hardest lesson: whatever new table the worker
  touches gets an assertion that `service_role` can actually perform the exact
  write the application issues. Three defects in 5a existed only because nothing
  crossed that seam.

---

## 7. Deliberately out of this pass

- **Redis as a requirement.** It is a driver, not a dependency (D6).
- **Free-text interpretation.** A listener who answers two fields in one message
  gets a re-prompt for the second. Turning messy prose into typed values is the
  language layer discussed as a possible 5c, and it must never be given the
  power to write.
- **Audio.** Radio audiences send voice notes; transcription is not in this pass.
- **Off-topic answering, operator handoff, music-request intent.**
- **Re-asking a field that an operator later blanks.** Empty is empty and gets
  asked; there is no separate "invalidated" state.

---

## 8. Carried in, not created here

Two defects outside this block remain live in `main` and are untouched by it:
`decodeCursor` (`src/lib/keyset.ts`) accepts any non-empty string as an id, so a
forged cursor is a 500 on `/promotions`; and the age filters in
`members-filters.tsx` overwrite the input mid-typing.

From 5a's own report: `src/app/api/webhooks/whatsapp/route.ts` says the raw
`wamid` lives in "the only place it lives" without qualifying that this is true
of the inbound id — **5b should qualify it while it is in that file.**

---

## 9. Open

Nothing is left for the owner to decide before implementation. The two questions
that were open during design — what refreshes a confirmation when an operator
saves a record through the screen, and the exact re-prompt wording — are settled
here: an operator's save refreshes the confirmation **only for fields whose value
actually changed**, because refreshing all of them on every save reintroduces
D2's frequent-participant problem at operator scale; and the wording is copy,
adjustable without a migration.
