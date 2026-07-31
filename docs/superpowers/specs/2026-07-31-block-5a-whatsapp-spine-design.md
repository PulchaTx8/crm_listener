# Block 5a — The WhatsApp spine — Design

Date: 2026-07-31 · Spec §10, §11 Block 5 · Follows Block 4c (PR #17, merged
`04206fe`).

One sentence: a listener sends a hashtag to their Station's WhatsApp number and
is entered into the promotion, or registered and then entered, and told so.

This is the first of two passes. **5a is the spine** — transport, idempotency,
the worker, the outbox, and a single-message entry path. **5b is the
conversation** — art, call to action, the SIM/NÃO buttons, the requested fields,
and the promotion's questions. The split was taken with the owner: 5a already
satisfies every "Done when" the master spec sets for Block 5, and both passes
need the same spine underneath.

---

## 1. What earlier passes left for this one

Block 4a built the promotion half of the WhatsApp model and said so at the time.
Nothing here re-decides any of it:

- `promotions.hashtag`, with `promotions_hashtag_no_overlap` — a GiST exclusion
  constraint over `(company_id, lower(hashtag), tstzrange(starts_at, ends_at))`.
  **At any instant, at most one live promotion in a Station can hold a given
  hashtag.** This is what makes "which promotion did this message mean?" a
  question with one answer rather than a heuristic.
- `promotions_whatsapp_shape` — a non-null hashtag implies `whatsapp_enabled`.
  Matching on the hashtag alone is therefore sufficient, and a reader who
  expects an extra predicate should be pointed at this constraint instead.
- `use_art`/`art_url`, `yes_button_label`/`no_button_label`, `call_to_action`,
  `requested_fields`, and `promotion_questions`/`promotion_question_options`.
  **All of these belong to 5b.** 5a reads none of them.

Block 4c built the entry mechanics:

- `apply_participation` (0054) — the rules, the `pg_advisory_xact_lock` over
  `(promotion, member)`, the row, the answers, the audit entry. `SECURITY
  INVOKER`, EXECUTE granted to nobody, callable only from inside a `SECURITY
  DEFINER` body. Its own comment anticipates this block: *"Block 5 will have no
  choice about recording what happened to a message it received."*
- The four statuses `VALID | DUPLICATE | TOO_SOON | OVER_LIMIT`, and the partial
  unique index on `participations` that holds the same floor whether or not the
  advisory lock was taken.

Block 3 built the listener half, including — and this was not obvious until it
was read — the legal basis for the bot's reply. `create_member` (0034) writes
`first_contact_at` and `first_contact_origin` **write-once**, and
`update_member`'s comment states why: they are *"the evidence behind the owner's
decision (spec §7) that a listener who messages a Station first has authorised
the reply"*. 5a does not invent a consent record; it fills in the one already
designed for it.

Block 0 built `RateLimiter` (`src/lib/rate-limit/index.ts:16`) as an interface
with swappable implementations. The owner intends to bring Redis in later; that
is the seam it arrives through, and 5a does not need it (§9).

---

## 2. Decisions taken with the owner

**D1 — 5a is one message in, one participation, one reply out.** No conversation
state, no turns, no questions. A listener texts `#EUQUERO` to the Station's
number; the phone identifies them, the WhatsApp profile supplies a name if they
are new, and the participation is written with no answers. Everything the tab-2
screen configures beyond the hashtag is 5b.

**D2 — The bot is a system actor, not a user.** `participations.created_by` and
`audit_logs.actor_id` are **NULL**. Both columns are already nullable, and
0004's comment anticipated a null actor. `source = 'WHATSAPP'` carries the
origin; the audit detail carries `integration_id`, `wamid`, `promotion_id`,
`member_id` and `outcome`.

**The sender's phone number is deliberately NOT in the audit detail.** Block 3
keeps personal data out of `audit_logs` as a rule — `update_member`'s comment
states that a Member diff *"would be exactly the name/phone/e-mail/CPF/address
this whole block exists to keep out of `audit_logs`"* — and a raw phone in an
ingestion audit row would be the same leak by another door. Traceability is not
lost: `wamid` joins the audit row to `webhook_events`, whose payload holds the
phone under a table no user-scoped client can read (§3.4).

