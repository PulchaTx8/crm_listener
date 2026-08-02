# Block 5b — The conversation — Verification Report

**Branch:** `block-5b`, 20 commits, not merged and **no PR opened** — the owner
decides when it opens.
**Migrations:** `0065`–`0073`.
**Diffstat against `main`:** 46 files, +8 619 / −127.

The bot now holds a conversation. A hashtag opens it with one composed message —
the promotion's banner, its name and call to action, and two buttons — and the
listener is entered only when they say yes and answer what the promotion asks
for. Somebody who says no is recorded as having said no. Somebody who stops
half-way costs nothing and means nothing.

---

## 1. Gates

Every number below was measured on this branch after a clean `supabase db reset`,
not copied from anywhere.

| Gate | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm test` (Vitest) | **506** cases, 33 files |
| `npm run db:test` (pgTAP) | **675** cases, 9 files |
| `npm run test:isolation` | **204** cases, 18 files, guard-complete |
| `CI=1 npx playwright test` | **23** passed |

Where they were before this block: Vitest 405 → 506, pgTAP 586 → 675, isolation
192 → 204, Playwright 23 → 23.

**The isolation suite's worker-death flake did not appear once** in roughly a
dozen full runs this block. That is not a fix and should not be read as one —
nothing was done to it, and 5a measured it at about two runs in five. It is
recorded because a stretch that long without it is itself information.

---

## 2. What shipped

**Schema** — `promotions.data_validity_months`; `member_field_confirmations`
(per listener, per field, when it was last confirmed);
`promotion_refusals`; `whatsapp_conversations` (the default store);
`whatsapp_conversation_leases` (what serialises a turn);
`outbox_messages.interactive`.

**Rules** — `whatsapp_conversation_steps` (the list, computed once);
`member_field_value` / `member_field_values` (the one home of the
enum-to-column mapping); `participation_status_for` (the one home of the three
entry rules); `start_whatsapp_conversation`; `complete_whatsapp_conversation`;
`record_whatsapp_refusal`; `apply_member_field_confirmations`;
`sweep_expired_conversations`; the doors `finish_whatsapp_turn`,
`enqueue_whatsapp_outbound`, `claim_conversation_turn`,
`release_conversation_turn`, `whatsapp_prompt_context`.

**Application** — `src/lib/conversation/engine.ts` (the whole conversation as a
pure function), `steps.ts`, `store.ts` + `postgres-store.ts` + `redis-store.ts`,
`src/services/conversation.ts` (the turn), interactive messages in and out, the
tick trigger on the webhook route.

---

## 3. The decisions, and where they landed

D1 → `data_validity_months` (0065). D2 → `member_field_confirmations`, per field
(0065), and `apply_member_field_confirmations` (0073). D3 → the backfill on
`created_at` (0065) and the operator's save (0073). D4 → `promotion_refusals`
(0065) and `record_whatsapp_refusal` (0071). D5 → the thirty-minute window,
`CONVERSATION_WINDOW_SECONDS`, and the sweep (0072). D6 → `ConversationStore`
and both drivers. D7 → `whatsapp_conversation_steps`, computed once. D8 → the
pre-check in `ingest_whatsapp_event` and the authoritative write in
`complete_whatsapp_conversation`. D9 → the tick fired by the webhook route.
D10 → the engine's re-prompt inside the window, and `no_conversation` silence
outside it.

---

## 4. Deviations from the plan, recorded

Two were ruled on by the owner on 2026-08-02, before the code was written:

1. **The lock became a lease.** The spec's `pg_advisory_xact_lock` on
   `(integration, phone)` cannot serialise a turn, because the engine is
   TypeScript: a turn is `load → advance → write`, the middle step runs in Node,
   and the lock is released at commit — before the load and after the write. The
   claim/reclaim shape 0063 already uses replaced it. §4.3 of the spec is amended
   and says what it used to say.
2. **The Redis driver moved after the wiring.** The plan had SQL insert into and
   delete from `whatsapp_conversations` directly, which would have started
   conversations in one store while every later turn looked for them in the
   other. The store is now the only writer of the state; SQL computes and
   returns.

One structural deviation was mine, and stated in the amendment: **Task 7 split
into 7a–7d**, one migration and one job each, after reading it out revealed
three prerequisites it did not contain (§5.1 below).

Two smaller ones, each argued at its call site: the store contract's factory
takes a window and a key (the expiry case cannot otherwise be written without
reaching past the interface), and the lease claim returns a token rather than a
boolean (without it a worker whose lease was taken over would free the lease of
the worker that took it).

---

## 5. Concerns

### 5.1 Five ways the block could not have worked, found before they shipped

Each of these, alone, meant the conversation could not happen. None was visible
to any suite this repository had: **pgTAP runs as `postgres` and ignores ACL**,
and the route tests **mock the client** — the two blind spots that made Block 5a
non-functional in production while every test passed.

1. **The consent button produced no event at all.** `flattenWebhookBody`
   validated against `type: 'text'` and dropped everything else, so a listener
   pressing **Quero!** wrote no `webhook_events` row. The engine had handled
   button and list answers since Task 4 and neither had a source.
2. **The outbox could not carry an interactive message.** `body text` and
   nothing else; `sendInteractive`, built in Task 3, had no way out of the
   building.
3. **The lock protected neither end of the read-modify-write** (§4).
4. **The Redis driver could not have been reached** (§4).
5. **SQL and TypeScript disagreed about the step keys** — `question_id` /
   `question_kind` against `questionId` / `questionKind`. The conversation would
   have failed to parse on the first question of any promotion that had one.

The fifth is the one worth drawing a lesson from: it was caught by the **Zod
schema at the store boundary**, written in Task 5 for exactly this reason — a
document built in plpgsql and read in TypeScript, with nothing else checking
that the two agree. It paid for itself before it ever ran against production.

The first four were caught by **reading the task out loud against the code it
would touch, before writing it**. That is not a process anybody can rely on
twice; §5.6 says what would.

### 5.2 Every existing promotion changes behaviour on deploy

A hashtag no longer enters anybody. **Every promotion that exists takes at least
two messages instead of one**, from the moment this deploys, with nothing
configured and nobody warned. Stations should hear it from us rather than from a
listener.

### 5.3 The lease is not a fencing token

It guarantees that two **live** workers cannot run a turn for one phone. It does
not stop a worker that was declared stale, taken over, and then woke up from
writing the state it was holding — the store's `save` does not carry the token.
The window is the staleness interval (five minutes) against a turn that takes
under a second. Closing it means a compare-and-set in the store, which §4.4
refuses on the grounds that the lease is the one mechanism. The table comment
states the limit rather than leaving the guarantee to be read as larger than it
is.

### 5.4 The inbound reclaim is load-bearing now

Until this block, no path through `ingest_whatsapp_event` committed a row in
`PROCESSING`, and 0063's comment called the inbound arm of
`reclaim_stale_whatsapp_claims` insurance. Two paths leave it PROCESSING now, so
a worker that dies mid-turn leaves a claimed row that only the reclaim frees,
five minutes later. The alternative — finishing the event first — loses the
message outright in the same crash, and a listener whose hashtag was recorded as
handled and answered by nothing has no way to know. Delay that recovers itself
beats silence.

### 5.5 `create_member` writes no confirmations

Found by Task 10's own isolation case, and **not fixed**, because it is outside
that task's scope and the fix means restating a hundred-line function.

The backfill (0065) covered every record that existed at migration time, and
`update_member` (0073) now covers every save. A record an operator **creates**
after this deploys has no confirmation for anything, so the bot asks that
listener for data the operator has just typed — which is the opposite of the
owner's ruling that typed data counts as confirmed on the day it was typed.

Severity is low and it self-heals: the bot asks once, the listener answers, and
the confirmation exists from then on. But it is a decision to take rather than a
detail to leave: `create_member` should call
`apply_member_field_confirmations(member, org, '{}', member_field_values(member))`
after its write, exactly as `update_member` does.

### 5.6 The gap between "the tests pass" and "it works" is still open

Three defects in 5a and five here existed at the same seam: **the HTTP and
privilege boundary**, or the boundary between SQL and TypeScript. Both blocks
found them by hand, late, and by luck — 5a in Task 12 "by accident", this one by
reading a task out before writing it.

What actually catches this class is a test that drives the **real path as the
real role**: this block's `tests/isolation/conversation.test.ts` opens a
conversation, presses the button, answers the question and asserts the entry —
and would have failed on all five. The isolation suite is where that lives and
it is now 204 cases. The lesson to carry into Block 6: **write the end-to-end
case first**, before the pieces it will exercise, and let it fail for the right
reason each time a piece lands.

### 5.7 Inherited, unchanged

`whatsapp_local_phone` still strips only `+55`; outbound delivery is still
at-least-once by decision (D7 of 5a); the `pg_net` version and the job's
`timeout_milliseconds` are still unchecked by the runbook and belong to
Block 11's observability.

---

## 6. Two test defects this block created and fixed

Both were the same mistake, made twice, and both were found by a suite going red
for a reason that had nothing to do with the code under test:

- 07's `exactly one abandoned event is reclaimed` counted the **whole
  installation**. A conversation turn that loses the lease legitimately leaves
  its event `PROCESSING`, so the isolation suite — which commits its rows —
  turned that assertion into a statement about whatever else had run that day.
- 08's sweep assertion did the same with expired conversations, and I wrote it
  after fixing the first one.

Both are now scoped to the rows their own fixture owns. The general rule, which
07's older comments already knew and this block had to relearn twice: **in a
suite that shares a database with one that commits, never assert a global
count.**

---

## 7. Deferred

- **`create_member`'s confirmations** (§5.5) — owner's call.
- **The fencing gap** (§5.3) — stated, not closed.
- Everything the plan's §7 already listed as out of scope.
