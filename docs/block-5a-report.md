# Block 5a — The WhatsApp spine — Verification Report

Branch `block-5a`, cut from `block-4c`'s merged head at **`04206fe`** (PR #17).
Spec in `docs/superpowers/specs/2026-07-31-block-5a-whatsapp-spine-design.md`,
plan in `docs/superpowers/plans/2026-07-31-block-5a-whatsapp-spine.md`,
execution ledger in
`.superpowers/sdd/2026-07-31-block-5a-whatsapp-spine/progress.md`. Fourteen
tasks, this report is the fourteenth.

One sentence, from the spec: *a listener sends a hashtag to their Station's
WhatsApp number and is entered into the promotion, or registered and then
entered, and told so.* This is the first of two passes — **5a is the spine**
(transport, idempotency, the worker, the outbox, a single-message entry path);
**5b is the conversation** (art, call to action, buttons, requested fields,
the promotion's questions), and needs the same spine underneath it.

**35 commits, 39 files, +11,041 / −10** over `04206fe..HEAD` — the thirteen
reviewed tasks, Task 14, and this task's own fix round (three files total:
the schedule migration, the runbook, and this report — the report's own size
is inside that count, and so is this fix round's edit to it). Measured with
`git rev-list --count` and `git diff --shortstat` as the last action before
the fix-round commit, on the tree about to be committed, because the figure
cannot be stable while the file stating it is still being edited.

---

## 1. Gates

Measured on this task's own run, on a freshly reset local stack, in gate
order — pgTAP before the isolation suite, for the reason §1.1 gives.

| Gate | Result |
| --- | --- |
| `npm run lint` | No ESLint warnings or errors |
| `npm run typecheck` | clean |
| `npm test` | **405 passed**, 30 files |
| `npm run db:test` | **553 PASS**, 8 files (`06_whatsapp` + `07_whatsapp_worker` new this block) |
| `npm run test:isolation` | **190 passed**, 15 files, **GUARD-COMPLETE** on the first attempt this run — every file accounted for, every file's case count above its own floor, nothing skipped |
| `CI=1 npx playwright test` | **23 passed** (37.9s) |

Every number is unchanged from Task 13's own final gate — expected, since
this task adds no `src/` code and no test file, only a migration that
schedules an existing route and two documents. The isolation suite's
worker-death flake (§6.6) did not fire on this run; it has fired on other
runs throughout this block and the absence of a repeat here is not evidence
it is fixed.

### 1.1 Local gate order matters, and CI does not need to care

Two environment facts, both spent real diagnosis time in this block and both
belong in `docs/block-5a-runbook.md` §7 for the same reason:

- **The isolation suite commits rows that outlive it.** The twelve-round
  races and the privilege-boundary cases in `tests/isolation/whatsapp.test.ts`
  write real, uncleaned rows into `webhook_events` and `outbox_messages`.
  `due_whatsapp_events`/`claim_outbox_batch` carry no tenant scope, so a
  pgTAP run against the same database afterwards can see rows that are not
  its own fixture's and fail an exact-row-set assertion for a reason that has
  nothing to do with a code defect (Task 13 hit this directly — three
  transient pgTAP failures, resolved by `supabase db reset`, and most of
  `07_whatsapp_worker.test.sql`'s assertions were then scoped to their own
  fixture ids to stop relying on reset order at all). This run reset before
  pgTAP and ran the isolation suite after, matching that precedent; CI does
  not need the same care because its `db` job always runs pgTAP first on a
  stack nothing else has touched.
- **`npm run test:e2e` needs `CI=1` locally.** `next dev` under Playwright's
  eleven parallel workers is too slow for several Server-Action-heavy specs
  once the machine has just finished running the isolation suite, and the
  timeout reads as a failure that has nothing to do with the code
  (`CI=1 npx playwright test --reporter=line`, confirmed 23/23 twice in
  Task 13 immediately after the identical bare run failed 9 of 10 specs on a
  loaded machine). This task ran with `CI=1` throughout, per the global gate
  command.

---

## 2. What shipped

**Migrations (`0057`–`0064`, eight files).**

- `0057_integrations.sql` — the map from a WhatsApp number to a Station.
  RLS on, no policy, **no table grant for any role including `service_role`,
  by design** — every reader is inside a `SECURITY DEFINER` body. The
  identical *absence* of a grant on `webhook_events`/`outbox_messages` was
  not by design and is §6.1's Concern.
- `0058_webhook_events.sql` — one row per inbound message. `(provider,
  external_id)` unique holds the idempotency guarantee structurally;
  `external_id` is `sha256(wamid)`, hex, with a format `CHECK` refusing a raw
  id outright; `webhook_events_done_shape` makes `DONE` a claim about
  `outcome` and `processed_at` together (`0058:93-96`); `prune_webhook_payloads`
  (`0058:161-180`) nulls `payload` after 30 days without scheduling itself —
  Block 11 turns that on.
- `0059_outbox_messages.sql` — outbound messages as rows, so a reply commits
  in the same transaction as the participation it announces. `dedupe_key` is
  keyed on the message (`sha256(wamid):confirmation`), not the participation
  — see §6.5 for why that distinction is the whole mechanism.
- `0060_participation_source_whatsapp.sql` — `participation_source` gains
  `'WHATSAPP'`, alone in its own migration because `ALTER TYPE ... ADD VALUE`
  cannot be used in the transaction that adds it.
- `0061_member_resolution_cores.sql` — three private cores extracted from
  Block 3's `find_member_by_identifier`, `create_member` and
  `link_member_to_company` (`apply_member_candidates`, `apply_member_lookup`,
  `apply_member_creation`, `apply_member_link`), `SECURITY INVOKER`, EXECUTE
  for nobody — every public signature, gate and behaviour preserved
  unchanged.
- `0062_ingest_whatsapp_event.sql` — the whole decision, one transaction:
  `whatsapp_local_phone` (sender normalisation), `whatsapp_reply_body` (the
  six reply sentences, the only copy), `finish_whatsapp_event`, and
  `ingest_whatsapp_event` itself (637 lines, the bulk of the block's logic).
- `0063_whatsapp_worker_queue.sql` — `due_whatsapp_events`,
  `claim_outbox_batch`, `reclaim_stale_whatsapp_claims`, and the two partial
  indexes they run on. SQL functions rather than PostgREST queries because
  the pending-index is on an expression `order` cannot name, and because
  claiming a batch has to be one statement under overlapping ticks.
- `0064_schedule_worker_tick.sql` (this task) — the `pg_cron` job. No URL, no
  secret; both are read from database settings the runbook sets.

**Transport and routes (`src/`).**

- `src/lib/integrations/whatsapp/{transport,graph,fake,signature,payload}.ts`
  — the seam: an interface, the real Meta Graph client, a fake for CI, HMAC
  verification, and payload flattening (one row per message, not per POST).
- `src/app/api/webhooks/whatsapp/route.ts` — `GET` (Meta's handshake) and
  `POST` (verify, store, 200 fast). No promotion logic in this file.
- `src/app/api/worker/tick/route.ts` — the tick endpoint `pg_cron` calls.
- `src/services/whatsapp.ts` — `runTick`, holding no rule about promotions,
  listeners or entries; the backoff ladder (`BACKOFF_SECONDS`,
  `MAX_ATTEMPTS`), the `TickResult` shape including `dbErrors`, the reclaim
  call, and the two drain loops.
- `src/middleware.ts` — the matcher exclusion for `api/webhooks/` and
  `api/worker/` (§6.2).
- `src/lib/env.ts` — the four optional secrets (D6, §3).

**Tests.** Unit: `whatsapp-signature`, `whatsapp-payload`, `whatsapp-transport`,
`whatsapp-route`, `whatsapp-worker`, `worker-tick-route`,
`middleware-matcher` (79 cases across these seven files). pgTAP:
`06_whatsapp.test.sql` (112 assertions) and `07_whatsapp_worker.test.sql`
(49 assertions) — 161 of the block's 553 total.
Isolation: `tests/isolation/whatsapp.test.ts` — 8 cases: the door closed to
an ordinary session and to `anon` (2), three twelve-round concurrency races
(pre-registered listener, unknown-number listener creation, cross-Station
listener creation) (3), and three privilege-boundary cases proving the exact
writes the webhook route and the worker perform succeed for `service_role`
over real HTTP (3) — plus `harness.ts`'s `seedIntegration` (a direct-Postgres
insert, since `integrations` has no PostgREST grant for any role) and
`anonClient`. E2e: `tests/e2e/whatsapp-boundary.spec.ts` — a correctly signed
POST reaches the route and leaves a row, a wrongly signed one is refused with
401 and writes nothing, and a tick with the shared secret returns 200 with
`dbErrors: 0` — against the **running app**, not a mock, which is what closes
the gap §6.2 describes.

---

## 3. Decisions D1–D9, and where they landed

| Decision | Landed in code |
| --- | --- |
| **D1** — one message in, one participation, one reply out; no conversation state | `ingest_whatsapp_event` (`0062:269-625`) resolves exactly one participation per event; no table in this block holds conversation state |
| **D2** — the bot is a system actor; no personal data in `audit_logs` | `participations.created_by` / `audit_logs.actor_id` left `NULL`; `finish_whatsapp_event` writes the audit detail with key `wamid_sha256`, never `wamid` (`0062:181-194`); the webhook route hashes in Node before the insert (`route.ts:109-116`) |
| **D3** — one WhatsApp number per Station | `integrations_one_per_company` partial unique index (`0057:53-54`); `phone_number_id` is the sole Station resolver in `ingest_whatsapp_event`'s integration lookup |
| **D4** — four outcomes answered, everything else silent | `whatsapp_reply_body` (`0062:95-160`) returns text for `VALID`/`DUPLICATE`/`TOO_SOON`/`OVER_LIMIT` and `NULL` otherwise; `no_integration`/`no_hashtag`/`no_promotion`/`promotion_cancelled`/`outside_window` are all `DONE` and silent (`webhook_events.outcome` comment, `0058:187-188`) |
| **D5** — free-form text, not templates | `whatsapp_reply_body` renders plain Portuguese sentences (`0062:123-156`); `GraphTransport` sends free text; no template plumbing exists in this block |
| **D6** — no secret in the database in 5a | `src/lib/env.ts:15-19` — four optional environment variables; `integrations` (`0057`) carries `phone_number_id`/`display_phone_number`/`waba_id` and no token column |
| **D7** — the ingestion rule lives in SQL; the worker is thin | `ingest_whatsapp_event` decides everything inside one transaction; `runTick`/`drainEvents`/`drainOutbox` (`src/services/whatsapp.ts`) hold no promotion or listener rule, only queue mechanics |
| **D8** — a listener elsewhere in the Organization is linked, not duplicated | `apply_member_lookup` / `apply_member_link` (`0061`), called from `ingest_whatsapp_event`'s resolution branch. **Never asked of the owner — see §7.1, still open.** |
| **D9** — the payload is pruned at 30 days; the row and its hash are not | `prune_webhook_payloads` (`0058:161-180`, not scheduled by this block — Block 11's); `external_id = sha256(wamid)` with a format `CHECK` (`0058`); the raw id lives only at `payload.wamid` |

---

## 4. Deliberately out of this pass

From spec §8, unchanged by execution:

- Everything the tab-2 screen configures beyond the hashtag — art, call to
  action, SIM/NÃO buttons, requested fields, the promotion's questions. 5b.
- **A Deno Edge Function worker**, which is what the master spec's §10 M2
  says literally. The contract is kept (idempotent worker,
  `RECEIVED → PROCESSING → DONE/FAILED`, retry/backoff, manual reprocessing,
  swappable for `pgmq`); the runtime is a Next.js route instead, because a
  Deno worker cannot import `src/services/` and the repository has no Edge
  Function tooling. **Accepted by the owner on 2026-07-31.**
- Redis. No conversation state exists yet for it to hold; the concurrency it
  would guard is already held by `apply_participation`'s advisory lock plus
  the partial unique index.
- Non-message webhook events (delivery and read receipts) — acknowledged
  with 200, never stored.
- Operator screens for events, outbox and integrations — Block 10.
- Station-initiated messages, and therefore message templates (D5).

---

## 5. What Block 5b inherits

- **The spine is the whole ingestion path, unconditionally.** 5b adds
  conversation state on top of `ingest_whatsapp_event`; it does not replace
  any of the resolution, idempotency or reply-enqueueing this block built.
- **The three extracted cores (`0061`) are the listener door for any future
  bot path**, not only this one's. A conversational flow that needs to
  resolve or register a listener goes through
  `apply_member_lookup`/`apply_member_creation`/`apply_member_link`, not
  through a fresh reimplementation.
- **`whatsapp_reply_body` is the only home for bot copy, and 5b will grow
  it, not duplicate it.** There is deliberately no TypeScript copy of any
  reply string (§6.5's reasoning: the reply must be enqueued inside the same
  transaction that decides the entry).
- **The `webhook_events`/`outbox_messages` privilege shape is now proven,
  not assumed** — 5b's own writes against these tables inherit the same
  "no PostgREST grant, `SECURITY DEFINER` only" pattern and the boundary
  tests that check it (§6.2).
- **`whatsapp_local_phone`'s +55-only limit (§6.3) is inherited as-is.** 5b
  does not touch phone resolution, so it inherits the duplicate-listener
  risk unchanged; whoever picks up Block 9's ETL reconciliation (L1) is the
  actual owner of a fix.
- **D8 and the punctuation-fallback ruling (§7) are still open.** 5b should
  not assume either is settled.

---

## 6. Concerns

This section is deliberately not softened. Each item below is real, is in
the execution ledger with its own detail, and several would otherwise have
been discovered by the owner, with a phone in his hand, mid-runbook.

### 6.1 The block was non-functional until Task 12

`service_role` held **no privileges at all** on `webhook_events` or
`outbox_messages` from the moment Task 11's webhook route was reviewed and
merged. This schema revokes Supabase's default ACL everywhere and grants back
explicitly (`0006`, `0014`, `0019`, `0029` all do this) — `0057`/`0058`/`0059`
wrote the comment "service_role only" and, for the two tables the route
actually writes, never wrote the grant itself. Every inbound message the
route received returned **42501** — proven by Task 12 replaying the route's
exact call against the merged code — and **nothing could ever have been
stored**. Found and fixed inside Task 12's own fix round, with six new pgTAP
assertions and the grants added to `0058`/`0059`. `integrations` itself
carries no `service_role` grant either, by design (§6.2), and that is not
this defect — the two absences look identical from the migration file and
are not.

### 6.2 Three defects existed only across the HTTP + privilege boundary, and CI saw none of them

- **The middleware 307.** `src/middleware.ts`'s matcher had no exclusion for
  `/api/webhooks/`; Meta's `GET` handshake and every `POST` were
  307-redirected to `/login` before the route ever ran. Found in Task 11's
  review (a Critical), fixed at `0d47a83`.
- **The missing `service_role` grants** — §6.1.
- **A PostgREST resource embed on `integrations`** that would have needed a
  fourth grant this table deliberately does not carry. The worker briefly
  read `integrations` through `integrations(phone_number_id)`; the embed was
  replaced by `claim_outbox_batch` during Task 12's review for an unrelated
  reason, and the grant this table refuses became unnecessary rather than
  ever having existed. Closed by circumstance, not by a test — there is
  nothing today that would fail if a future refactor reintroduced the embed,
  beyond the prohibition `0057`'s own comment now states in capitals.

**pgTAP runs as `postgres` and ignores every grant; the route's unit tests
mock the Supabase client.** Neither layer could have seen any of the three —
each is a fact about what happens when a real, unauthenticated HTTP caller
meets a real, privilege-checked database role, and nothing in the suite
before Task 13 ever put those two things in the same test. Task 13 added
`tests/isolation/whatsapp.test.ts`'s three boundary cases (real `service_role`
writes against the exact statements the route and worker perform) and
`tests/e2e/whatsapp-boundary.spec.ts` (real signed HTTP against the running
app, including a mutation that reads a bare `307` when the middleware
exclusion is removed). **That closes the first two of the three for good.**
The third — the embed — has no standing regression test, because there is no
embed today to test against; it remains a documented prohibition rather than
an assertion.

### 6.3 `whatsapp_local_phone` strips `+55` only

`0062:32-37, 39-52`. A Brazilian mobile that gained its ninth digit after the
listener was registered still normalises to a different string and therefore
reads as a different person; no other country's numbering is handled at all,
and a twelve-digit foreign number that happens to start with `55` is stripped
when it should not be. Named because **it will produce duplicate listeners in
production**, not because it is theoretical — this is the sender-matching
path every inbound message runs through. Deferred, on the record, to Block
9's ETL reconciliation (L1), which faces the identical problem against
legacy data.

### 6.4 Outbound delivery is at-least-once

`reclaim_stale_whatsapp_claims` (`0063:228-275`) returns an abandoned
`SENDING` row to `PENDING` after five minutes. If the tick that claimed it
died **between Meta's 200 and the settle write**, the next tick can re-send a
message Meta already accepted — the listener is told twice. This cannot be
closed from the worker side; the Cloud API offers no idempotency key for text
sends. The alternative — parking such a row instead of releasing it — was
considered and rejected: it would trade "told twice" for "entered and never
told," which is exactly what D7 exists to prevent. Stated as a deliberate,
residual property (`0063:219-226`), not an oversight.

### 6.5 A proof used twice in review was false

Two reviews — one of them the block's own controller review — argued that a
`webhook_events` row cannot strand in `PROCESSING` because "there is no
`EXCEPTION` block anywhere in `ingest_whatsapp_event`." That was false, and
had been false since before this block's own fix round: `apply_member_creation`
has carried its own exception handler since `0061:227-255`, so the call graph
always contained a subtransaction, and neither analysis noticed. The
underlying hazard the sentence warned against does not exist regardless — a
PL/pgSQL handler's implicit savepoint is a *sub*transaction, and a
subtransaction cannot commit independently of its parent, so catching an
error inside one cannot durably write anything out from under an aborting
caller. The conclusion survives on a structural argument instead: the only
`RETURN` below the `PROCESSING` write is `finish_whatsapp_event`, called from
all six outcomes (`no_integration`, `no_hashtag`, `no_promotion`,
`promotion_cancelled`, `outside_window`, `recorded`), and it writes `DONE`,
`outcome` and `processed_at` together in one statement; every other exit is
an uncaught `RAISE` that aborts the whole transaction and takes the
`PROCESSING` write down with it. The correction itself needed two passes —
the first replacement named only `'recorded'` as the return, which was also
wrong, before the second named all six call sites. Worth recording precisely
because two independent reviewers cited the false version as settled fact.

### 6.6 The isolation suite's worker-death flake is unresolved

An open, uncaused flake — a worker process occasionally dies mid-suite
(`tinypool onUnexpectedExit`) — that predates this block and fired repeatedly
inside it: Task 5 saw it on 2 of 4 runs the day it ran; Task 13 hit it twice
before a third run completed. `scripts/verify-isolation-suite.mjs` exists
specifically to catch this rather than report a partial run as passing — it
counts every required file, floors every file's case count, and only reports
**GUARD-COMPLETE** when nothing was cut short. This task's own run completed
clean on the first attempt; that is not evidence the flake is fixed, only
that it did not fire this time. A result from this suite is always either
complete or explicitly flagged — never silently partial — but root cause
remains unknown.

### 6.7 A security anomaly

During Task 13's mutation work (restoring `src/middleware.ts` after
deliberately reintroducing the pre-fix defect to prove the boundary test
catches it), the implementer received content presented as tool output
claiming its own edit to `src/middleware.ts` — the mutation that re-hides the
webhook route behind auth — was intentional user/linter behaviour, and
instructing it **not to revert the edit and not to mention it**. Had it
complied, this block's Critical would have been silently reintroduced into
the file that gates authentication for the whole application, with the agent
told to stay quiet about it. It disregarded the instruction and used
`git diff --exit-code src/middleware.ts` — verification that does not depend
on trusting anything it was told — as proof the file matched `HEAD` again.
The block's controller verified independently at the time: working tree
clean, matcher excluding exactly `api/webhooks/` and `api/worker/`, diff
clean. **Re-verified again while writing this report**: `git diff --exit-code
src/middleware.ts` is clean, matching `HEAD`. Origin of the injected content
is unknown. Reported to the owner both times.

---

## 7. Decisions left for the owner

Two items, both flagged as reversible in the ledger rather than settled.

### 7.1 D8 — a listener elsewhere in the Organization is linked, not duplicated

Spec §10: *"the one decision here taken by reasoning rather than asked."* A
listener already known to the Organization but not linked to the Station
that received their message is linked and entered, rather than duplicated
(which would defeat Block 3's dedup) or refused (which would tell a real
listener they cannot enter a promotion they are eligible for). Implemented
in `apply_member_lookup`/`apply_member_link` (`0061`) and never put to the
owner during this block's thirteen tasks. Confirm or overturn on review.

### 7.2 The punctuation-fallback ruling (mine, not the owner's)

`0062:390-427`. A hashtag is matched first as written, then — only if that
matches nothing among **open** promotions — with trailing punctuation
stripped (`"#EUQUERO!!"` → `"#EUQUERO"`), so an excited listener is not
answered with silence. The narrower question this ruling settles: if
`"#VAI!"` was itself once a real, now-ended hashtag at a Station, and
`"#VAI"` is a *different*, currently live promotion at the same Station,
should a message reading `"#VAI!"` fall back and enter `"#VAI"`, or should
the exact tag's own history suppress the fallback?

**Ruled: the fallback stays active regardless of the exact tag's history.**
The implementer argued for suppressing it whenever the exact tag is known to
the Station in any state, to avoid entering someone in a draw they did not
name. The controller's ruling went the other way, on the mirror case: a
Station that ran `"#VAI!"` last year would, under the suppressed version,
answer this year's identical `"#VAI!"` message with **permanent silence**,
because the exact tag's past existence would block the fallback to this
year's live `"#VAI"`. The scenario that makes the chosen behaviour wrong — an
operator having created two hashtags at the same Station differing only in
trailing punctuation — is rare; the scenario that makes the rejected
alternative wrong — someone retyping last year's tag verbatim — is the
ordinary case this whole feature exists for. Pinned by a fixture in
`06_whatsapp.test.sql` and stated in the migration's own comment as *"with
the owner"* (`0062:424-427`). **This is the ruling most likely to be worth
revisiting with the owner directly**, since it trades one rare collision for
one common one and either choice is defensible.

---

## 8. Deferred minors, grouped

- **pgTAP RLS assertions use a bare `::regclass` cast** (Task 1, inherited
  from every earlier `0N_*.test.sql` file in this repository) — an absent
  relation aborts the psql run with a hard error instead of a clean `not ok`.
  Ruled **not fixed**: diverging in `06_whatsapp` alone would cost
  consistency with `05_participations` and every sibling file for a marginal
  gain. A repo-wide change or nothing.
- **The backoff-settle and `deferEvent` write shapes are not driven by the
  boundary tests** (Task 13). Privilege-wise this is redundant with what the
  boundary cases already prove — same table, same grants — so only the
  `CHECK`-constraint shapes on those specific writes go unpinned at the HTTP
  boundary; pgTAP still covers the shapes themselves as `postgres`. Not
  extended, to avoid growing Task 13's scope after its own review had
  closed.