The rejected alternative was a synthetic "bot" `auth.users` row per Organization
with a Block 1c role: it would have reused every existing gate unchanged, but it
puts a fake person in the Block 10 user lists and mints JWTs for a user nobody
is.

**D3 — One WhatsApp number per Station.** `phone_number_id` resolves the Station
by itself, and 4a's exclusion constraint then resolves the promotion. Had a
single number served several Stations, the constraint would have been
insufficient — two Stations may each hold a live `#EUQUERO` — and the block
would have needed a new rule. It does not.

**D4 — The bot answers the four outcomes and stays silent otherwise.** One
sentence each for `VALID`, `DUPLICATE`, `TOO_SOON`, `OVER_LIMIT`. **Silence**
when no promotion matches, when the promotion is cancelled, and when the message
arrives outside its window. The reason for the silence is not economy: replying
to any unmatched text turns the Station's number into a paid loudspeaker for
whoever wants to point traffic at it. The cost, stated plainly: someone who
mistypes the hashtag gets nothing back and will not know why.

**D5 — Replies are free-form text, not templates.** Every reply is a response to
an inbound message, so it falls inside the WhatsApp 24-hour customer service
window, where free-form text is permitted and no approved template is required.
This is only true while every outbound message is reactive; the first
Station-initiated message (a draw result, say — Block 6) will need a template
and this decision does not extend to it.

**D6 — No secret lives in the database in 5a.** Under one Meta App, the access
token belongs to the WABA and serves every number under it. `WHATSAPP_APP_SECRET`,
`WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_ACCESS_TOKEN` are environment variables
validated at boot, the Block 0 pattern. `integrations` holds only the non-secret
mapping. When a customer brings their own WABA — Block 10, which is where the
master spec puts the configuration screen — the token moves onto the row and is
encrypted there. The cost until then: adding a Station's number is an ops step
(§6.4), not a screen.

**D7 — The ingestion rule lives in SQL; the worker is thin.** One transaction
per event covers integration lookup, promotion match, listener resolution,
`apply_participation`, and the outbox row. The participation and the message
that announces it commit together. The rejected alternatives are recorded in §8.

**D8 — A listener already in the Organization but not linked to this Station
gets linked, not duplicated.** Member dedup is Organization-scoped (§4.5 of the
master spec) and `apply_participation` refuses a listener the Station is not
linked to. So a person who already exists under Station B and now texts Station
A's number is linked to A and entered. Creating a second record would defeat the
dedup this project spent Block 3 building; refusing would tell a real listener
they cannot enter. **Flagged for the owner** — it is the one decision in this
spec taken by reasoning rather than asked (§10).

**D9 — A stored payload is pruned after 30 days; the row is not.**
`webhook_events.payload` holds a phone number and a WhatsApp profile name, which
is personal data at rest in a table Block 3's `anonymize_member` does not reach.
Retention (master spec N7, validated in Block 11) nulls `payload` after 30 days
and keeps the row: `external_id` is what idempotency needs, and it is not
personal. So a replayed message is still refused a year later, while the content
that made it personal is gone. Until the retention cron exists in Block 11, this
block ships the column comment stating the rule and the pruning function; the
schedule is Block 11's to turn on.

---

## 3. Data model

Three new tables. Each states a guarantee structurally rather than relying on
the worker to remember it.

### 3.1 `integrations`

The map from a WhatsApp number to a Station.

```sql
create type public.integration_provider as enum ('WHATSAPP');

create table public.integrations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  provider        public.integration_provider not null,

  -- Meta's id for the number. Arrives in every inbound payload at
  -- entry[].changes[].value.metadata.phone_number_id, and is the ONLY field
  -- that maps an incoming message to a Station.
  phone_number_id      text not null,
  display_phone_number text,
  waba_id              text,

  enabled boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  deleted_at timestamptz,
  deleted_by uuid references auth.users (id),

  constraint integrations_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
);

-- Both partial, and for the same reason: moving a number from Station A to
-- Station B means soft-deleting A's row and inserting B's. A total unique
-- constraint would refuse the second insert forever.
create unique index integrations_number_live
  on public.integrations (provider, phone_number_id) where deleted_at is null;
create unique index integrations_one_per_company
  on public.integrations (company_id, provider) where deleted_at is null;
```

### 3.2 `webhook_events`

```sql
create type public.webhook_event_status as enum
  ('RECEIVED', 'PROCESSING', 'DONE', 'FAILED');

create table public.webhook_events (
  id       uuid primary key default gen_random_uuid(),
  provider public.integration_provider not null,

  -- The WhatsApp MESSAGE id (wamid...), never the request id: Meta packs
  -- several messages into one POST, so one HTTP request becomes N rows here
  -- and idempotency is per message.
  external_id text not null,

  integration_id  uuid references public.integrations (id),
  organization_id uuid,   -- null until the number resolves; a message to an
  company_id      uuid,   -- unknown number belongs to no Station

  payload jsonb not null,
  status  public.webhook_event_status not null default 'RECEIVED',
  outcome text,
  attempts        integer not null default 0,
  last_error      text,
  received_at     timestamptz not null default now(),
  next_attempt_at timestamptz,
  processed_at    timestamptz,

  constraint webhook_events_external_id_unique unique (provider, external_id)
);

create index webhook_events_pending
  on public.webhook_events (coalesce(next_attempt_at, received_at))
  where status in ('RECEIVED', 'FAILED');
```

`webhook_events_external_id_unique` is what makes *"a repeated event does not
duplicate a participation"* — the master spec's own "Done when" — true by
structure. Meta retries any delivery it does not see a 200 for, so a duplicate
is normal traffic, not an attack.

`prune_webhook_payloads(p_older_than interval default '30 days')` ships with the
table and nulls `payload` on rows past the cut, keeping the row (D9). This block
does not schedule it; Block 11 does, alongside the rest of N7.

**`status` distinguishes "finished deciding" from "it worked".** `DONE` means
this event will not be looked at again; it covers a recorded participation, an
unknown number, and a hashtag matching nothing. `outcome` says which. `FAILED`
means try again. Conflating the two is how a permanently unroutable message ends
up retried forever.

### 3.3 `outbox_messages`

```sql
create type public.outbox_status as enum
  ('PENDING', 'SENDING', 'SENT', 'FAILED');

create table public.outbox_messages (
  id              uuid primary key default gen_random_uuid(),
  provider        public.integration_provider not null,
  integration_id  uuid not null references public.integrations (id),
  organization_id uuid not null,
  company_id      uuid not null,

  to_phone text not null,
  body     text not null,

  -- Unique. Reprocessing a parked event by hand must not send its confirmation
  -- a second time, and that is held here rather than by the worker being
  -- careful. Shape: '<participation_id>:confirmation'.
  dedupe_key text not null,

  status          public.outbox_status not null default 'PENDING',
  attempts        integer not null default 0,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  external_id     text,   -- the wamid Meta returns once it accepts the send
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,

  constraint outbox_messages_dedupe_unique unique (provider, dedupe_key)
);
```

### 3.4 RLS

All three tables get RLS enabled and **no policy admitting `authenticated`**.
They are system tables: `service_role` bypasses RLS and is the only reader and
writer in 5a. The operator-facing views of them — an event browser, a
reprocess button, the integration screen — are Block 10's, and each will arrive
with the policy that admits it. Enabling RLS with no policy is the deny, and it
is deliberate rather than unfinished.

### 3.5 `participation_source` gains `'WHATSAPP'`

**In its own migration, and used only in a later one.** `ALTER TYPE ... ADD
VALUE` cannot use the new value in the transaction that adds it. Two migrations,
not one; this surfaces only at `db push` and is the kind of thing that fails a
deploy rather than a test.

---

## 4. The ingestion path

### 4.1 Receipt — `POST /api/webhooks/whatsapp`

One route for every number: Meta delivers all of an App's events to a single
callback URL, and `metadata.phone_number_id` inside the payload says which
number. The route also answers `GET` with the `hub.mode`/`hub.verify_token`/
`hub.challenge` handshake Meta uses to verify the endpoint.

Order matters and is the whole security of this step:

1. Read the **raw body** and verify `X-Hub-Signature-256` (HMAC-SHA256 with
   `WHATSAPP_APP_SECRET`), in constant time. Verifying a re-serialised parsed
   body is the standard way this check silently stops working — key order and
   whitespace change, the HMAC does not match what was signed, and the usual fix
   is to disable the check.
2. Invalid signature → **401, nothing written.** Writing unverified events would
   let anyone fill the table.
3. Zod over the payload shape.
4. One `webhook_events` insert per message, `on conflict do nothing`.
5. **200 within milliseconds.** Meta re-delivers anything slow.

Non-message events (delivery receipts, read receipts, status callbacks) are
acknowledged with 200 and not stored in 5a. They carry no participation and
storing them would make the table mostly noise before anything reads it.

### 4.2 The tick — `POST /api/worker/tick`

`pg_cron` calls it through `pg_net` **every 10 seconds**, with a shared secret in
a header; the route rejects anything else. Second-level schedules need pg_cron
≥ 1.5; the runbook (§6.4) verifies the hosted project's version and falls back to
one minute if it is older. It does two things and knows nothing about promotions:

- Select up to **50** pending event ids, call `ingest_whatsapp_event(id)` once
  per event — **each in its own transaction**, so one poisonous event does not
  roll back a batch.
- Drain up to **50** `outbox_messages` through the transport (§6).

The batch caps keep a tick inside a serverless function timeout. A backlog
larger than 50 simply takes more ticks; nothing is dropped, because the tick
selects from the table rather than being handed a list.

That the worker holds no rule is what makes the master spec's promise real —
swapping polling for `pgmq` later changes the trigger and nothing else.

### 4.3 `ingest_whatsapp_event(p_event_id uuid) returns jsonb`

`SECURITY DEFINER`, `set search_path = pg_catalog, public`, EXECUTE revoked from
`public` and granted **only to `service_role`**.

1. `select ... from webhook_events where id = p_event_id and status in
   ('RECEIVED','FAILED') for update skip locked`. Two concurrent ticks cannot
   both take the same event; the loser returns `skipped` rather than blocking.
2. `metadata.phone_number_id` → `integrations` where `enabled` and not deleted.
   Not found → `DONE`, outcome `no_integration`, silent.
3. Extract the hashtag: the first token matching `#[^\s#]{1,39}` — a real
   message is `"quero participar #EUQUERO !!"`, not a bare tag. None → `DONE`,
   outcome `no_hashtag`, silent.
4. **Everything from here judges the message by its own timestamp, never by
   `now()`.** An event reprocessed an hour later must be decided as of when the
   person actually wrote — which is what 4c's symmetric interval window was
   fixed to support, and what makes reprocessing meaningful rather than a
   different question asked later.

   Match the promotion on `company_id` and `lower(hashtag)`, not deleted, not
   cancelled, and the **message timestamp** inside `[starts_at, ends_at)`. 4a's
   exclusion constraint guarantees at most one at any instant, including a past
   one. On no match, one diagnostic lookup — same Station and hashtag, ignoring
   window and cancellation, most recent first — turns a single unhelpful outcome
   into three an operator can act on: `no_promotion`, `promotion_cancelled`,
   `outside_window`. All three are `DONE` and all three are silent (D4); the
   distinction is for whoever is asked "why didn't it work?".
5. Resolve the listener (§5). New listeners are created with the WhatsApp
   profile name, the sender phone, `first_contact_at` = the message timestamp
   and `first_contact_origin` = `'WHATSAPP'` — the write-once consent evidence
   Block 3 designed.
6. `apply_participation(promotion, member, message_timestamp, 'WHATSAPP', '[]')`.
7. Insert the reply into `outbox_messages` with
   `dedupe_key = participation_id || ':confirmation'`.
8. Write this function's **own** audit row — action `ingest_whatsapp_event`,
   `actor_id` NULL, detail carrying `integration_id`, `wamid`, `promotion_id`,
   `member_id` and `outcome`, and **no phone number** (D2).
   `apply_participation` writes its own row about the participation. Two rows,
   two facts, neither pretending to be the other.
9. `DONE`, outcome `recorded`, and the participation status returned to the
   worker.

Steps 5–7 commit together with step 6. There is no state in which a listener is
entered and never told, or told and not entered.

---

## 5. The listener, and the surgery this needs

`resolve_or_create_member` (0054) cannot be reused. It is `SECURITY INVOKER` and
its callees gate on `has_permission(..., auth.uid())`; inside a `DEFINER` body
reached by `service_role`, `auth.uid()` is NULL and both raise 42501.

Three options were weighed and two rejected:

- **Reimplement the dedup on the bot's path.** Rejected. It is literally *one
  rule with two entrances* — the defect Block 4b was returned for twice — and
  the rule duplicated would be the Organization-scoped dedup that Block 3 exists
  to hold.
- **Teach `has_permission` a system context.** Rejected. It weakens the gate for
  every caller to serve one.
- **Extract the private cores.** Chosen, because the project already did exactly
  this once: `apply_participation` is a private `INVOKER` core with EXECUTE for
  nobody, and each public door checks its own gate beside its own operation
  before calling it.

Three functions in Block 3 are touched. **Every public signature, gate and
behaviour is preserved** — each keeps its check and delegates the mechanics:

| Function | Core extracted | Why the bot needs it |
|---|---|---|
| `find_member_by_identifier` (0033) | the identifier match | find the listener by phone |
| `create_member` (0034) | insert + `member_company_links` insert | register a new listener, already linked |
| `link_member_to_company` (0034) | the link insert | D8: exists in the Organization, not in this Station |

The cores are `SECURITY INVOKER` with EXECUTE granted to nobody, reachable only
from inside a `DEFINER` body — the same shape, and for the same reason, as
`apply_participation`.

This is additive and behaviour-preserving, and it is still surgery on merged,
deployed Block 3 code. It is called out here so it is a decision rather than a
surprise in a diff.

---

## 6. Transport, replies and operations

### 6.1 The transport interface

```
src/lib/integrations/whatsapp/
  transport.ts   the interface: sendText(to, body) -> { externalId }
  graph.ts       the real one, Meta Graph API
  fake.ts        the test one, records calls, fails on demand
```

This is the seam the master spec means by a "decoupled" integration layer — a
module boundary, not a network hop. It is what lets CI prove the whole block
with no production secret anywhere near it.

### 6.2 The four replies

Written in Portuguese, first cut below; the owner adjusts the wording, and it is
data rather than code.

| Status | Reply |
|---|---|
| `VALID` | Pronto! Você está participando de **{promoção}**. Boa sorte! |
| `DUPLICATE` | Você já está participando de **{promoção}**. |
| `TOO_SOON` | Você já participou há pouco. Sua próxima chance é às **{hora}**. |
| `OVER_LIMIT` | Você já usou suas **{n}** chances nesta promoção. |

`{hora}` is rendered in the Station's timezone (`companies.timezone`, present
since 0007) — not the server's, and not the listener's, which we do not know.

### 6.3 Failure and reprocessing

| Situation | Outcome |
|---|---|
| Invalid signature | 401, nothing written |
| Malformed payload, valid signature | stored, `FAILED` + `last_error`; it really came from Meta and the evidence matters |
| Unknown number | `DONE`, `no_integration`, silent |
| No hashtag in the message | `DONE`, `no_hashtag`, silent |
| Hashtag matches nothing / cancelled / outside window | `DONE`, `no_promotion` \| `promotion_cancelled` \| `outside_window`, silent |
| Transient fault (deadlock, timeout) | `FAILED`, `attempts++`, retried at 1s, 4s, 16s, 64s, 256s, then parked at 5 attempts |
| Meta refuses a send permanently (bad number) | outbox row `FAILED`, no retry |
| Meta rate-limits or returns 5xx | outbox row stays `PENDING`, same backoff ladder |

Reprocessing a parked event is safe by structure: `webhook_events_external_id_unique`
stops a second row, `apply_participation` returns `DUPLICATE` rather than a
second entry, and `outbox_messages_dedupe_unique` stops a second confirmation.

### 6.4 Bringing a number online

No screen in 5a (D6). The runbook covers: creating the `integrations` row,
setting the three environment variables, pointing Meta's callback URL at
`/api/webhooks/whatsapp` with the verify token, and scheduling the `pg_cron`
job. It ends with the real end-to-end pass the owner runs himself (§7).

---

## 7. Verification

The 4c review found a Critical that had passed six gates because **every
interval test in the block was written in the same chronological order** — it
passed for the wrong reason. The shape of this section is a response to that.

- **Unit (Vitest).** HMAC over the **raw** body, including a case that proves a
  re-serialised body fails — the trap in §4.1 asserted rather than described.
  Hashtag extraction from messages with leading text, trailing punctuation,
  several tags, and none. Payload Zod. Reply rendering, including the timezone.
- **Against the running database, in a rolled-back transaction** — the method
  the 4c reviewer proved. Repeated `wamid`; unknown number; hashtag matching
  nothing; cancelled promotion; before `starts_at` and at exactly `ends_at`;
  existing listener; new listener; listener in the Organization but not this
  Station (D8); and each of the four statuses.
- **Judged by the message timestamp, not by `now()`.** An event whose promotion
  window has since closed is ingested and recorded; an event whose window had
  not yet opened when it was written is refused, even though `now()` is inside
  the window. Both cases fail if step 4 and step 6 ever drift apart onto two
  different clocks, and neither is visible in a test that ingests immediately —
  which is what every other test here does.
- **No phone number reaches `audit_logs`** (D2). Asserted against the row the
  ingestion writes, because the rule it obeys belongs to Block 3 and nothing in
  this block's own code would fail without it.
- **Concurrency, 12 rounds.** Two simultaneous ingestions, different `wamid`s,
  same person and promotion → exactly one `VALID`. Twelve rounds because a
  single green run does not prove a probabilistic detector — the lesson from
  4c's broken debounce guard, which passed by reasoning and held 0 of 6 when
  measured.
- **Isolation harness, real JWT.** `authenticated` **cannot** execute
  `ingest_whatsapp_event`. The grant is the defence; this is what proves the
  defence is there.
- **End to end against the fake transport**, in CI, with no secret.
- **One real pass against Meta**, run by the owner from his own `.env.local`:
  tunnel, verified webhook, a message from his phone, a participation in the
  database, a reply on his phone. Recorded in the block report.

---

## 8. Deliberately out of this pass

- **Everything the tab-2 screen configures beyond the hashtag** — art, call to
  action, SIM/NÃO buttons, requested fields, and the promotion's questions.
  That is 5b, and it is the pass that needs conversation state.
- **A Deno Edge Function worker**, which is what §10 M2 of the master spec says
  literally. The *contract* is kept — idempotent worker, `RECEIVED → PROCESSING
  → DONE/FAILED`, retry/backoff, manual reprocessing, one worker draining the
  outbox, swappable for `pgmq` — but the runtime is a Next.js route. A Deno
  worker cannot import `src/services/`, so the ingestion rule would exist twice,
  in two languages; and the repository has no Edge Function infrastructure and
  Vitest does not test Deno. **This deviates from the letter of the master spec
  and was accepted by the owner on 2026-07-31.**
- **Redis.** 5a has no conversation state for it to hold, and the concurrency it
  would guard is already held by `apply_participation`'s advisory lock plus the
  partial unique index — a Redis lock beside those would be a weaker second lock
  whose disagreement the database would win anyway. At a spike the limit is
  Meta's outbound rate, not Postgres. It arrives in 5b for conversation state
  with TTL, and for outbound smoothing, through the `RateLimiter` interface
  Block 0 already built. The rule agreed for when it does: **Redis for what is
  disposable, Postgres for what is a fact.**
- **Non-message webhook events** (delivery and read receipts).
- **Operator screens** for events, outbox and integrations — Block 10.
- **Station-initiated messages** and therefore message templates (D5).

---

## 9. Carried in, not created here

Two defects outside this block are live in `main` and remain unassigned. Neither
is touched here and neither is caused here:

- `decodeCursor` (`src/lib/keyset.ts:32`) accepts any non-empty string as an id;
  `promotions/page.tsx:75` turns a forged cursor into a 500. The fix is one
  predicate plus a unit case per caller, and it touches four shipped callers.
- The age filters in `members-filters.tsx` (lines 34-38, 72): the URL echo
  effect overwrites the field mid-typing, so `25` becomes `2`.

---

## 10. Open

**D8 is the one decision here taken by reasoning rather than asked.** A listener
who already exists elsewhere in the Organization and texts this Station's number
is **linked** to it and entered. The alternatives are a duplicate record, which
defeats Block 3's dedup, or a refusal, which tells a real listener they cannot
enter a promotion they are eligible for. It is recorded here for the owner to
confirm or overturn on review.
